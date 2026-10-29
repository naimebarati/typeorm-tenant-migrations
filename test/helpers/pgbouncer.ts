import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Path of a real pgbouncer binary, if the machine has one (TTM_PGBOUNCER_BIN overrides the PATH lookup). */
export function findPgBouncer(): string | undefined {
  if (process.env.TTM_PGBOUNCER_BIN) return process.env.TTM_PGBOUNCER_BIN;
  for (const candidate of ['/usr/sbin/pgbouncer', '/usr/bin/pgbouncer', '/usr/local/bin/pgbouncer']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

export function pgBouncerVersion(bin: string): string {
  return execFileSync(bin, ['--version'], { encoding: 'utf8' }).split('\n')[0]!.trim();
}

export interface PgBouncer {
  port: number;
  stop(): Promise<void>;
}

export interface PgBouncerOptions {
  poolMode: 'session' | 'transaction';
  /** Extra lines for the [pgbouncer] section, e.g. "ignore_startup_parameters = options". */
  extra?: string[];
  poolSize?: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pgbouncer exited early with code ${child.exitCode}`);
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('pgbouncer did not start listening');
}

/** Starts a real PgBouncer in front of `target` and returns once it accepts connections. */
export async function startPgBouncer(
  bin: string,
  target: { host: string; port: number; user: string; password: string },
  options: PgBouncerOptions,
): Promise<PgBouncer> {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'ttm-pgbouncer-'));
  const runAs = process.getuid?.() === 0 ? 'postgres' : undefined; // pgbouncer refuses to run as root
  chmodSync(dir, 0o755);
  if (runAs) chownSync(dir, Number(execFileSync('id', ['-u', runAs], { encoding: 'utf8' })), -1);

  writeFileSync(path.join(dir, 'userlist.txt'), `"${target.user}" "${target.password}"\n`, { mode: 0o644 });
  writeFileSync(
    path.join(dir, 'pgbouncer.ini'),
    [
      '[databases]',
      `* = host=${target.host} port=${target.port}`,
      '[pgbouncer]',
      'listen_addr = 127.0.0.1',
      `listen_port = ${port}`,
      'unix_socket_dir =',
      'auth_type = plain',
      `auth_file = ${path.join(dir, 'userlist.txt')}`,
      `pool_mode = ${options.poolMode}`,
      `default_pool_size = ${options.poolSize ?? 5}`,
      'max_client_conn = 100',
      'logfile =',
      ...(options.extra ?? []),
      '',
    ].join('\n'),
    { mode: 0o644 },
  );

  const child = spawn(bin, [...(runAs ? ['-u', runAs] : []), path.join(dir, 'pgbouncer.ini')], { stdio: 'ignore' });
  try {
    await waitForPort(port, child);
  } catch (error) {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
