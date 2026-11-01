import net from 'node:net';

export interface PgProxy {
  port: number;
  /**
   * The next connection whose startup message carries `options` arrives without it. That is what PgBouncer 1.26.1 does
   * in session pooling in front of PostgreSQL < 18 to a second client that reuses a server connection: the first client
   * gets its startup options, a later one silently does not.
   */
  stripNextOptionsConnection(): void;
  /** Drops every connection and refuses new ones: a database outage. */
  cut(): void;
  close(): Promise<void>;
}

/**
 * A byte-level TCP proxy in front of PostgreSQL. It can drop the `options` startup parameter,
 * which is exactly what a connection pooler that doesn't support startup options does to
 * `-c search_path=...`: the client believes the parameter was applied and the server never saw it.
 */
export interface PgProxyOptions {
  stripOptions?: boolean;
  stripReadOnly?: boolean;
}

export async function startPgProxy(target: { host: string; port: number }, opts: PgProxyOptions): Promise<PgProxy> {
  const sockets = new Set<net.Socket>();
  let stripNext = 0;
  let cut = false;

  const server = net.createServer((client) => {
    if (cut) return void client.destroy();
    sockets.add(client);
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    const forget = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', forget).on('close', forget);
    upstream.on('error', forget).on('close', forget);

    let buffered = Buffer.alloc(0);
    let started = false;
    client.on('data', (chunk: Buffer) => {
      if (started) return void upstream.write(chunk);
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return;
      started = true;
      const strip = opts.stripOptions || (stripNext > 0 && hasOptionsParam(buffered));
      if (strip && !opts.stripOptions) stripNext -= 1;
      upstream.write(rewriteStartup(buffered, { ...opts, stripOptions: strip }));
      buffered = Buffer.alloc(0);
    });
    upstream.on('data', (chunk: Buffer) => client.write(chunk));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    stripNextOptionsConnection() {
      stripNext += 1;
    },
    cut() {
      cut = true;
      for (const s of sockets) s.destroy();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function rewriteStartup(packet: Buffer, opts: PgProxyOptions): Buffer {
  if (!opts.stripOptions && !opts.stripReadOnly) return packet;
  return rewriteOptionsParam(packet, (value) => (opts.stripOptions ? undefined : value.replace(/\s*-c default_transaction_read_only=on/, '').trim()));
}

/** `rewrite` receives the current `options` value and returns the new one, or undefined to drop the parameter. */
function rewriteOptionsParam(packet: Buffer, rewrite: (value: string) => string | undefined): Buffer {
  const length = packet.readInt32BE(0);
  const protocol = packet.readInt32BE(4);
  if (protocol !== 196608) return packet; // not a v3 StartupMessage (e.g. SSLRequest): leave untouched
  const parts = packet.subarray(8, length - 1).toString('utf8').split('\0');
  const kept: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'options') {
      const next = rewrite(parts[i + 1]!);
      if (next) kept.push('options', next);
      continue;
    }
    kept.push(parts[i]!, parts[i + 1]!);
  }
  const body = Buffer.from(kept.join('\0') + '\0\0', 'utf8');
  const out = Buffer.alloc(8 + body.length);
  out.writeInt32BE(out.length, 0);
  out.writeInt32BE(protocol, 4);
  body.copy(out, 8);
  return out;
}

function hasOptionsParam(packet: Buffer): boolean {
  if (packet.length < 8 || packet.readInt32BE(4) !== 196608) return false;
  const parts = packet.subarray(8, packet.readInt32BE(0) - 1).toString('utf8').split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] === 'options') return true;
  return false;
}
