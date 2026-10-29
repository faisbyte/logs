import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { normalizeRemoteUrl, type SharedStore } from '@digest/core';
import pg from 'pg';
import { createHandler } from './http.js';
import { openPGlite } from './pglite.js';
import { migrate, PostgresSummaryStore } from './postgres-store.js';

// digest-server: `serve` runs the API; `token` issues a developer's token for a repo (DECISIONS.md D43);
// `sprint` keeps a repo's named date ranges (D45).
// Storage is Postgres from DATABASE_URL, or a local PGlite directory (--data) for running on one machine.

export interface ServerIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

const USAGE = `usage: digest-server serve [--port 8787] [--data <dir>]
       digest-server token --repo <repo URL or host/path> (--developer <id> | --reader <id>) --name <display name> [--data <dir>]
       digest-server sprint --repo <repo> [--name <name> --from <date> --to <date> | --remove --name <name>] [--data <dir>]
Storage: DATABASE_URL (Postgres), or --data <dir> for a local PGlite database (one process at a time).`;

export async function openStore({ databaseUrl, dataDir }: { databaseUrl?: string; dataDir?: string }): Promise<{ store: SharedStore; close: () => Promise<void> }> {
  if (databaseUrl) {
    // Migrations need one connection; the pool serves requests.
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await migrate(client).finally(() => client.end());
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return { store: new PostgresSummaryStore(pool), close: () => pool.end() };
  }
  if (!dataDir) throw new Error('set DATABASE_URL or pass --data <dir> for a local database.');
  const db = openPGlite(dataDir);
  await migrate(db);
  return { store: new PostgresSummaryStore(db), close: () => db.close() };
}

export async function startServer({ store, port, host = '127.0.0.1', log }: { store: SharedStore; port: number; host?: string; log?: (line: string) => void }) {
  const server = createServer(createHandler(store, log ? { log } : {}));
  await new Promise<void>((listening) => server.listen(port, host, listening));
  const address = server.address() as AddressInfo;
  return { url: `http://${host}:${address.port}`, close: () => new Promise<void>((closed) => server.close(() => closed())) };
}

function repoIdFrom(value: string): string | null {
  return normalizeRemoteUrl(value) ?? (/^[a-z0-9.-]+\.[a-z]{2,}(\/[\w.-]+)+$/i.test(value) ? value.toLowerCase() : null);
}

interface Args {
  data?: string;
  port?: string;
  repo?: string;
  developer?: string;
  reader?: string;
  name?: string;
  from?: string;
  to?: string;
  remove?: boolean;
}

/** A date (midnight UTC) or a full ISO date-time. */
function sprintDate(value: string): string | null {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  return /^\d{4}-\d{2}-\d{2}T/.test(date) && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
}
const showDate = (iso: string) => (iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso);

async function sprintCommand(store: SharedStore, repoId: string, values: Args, io: ServerIo): Promise<number> {
  const fail = (message: string) => (io.stderr(`digest-server: ${message}\n`), 1);
  const name = values.name;
  if (values.remove) {
    if (!name) return fail('--remove needs --name.');
    if (!(await store.removeSprint(repoId, name))) return fail(`no sprint named ${name} on ${repoId}.`);
    io.stdout(`Removed ${name} from ${repoId}.\n`);
    return 0;
  }
  if (!name && !values.from && !values.to) {
    const sprints = await store.sprints(repoId);
    io.stdout(sprints.length ? `Sprints on ${repoId}:\n${sprints.map((s) => `  ${s.name}  ${showDate(s.from)} up to ${showDate(s.to)}\n`).join('')}` : `No sprints on ${repoId}.\n`);
    return 0;
  }
  if (!name || !values.from || !values.to) return fail('--name, --from and --to are needed to save a sprint.');
  const [from, to] = [sprintDate(values.from), sprintDate(values.to)];
  if (!from || !to) return fail('--from and --to must be dates such as 2026-03-02, or ISO date-times; --to is not included.');
  const result = await store.saveSprint(repoId, { name, from, to });
  if (result.status !== 'saved') return fail(result.reason);
  io.stdout(`Saved ${name} on ${repoId}: ${showDate(from)} up to ${showDate(to)} (not included).\n`);
  return 0;
}

export async function serverCli(argv: string[], io: ServerIo): Promise<number> {
  const fail = (message: string) => (io.stderr(`digest-server: ${message}\n`), 1);
  const [command, ...rest] = argv;
  let values: Args;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        data: { type: 'string' },
        port: { type: 'string' },
        repo: { type: 'string' },
        developer: { type: 'string' },
        reader: { type: 'string' },
        name: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        remove: { type: 'boolean' },
      },
    }));
  } catch (err) {
    return fail(`${(err as Error).message}\n${USAGE}`);
  }
  if (command !== 'serve' && command !== 'token' && command !== 'sprint') return fail(USAGE);
  const storage = { databaseUrl: io.env.DATABASE_URL, dataDir: values.data };
  if (!storage.databaseUrl && !storage.dataDir) return fail('set DATABASE_URL or pass --data <dir> for a local database.');

  if (command === 'token' || command === 'sprint') {
    if (!values.repo) return fail('--repo is required.');
    const repoId = repoIdFrom(values.repo);
    if (!repoId) return fail('--repo must be a repo URL or host/path id, e.g. git@github.com:acme/webapp.git or github.com/acme/webapp.');
    if (command === 'sprint') {
      const { store, close } = await openStore(storage);
      try {
        return await sprintCommand(store, repoId, values, io);
      } finally {
        await close();
      }
    }
    const person = values.developer ?? values.reader;
    if (!person || !values.name || (values.developer && values.reader)) return fail('--developer (or --reader) and --name are required.');
    const { store, close } = await openStore(storage);
    try {
      if (values.reader) {
        const { token } = await store.issueToken({ repoId, developerId: values.reader, developerName: values.name }, 'reader');
        io.stdout(`Read-only token for ${values.name} (${values.reader}) on ${repoId}: digests and reports only. It is shown only this once:\n${token}\nIssuing another reader token for this person and repo revokes this one.\n`);
      } else {
        const { token } = await store.issueToken({ repoId, developerId: person, developerName: values.name });
        io.stdout(`Token for ${values.name} (${person}) on ${repoId}. It is shown only this once:\n${token}\nIssuing another token for this developer and repo revokes this one.\n`);
      }
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
