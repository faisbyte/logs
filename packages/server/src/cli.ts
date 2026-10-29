import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { normalizeRemoteUrl, type SummaryStore, type TokenStore } from '@digest/core';
import pg from 'pg';
import { createHandler } from './http.js';
import { migrate, PostgresSummaryStore } from './postgres-store.js';

// digest-server: `serve` runs the API; `token` issues a developer's token for a repo (DECISIONS.md D43).
// Storage is Postgres from DATABASE_URL, or a local PGlite directory (--data) for running on one machine.

export interface ServerIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

const USAGE = `usage: digest-server serve [--port 8787] [--data <dir>]
       digest-server token --repo <repo URL or host/path> --developer <id> --name <display name> [--data <dir>]
Storage: DATABASE_URL (Postgres), or --data <dir> for a local PGlite database (one process at a time).`;

export async function openStore({ databaseUrl, dataDir }: { databaseUrl?: string; dataDir?: string }): Promise<{ store: SummaryStore & TokenStore; close: () => Promise<void> }> {
  if (databaseUrl) {
    // Migrations need one connection; the pool serves requests.
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await migrate(client).finally(() => client.end());
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return { store: new PostgresSummaryStore(pool), close: () => pool.end() };
  }
  if (!dataDir) throw new Error('set DATABASE_URL or pass --data <dir> for a local database.');
  const db = new PGlite(dataDir);
  await migrate(db);
  return { store: new PostgresSummaryStore(db), close: () => db.close() };
}

export async function startServer({ store, port, host = '127.0.0.1', log }: { store: SummaryStore & TokenStore; port: number; host?: string; log?: (line: string) => void }) {
  const server = createServer(createHandler(store, log ? { log } : {}));
  await new Promise<void>((listening) => server.listen(port, host, listening));
  const address = server.address() as AddressInfo;
  return { url: `http://${host}:${address.port}`, close: () => new Promise<void>((closed) => server.close(() => closed())) };
}

function repoIdFrom(value: string): string | null {
  return normalizeRemoteUrl(value) ?? (/^[a-z0-9.-]+\.[a-z]{2,}(\/[\w.-]+)+$/i.test(value) ? value.toLowerCase() : null);
}

export async function serverCli(argv: string[], io: ServerIo): Promise<number> {
  const fail = (message: string) => (io.stderr(`digest-server: ${message}\n`), 1);
  const [command, ...rest] = argv;
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({ args: rest, options: { data: { type: 'string' }, port: { type: 'string' }, repo: { type: 'string' }, developer: { type: 'string' }, name: { type: 'string' } } }) as { values: Record<string, string | undefined> });
  } catch (err) {
    return fail(`${(err as Error).message}\n${USAGE}`);
  }
  if (command !== 'serve' && command !== 'token') return fail(USAGE);
  const storage = { databaseUrl: io.env.DATABASE_URL, dataDir: values.data };
  if (!storage.databaseUrl && !storage.dataDir) return fail('set DATABASE_URL or pass --data <dir> for a local database.');

  if (command === 'token') {
    if (!values.repo) return fail('--repo is required.');
    const repoId = repoIdFrom(values.repo);
    if (!repoId) return fail('--repo must be a repo URL or host/path id, e.g. git@github.com:acme/webapp.git or github.com/acme/webapp.');
    if (!values.developer || !values.name) return fail('--developer and --name are required.');
    const { store, close } = await openStore(storage);
    try {
      const { token } = await store.issueToken({ repoId, developerId: values.developer, developerName: values.name });
      io.stdout(`Token for ${values.name} (${values.developer}) on ${repoId}. It is shown only this once:\n${token}\nIssuing another token for this developer and repo revokes this one.\n`);
    } finally {
      await close();
    }
    return 0;
  }

  const port = Number(values.port ?? io.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0) return fail('--port must be a port number.');
  const { store, close } = await openStore(storage);
  const server = await startServer({ store, port, host: io.env.HOST ?? '127.0.0.1', log: (line) => io.stdout(`${line}\n`) });
  io.stdout(`digest-server listening on ${server.url}\n`);
  await new Promise<void>((stop) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop());
  });
  await server.close();
  await close();
  return 0;
}
