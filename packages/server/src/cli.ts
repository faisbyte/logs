import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { AnthropicLlmClient, normalizeRemoteUrl, type DigestDeps, type Effort, type RepoSettings, type SharedStore } from '@digest/core';
import { deliveriesFor } from './delivery.js';
import pg from 'pg';
import { createHandler, type HandlerOptions } from './http.js';
import { openPGlite } from './pglite.js';
import { migrate, PostgresSummaryStore } from './postgres-store.js';
import { sendDue } from './schedule.js';

// sprintdigest-server: `serve` runs the API; `token` issues a developer's token for a repo (DECISIONS.md D43);
// `sprint` keeps a repo's named date ranges (D45).
// Storage is Postgres from DATABASE_URL, or a local PGlite directory (--data) for running on one machine.

export interface ServerIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** For Slack deliveries; tests pass a fake. */
  fetch?: typeof fetch;
}

const USAGE = `usage: sprintdigest-server serve [--port 8787] [--data <dir>]
       sprintdigest-server token --repo <repo URL or host/path> (--developer <id> | --reader <id>) --name <display name> [--data <dir>]
       sprintdigest-server sprint --repo <repo> [--name <name> --from <date> --to <date> | --remove --name <name>] [--data <dir>]
       sprintdigest-server repo --repo <repo> [--schedule off|weekly|sprint-end] [--weekday mon] [--since <date>] [--preview-hours <n>]
                          [--email <a@x,b@y>|none] [--slack-env <ENV_NAME>|none] [--cap-usd <n>|default] [--data <dir>]
       sprintdigest-server digest send-due [--data <dir>]
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

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * How the server writes digests (DECISIONS.md D48, D53): Sonnet 5.5 at medium effort by default, with the key
 * from ANTHROPIC_API_KEY (never stored or printed) and a default monthly cap per repo of $10.
 */
export function digestDepsFromEnv(env: Record<string, string | undefined>): Omit<DigestDeps, 'store'> {
  const model = env.DIGEST_MODEL || 'claude-sonnet-5-5';
  const effort = (env.DIGEST_EFFORT || 'medium') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`DIGEST_EFFORT must be one of ${EFFORTS.join(', ')}.`);
  const defaultCapUsd = env.DIGEST_MONTHLY_CAP_USD === undefined ? 10 : Number(env.DIGEST_MONTHLY_CAP_USD);
  if (!Number.isFinite(defaultCapUsd) || defaultCapUsd < 0) throw new Error('DIGEST_MONTHLY_CAP_USD must be a number of dollars, e.g. 10.');
  return { llm: env.ANTHROPIC_API_KEY ? AnthropicLlmClient.fromEnv(env, model, effort) : null, model, defaultCapUsd };
}

export async function startServer({
  store,
  port,
  host = '127.0.0.1',
  log,
  digests,
}: { store: SharedStore; port: number; host?: string; log?: (line: string) => void; digests?: HandlerOptions['digests'] }) {
  const server = createServer(createHandler(store, { ...(log ? { log } : {}), ...(digests ? { digests } : {}) }));
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
  schedule?: string;
  weekday?: string;
  since?: string;
  'preview-hours'?: string;
  email?: string;
  'slack-env'?: string;
  'cap-usd'?: string;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const title = (day: string) => day[0]!.toUpperCase() + day.slice(1);

function showSettings(s: RepoSettings): string {
  const schedule =
    s.schedule === 'off'
      ? 'off'
      : `${s.schedule === 'weekly' ? `weekly on ${title(WEEKDAYS[s.weekday - 1]!)}` : 'at the end of each sprint'}${s.scheduleSince ? `, for periods ending after ${showDate(s.scheduleSince)}` : ''}`;
  return [
    `Digest settings for ${s.repoId}:`,
    `  schedule: ${schedule}`,
    `  developer preview: ${s.previewHours ? `${s.previewHours} hours before sending` : 'off'}`,
    `  email: ${s.emailTo.join(', ') || 'none'}`,
    `  slack: ${s.slackWebhookEnv ? `the webhook URL in ${s.slackWebhookEnv}` : 'none'}`,
    `  monthly LLM cost cap: ${s.monthlyCapUsd === null ? 'the server default' : `$${s.monthlyCapUsd.toFixed(2)}`}`,
    '',
  ].join('\n');
}

/** Parses the repo command's flags into a settings patch, or the first problem. */
function settingsPatch(values: Args, now: Date): { patch: Partial<Omit<RepoSettings, 'repoId'>> } | { error: string } {
  const patch: Partial<Omit<RepoSettings, 'repoId'>> = {};
  if (values.schedule !== undefined) {
    if (!['off', 'weekly', 'sprint-end'].includes(values.schedule)) return { error: '--schedule must be off, weekly or sprint-end.' };
    patch.schedule = values.schedule as RepoSettings['schedule'];
    patch.scheduleSince = patch.schedule === 'off' ? null : now.toISOString();
  }
  if (values.since !== undefined) {
    const since = sprintDate(values.since);
    if (!since) return { error: '--since must be a date such as 2026-03-01, or an ISO date-time.' };
    patch.scheduleSince = since;
  }
  if (values.weekday !== undefined) {
    const n = /^[1-7]$/.test(values.weekday) ? Number(values.weekday) : WEEKDAYS.findIndex((d) => values.weekday!.length >= 3 && d.startsWith(values.weekday!.toLowerCase())) + 1;
    if (!n) return { error: '--weekday must be a day such as mon, or 1 to 7 (1 is Monday).' };
    patch.weekday = n;
  }
  if (values['preview-hours'] !== undefined) {
    const h = Number(values['preview-hours']);
    if (!/^\d+$/.test(values['preview-hours']) || h > 168) return { error: '--preview-hours must be a whole number from 0 to 168.' };
    patch.previewHours = h;
  }
  if (values.email !== undefined) {
    const list = values.email === 'none' ? [] : values.email.split(',').map((a) => a.trim());
    if (list.some((a) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(a))) return { error: '--email must be addresses separated by commas, or none.' };
    patch.emailTo = list;
  }
  if (values['slack-env'] !== undefined) {
    const name = values['slack-env'];
    if (name !== 'none' && !/^[A-Z_][A-Z0-9_]*$/.test(name)) return { error: '--slack-env is the name of a server environment variable that holds the webhook URL, such as SLACK_WEBHOOK_URL.' };
    patch.slackWebhookEnv = name === 'none' ? null : name;
  }
  if (values['cap-usd'] !== undefined) {
    const cap = Number(values['cap-usd']);
    if (values['cap-usd'] !== 'default' && (!Number.isFinite(cap) || cap < 0)) return { error: '--cap-usd must be a number of dollars, or default.' };
    patch.monthlyCapUsd = values['cap-usd'] === 'default' ? null : cap;
  }
  return { patch };
}

/** A date (midnight UTC) or a full ISO date-time. */
function sprintDate(value: string): string | null {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  return /^\d{4}-\d{2}-\d{2}T/.test(date) && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
}
const showDate = (iso: string) => (iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso);

async function sprintCommand(store: SharedStore, repoId: string, values: Args, io: ServerIo): Promise<number> {
  const fail = (message: string) => (io.stderr(`sprintdigest-server: ${message}\n`), 1);
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
  const fail = (message: string) => (io.stderr(`sprintdigest-server: ${message}\n`), 1);
  const [command, ...rest] = argv;
  let values: Args;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
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
        schedule: { type: 'string' },
        weekday: { type: 'string' },
        since: { type: 'string' },
        'preview-hours': { type: 'string' },
        email: { type: 'string' },
        'slack-env': { type: 'string' },
        'cap-usd': { type: 'string' },
      },
    }));
  } catch (err) {
    return fail(`${(err as Error).message}\n${USAGE}`);
  }
  if (!['serve', 'token', 'sprint', 'repo', 'digest'].includes(command ?? '')) return fail(USAGE);
  if (command === 'digest' ? positionals.join(' ') !== 'send-due' : positionals.length) return fail(USAGE);
  const storage = { databaseUrl: io.env.DATABASE_URL, dataDir: values.data };
  if (!storage.databaseUrl && !storage.dataDir) return fail('set DATABASE_URL or pass --data <dir> for a local database.');

  if (command === 'digest') {
    let deps: ReturnType<typeof digestDepsFromEnv>;
    try {
      deps = digestDepsFromEnv(io.env);
    } catch (err) {
      return fail((err as Error).message);
    }
    const { store, close } = await openStore(storage);
    try {
      const results = await sendDue({ ...deps, store, deliveries: (settings) => deliveriesFor(settings, io.env, io.fetch ? { fetchImpl: io.fetch } : {}) });
      for (const r of results) io.stdout(`${r.repoId}  ${r.periodKey}  ${r.result}\n`);
      if (!results.length) io.stdout('Nothing is due.\n');
      // Anything due but not sent, so cron can alert.
      return results.some((r) => !/^(sent to|already sent|in developer preview)/.test(r.result) || r.result.includes('failed')) ? 1 : 0;
    } finally {
      await close();
    }
  }

  if (command === 'token' || command === 'sprint' || command === 'repo') {
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
    if (command === 'repo') {
      const parsed = settingsPatch(values, new Date());
      if ('error' in parsed) return fail(parsed.error);
      const { store, close } = await openStore(storage);
      try {
        io.stdout(showSettings(Object.keys(parsed.patch).length ? await store.saveRepoSettings(repoId, parsed.patch) : await store.repoSettings(repoId)));
        return 0;
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
  let digests: HandlerOptions['digests'];
  try {
    digests = digestDepsFromEnv(io.env);
  } catch (err) {
    await close();
    return fail((err as Error).message);
  }
  const server = await startServer({ store, port, host: io.env.HOST ?? '127.0.0.1', log: (line) => io.stdout(`${line}\n`), digests });
  if (!digests.llm) io.stdout('No ANTHROPIC_API_KEY: serving digests and reports already written, but not writing new ones.\n');
  io.stdout(`sprintdigest-server listening on ${server.url}\n`);
  await new Promise<void>((stop) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop());
  });
  await server.close();
  await close();
  return 0;
}
