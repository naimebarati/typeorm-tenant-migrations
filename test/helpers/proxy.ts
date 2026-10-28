import net from 'node:net';

export interface PgProxy {
  port: number;
  /** Drops every connection and refuses new ones: a database outage. */
  cut(): void;
  close(): Promise<void>;
}

/**
 * A byte-level TCP proxy in front of PostgreSQL. It can drop the `options` startup parameter,
 * which is exactly what a connection pooler that doesn't support startup options does to
 * `-c search_path=...`: the client believes the parameter was applied and the server never saw it.
 */
export async function startPgProxy(target: { host: string; port: number }, opts: { stripOptions: boolean }): Promise<PgProxy> {
  const sockets = new Set<net.Socket>();
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
      upstream.write(opts.stripOptions ? stripOptionsParam(buffered) : buffered);
      buffered = Buffer.alloc(0);
    });
    upstream.on('data', (chunk: Buffer) => client.write(chunk));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
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

function stripOptionsParam(packet: Buffer): Buffer {
  const length = packet.readInt32BE(0);
  const protocol = packet.readInt32BE(4);
  if (protocol !== 196608) return packet; // not a v3 StartupMessage (e.g. SSLRequest): leave untouched
  const parts = packet.subarray(8, length - 1).toString('utf8').split('\0');
  const kept: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'options') continue;
    kept.push(parts[i]!, parts[i + 1]!);
  }
  const body = Buffer.from(kept.join('\0') + '\0\0', 'utf8');
  const out = Buffer.alloc(8 + body.length);
  out.writeInt32BE(out.length, 0);
  out.writeInt32BE(protocol, 4);
  body.copy(out, 8);
  return out;
}
