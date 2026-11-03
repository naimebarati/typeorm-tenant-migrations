import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { TenantMigrationOptions, TenantSelection } from '../config/types.js';
import { TenantMigrationError, isTenantMigrationError } from '../errors/index.js';
import { createRedactor } from '../errors/sanitize.js';
import { createConsoleLogger } from '../logger/console-logger.js';
import { isCleanReport } from '../runner/report.js';
import { TenantMigrationRunner } from '../runner/tenant-migration-runner.js';
import { formatPlan, formatRevert, formatRun, formatStatus } from './format.js';
import { loadConfig } from './load-config.js';

export const EXIT = {
  OK: 0,
  /** At least one tenant failed, or was not started because another failed. */
  TENANT_FAILED: 1,
  /** Usage, configuration or tenant-selection error; nothing was executed. */
  USAGE: 2,
  /** Some tenant could not get its lock in time (and nothing failed otherwise). */
  LOCKED: 3,
  /** `run` was stopped by SIGINT/SIGTERM; tenants that had not started were left untouched. */
  INTERRUPTED: 130,
  /** Unexpected internal error. */
  INTERNAL: 70,
} as const;

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  cwd: string;
}

const HELP = `typeorm-tenant-migrations — run TypeORM migrations on PostgreSQL schema-per-tenant databases

Usage:
  typeorm-tenant-migrations <plan|status|run> --config <file> (--all | --tenant <id> [--tenant <id>...]) [options]
  typeorm-tenant-migrations revert --config <file> --tenant <id> --migration <name> [options]

Commands:
  plan     List the migrations each tenant would run. Read-only.
  status   Show executed and pending migrations per tenant. Read-only.
  run      Run pending migrations.
  revert   Revert the last executed migration of ONE tenant (--tenant and --migration are both required).

Options:
  --config <file>        Config module (.js/.cjs/.mjs, or .ts with tsx installed). Required.
  --all                  Select every tenant from the config's tenant provider.
  --tenant <id>          Select a tenant by logical id (repeatable; revert takes exactly one). Exactly one of --all / --tenant is required.
  --migration <name>     revert: the migration to revert; it has to be the last executed one of that tenant, otherwise nothing runs.
  --json                 Print the report as JSON on stdout (logs go to stderr).
  --concurrency <n>      run/plan/status: tenants processed in parallel (default 1).
  --continue-on-error    run: keep going after a tenant fails (default: stop scheduling new tenants).
  --transaction <mode>   run/revert: all | each | none (default each).
  --lock-timeout <ms>    run/revert: how long to wait for a tenant's lock (default 30000).
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes: 0 ok · 1 a tenant failed / not started · 2 usage or configuration error · 3 lock timeout · 70 internal error · 130 interrupted
SIGINT/SIGTERM during "run" or "revert": finish the tenants already running, start no new ones, print the report. A second signal aborts immediately.
`;

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function usageError(message: string): never {
  throw new TenantMigrationError('INVALID_CONFIGURATION', message);
}

/**
 * First SIGINT/SIGTERM: ask the runner to stop gracefully. Second: give up and let the default
 * action terminate the process; PostgreSQL rolls back whatever transaction was open.
 */
function listenForInterrupt(controller: AbortController, io: CliIo): () => void {
  let received = 0;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const stop = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      received++;
      if (received === 1) {
        io.stderr.write(
          `Received ${signal}: finishing the tenants already running and starting no new ones. Send it again to abort immediately.\n`,
        );
        controller.abort();
      } else {
        stop();
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return stop;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let json = argv.includes('--json');
  const redact = createRedactor([]);
  const fail = (code: number, errorCode: string, message: string) => {
    const safe = redact(message);
    if (json) io.stdout.write(`${JSON.stringify({ error: { code: errorCode, message: safe } }, null, 2)}\n`);
    else io.stderr.write(`error [${errorCode}]: ${safe}\n`);
    return code;
  };

  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        all: { type: 'boolean' },
        tenant: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        concurrency: { type: 'string' },
        'continue-on-error': { type: 'boolean' },
        transaction: { type: 'string' },
        'lock-timeout': { type: 'string' },
        migration: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    json = values.json === true;

    if (values.help) return void io.stdout.write(HELP), EXIT.OK;
    if (values.version) return void io.stdout.write(`${packageVersion()}\n`), EXIT.OK;

    const [command, ...extra] = positionals;
    if (command !== 'plan' && command !== 'status' && command !== 'run' && command !== 'revert') {
      usageError(`Expected a command: plan, status, run or revert.${command ? ` Got "${command}".` : ''} See --help.`);
    }
    if (extra.length > 0) usageError(`Unexpected argument "${extra[0]}".`);
    if (command !== 'run' && command !== 'revert') {
      for (const flag of ['transaction', 'lock-timeout'] as const) {
        if (values[flag] !== undefined) usageError(`--${flag} only applies to "run" and "revert".`);
      }
    }
    if (command !== 'run' && values['continue-on-error'] !== undefined) usageError('--continue-on-error only applies to "run".');
    if (command !== 'revert' && values.migration !== undefined) usageError('--migration only applies to "revert".');
    if (command === 'revert' && values.concurrency !== undefined) usageError('--concurrency does not apply to "revert": it always works on one tenant.');

    const hasAll = values.all === true;
    const tenantIds = values.tenant ?? [];
    if (command === 'revert') {
      if (hasAll) usageError('"revert" works on exactly one tenant: --all is not accepted.');
      if (tenantIds.length !== 1) usageError('"revert" needs exactly one --tenant <id>.');
      if (values.migration === undefined || values.migration === '') usageError('"revert" needs --migration <name>: the name of the last executed migration of that tenant.');
    } else if (hasAll === tenantIds.length > 0) {
      usageError('Select tenants explicitly: pass exactly one of --all or --tenant <id>.');
    }
    const target: TenantSelection = hasAll ? { all: true } : { tenants: tenantIds };

    if (!values.config) usageError('--config <file> is required.');
    const config = await loadConfig(values.config, io.cwd);

    // CLI flags override the file's options; the logger writes to stderr so stdout stays machine-readable.
    const overrides: TenantMigrationOptions = {};
    if (values.concurrency !== undefined) overrides.concurrency = Number(values.concurrency);
    if (values['continue-on-error']) overrides.continueOnError = true;
    if (values.transaction !== undefined) overrides.transaction = values.transaction as TenantMigrationOptions['transaction'];
    if (values['lock-timeout'] !== undefined) overrides.lockTimeoutMs = Number(values['lock-timeout']);
    const runner = new TenantMigrationRunner({
      ...config,
      options: { logger: createConsoleLogger({ stream: io.stderr }), ...config.options, ...overrides },
    });

    if (command === 'plan') {
      const report = await runner.plan({ target });
      io.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatPlan(report)}\n`);
      return report.summary.failed > 0 ? EXIT.TENANT_FAILED : EXIT.OK;
    }
    if (command === 'status') {
      const report = await runner.status({ target });
      io.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatStatus(report)}\n`);
      return report.summary.failed > 0 ? EXIT.TENANT_FAILED : EXIT.OK;
    }

    const controller = new AbortController();
    const stopListening = listenForInterrupt(controller, io);
    if (command === 'revert') {
      let reverted;
      try {
        reverted = await runner.revert({ tenant: tenantIds[0]!, migration: values.migration!, signal: controller.signal });
      } finally {
        stopListening();
      }
      io.stdout.write(`${json ? JSON.stringify(reverted, null, 2) : formatRevert(reverted)}\n`);
      if (reverted.interrupted) return EXIT.INTERRUPTED;
      if (isCleanReport(reverted)) return EXIT.OK;
      return reverted.summary.failed > 0 || reverted.summary.locked === 0 ? EXIT.TENANT_FAILED : EXIT.LOCKED;
    }
    let report;
    try {
      report = await runner.run({ target, signal: controller.signal });
    } finally {
      stopListening();
    }
    io.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatRun(report)}\n`);
    if (report.interrupted) return EXIT.INTERRUPTED;
    if (isCleanReport(report)) return EXIT.OK;
    return report.summary.failed > 0 || report.summary.locked === 0 ? EXIT.TENANT_FAILED : EXIT.LOCKED;
  } catch (error) {
    if (isTenantMigrationError(error)) return fail(EXIT.USAGE, error.code, error.message);
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      return fail(EXIT.USAGE, 'INVALID_CONFIGURATION', (error as Error).message);
    }
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    return fail(EXIT.INTERNAL, 'INTERNAL_ERROR', `Unexpected internal error${detail}`);
  }
}
