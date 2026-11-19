import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { ADMIN_ACTOR, AnthropicLlmClient, normalizeRemoteUrl, SERVER_ACTOR, type AuditAction, type DigestDeps, type Effort, type RepoSettings, type SharedStore } from '@digest/core';
import { deliveriesFor } from './delivery.js';
import pg from 'pg';
import { createHandler, type HandlerOptions } from './http.js';
import { openPGlite } from './pglite.js';
import { migrate, poolSql, PostgresSummaryStore } from './postgres-store.js';
import { distill, distillNeedsAttention } from './distill.js';
import { needsAttention, sendDue } from './schedule.js';
import { RateLimiter, rateLimitFromEnv } from './rate-limit.js';

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
                          [--email <a@x,b@y>|none] [--slack-env <ENV_NAME>|none] [--cap-usd <n>|default]
                          [--retention-days <n>|forever] [--data <dir>]
       sprintdigest-server delete-data --repo <repo> --developer <id> [--yes] [--data <dir>]
       sprintdigest-server digest send-due [--data <dir>]
       sprintdigest-server context distill [--data <dir>]
       sprintdigest-server retention apply [--data <dir>]
       sprintdigest-server audit --repo <repo> [--since <date>] [--limit <n>] [--data <dir>]
Storage: DATABASE_URL (Postgres), or --data <dir> for a local PGlite database (one process at a time).`;

export async function openStore({ databaseUrl, dataDir }: { databaseUrl?: string; dataDir?: string }): Promise<{ store: SharedStore; close: () => Promise<void> }> {
  if (databaseUrl) {
    // Migrations need one connection; the pool serves requests.
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await migrate(client).finally(() => client.end());
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return { store: new PostgresSummaryStore(poolSql(pool)), close: () => pool.end() };
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
  const jargon = env.DIGEST_JARGON?.split(',').map((t) => t.trim()).filter(Boolean);
  return { llm: env.ANTHROPIC_API_KEY ? AnthropicLlmClient.fromEnv(env, model, effort) : null, model, defaultCapUsd, ...(jargon ? { jargon } : {}) };
}

export async function startServer({
  store,
  port,
  host = '127.0.0.1',
  log,
  digests,
  rateLimit = null,
}: { store: SharedStore; port: number; host?: string; log?: (line: string) => void; digests?: HandlerOptions['digests']; rateLimit?: number | null }) {
  const limiter = rateLimit ? new RateLimiter(rateLimit) : null;
  const server = createServer(createHandler(store, { ...(log ? { log } : {}), ...(digests ? { digests } : {}), rateLimit: limiter }));
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
  limit?: string;
  'preview-hours'?: string;
  email?: string;
  'slack-env'?: string;
  'cap-usd'?: string;
  'retention-days'?: string;
  yes?: boolean;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const title = (day: string) => day[0]!.toUpperCase() + day.slice(1);

function showSettings(s: RepoSettings): string {
  const schedule =
    s.schedule === 'off'
      ? 'off'
      : `${s.schedule === 'weekly' ? `weekly on ${title(WEEKDAYS[s.weekday - 1]!)}` : 'at the end of each sprint'}${s.scheduleSince ? `, for periods ending after ${showDate(s.scheduleSince)}` : ''}`;
  return [
    `Settings for ${s.repoId}:`,
    `  schedule: ${schedule}`,
    `  developer preview: ${s.previewHours ? `${s.previewHours} hours before sending` : 'off'}`,
    `  email: ${s.emailTo.join(', ') || 'none'}`,
    `  slack: ${s.slackWebhookEnv ? `the webhook URL in ${s.slackWebhookEnv}` : 'none'}`,
    `  monthly LLM cost cap: ${s.monthlyCapUsd === null ? 'the server default' : `$${s.monthlyCapUsd.toFixed(2)}`}`,
    `  summaries kept: ${s.retentionDays === null ? 'for good' : `${s.retentionDays} days after their session ends`}`,
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
  if (values['retention-days'] !== undefined) {
    const days = values['retention-days'];
    if (days !== 'forever' && (!/^\d+$/.test(days) || Number(days) < 1)) return { error: '--retention-days must be a whole number of days from 1, or forever.' };
    patch.retentionDays = days === 'forever' ? null : Number(days);
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

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Retention (D99): each repo with a period loses the summaries that ended longer ago. Run from cron, like send-due. */
async function retentionCommand(store: SharedStore, now: Date, io: ServerIo): Promise<number> {
  const repos = await store.retentionRepos();
  if (!repos.length) return (io.stdout('No repo has a retention period.\n'), 0);
  for (const { repoId, retentionDays } of repos) {
    const before = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const r = await store.purgeSummariesBefore(repoId, before);
    if (r.summaries) {
      await store.recordAudit({ repoId, at: now.toISOString(), ...SERVER_ACTOR, action: 'retention.applied', target: null, detail: `kept ${retentionDays} days: ${count(r.summaries, 'summary', 'summaries')}` });
    }
    io.stdout(
      `${repoId}  kept ${retentionDays} days: ` +
        (r.summaries
          ? `deleted ${count(r.summaries, 'summary that', 'summaries that')} ended before ${before.slice(0, 10)}, ${count(r.ticketLinks, 'ticket link', 'ticket links')}, ` +
            `${count(r.contextItemsDeleted, 'context item', 'context items')} deleted and ${r.contextItemsEdited} edited\n`
          : 'nothing to delete\n'),
    );
  }
  return 0;
}

/** The admin's delete my data (D98), for a developer who can't run it themselves, such as one who has left. */
async function deleteDataCommand(storage: { databaseUrl?: string; dataDir?: string }, repoId: string, values: Args, io: ServerIo): Promise<number> {
  const fail = (message: string) => (io.stderr(`sprintdigest-server: ${message}\n`), 1);
  const developerId = values.developer;
  if (!developerId) return fail('--developer is required.');
  if (!values.yes) return fail(`this permanently deletes every summary ${developerId} pushed to ${repoId}, and what was made only from them. Run it again with --yes to go ahead.`);
  const { store, close } = await openStore(storage);
  try {
    const r = await store.deleteDeveloperData({ repoId, developerId, developerName: developerId });
    await store.recordAudit({ repoId, at: new Date().toISOString(), ...ADMIN_ACTOR, action: 'data.deleted', target: developerId, detail: count(r.summaries, 'summary', 'summaries') });
    io.stdout(
      `Deleted ${developerId}'s data on ${repoId}: ${count(r.summaries, 'summary', 'summaries')}, ${count(r.ticketLinks, 'ticket link', 'ticket links')}, ` +
        `${count(r.contextItemsDeleted, 'context item', 'context items')} deleted and ${r.contextItemsEdited} edited, ${count(r.digestsWithdrawn, 'digest', 'digests')} withdrawn and ${r.digestsDeleted} deleted.\n`,
    );
    return 0;
  } finally {
    await close();
  }
}

const VERB: Record<AuditAction, string> = {
  'digest.viewed': 'viewed digest',
  'digest.sent': 'sent digest',
  'report.written': 'wrote report',
  'summary.pushed': 'pushed summary',
  'summary.retracted': 'retracted summary',
  'context.retired': 'retired context item',
  'data.deleted': 'deleted data',
  'retention.applied': 'applied retention',
  'token.issued': 'issued a token',
  'session.started': 'signed in to the dashboard',
};

/** The audit log (D100), newest first, for the admin only: there is no HTTP endpoint for it. */
async function auditCommand(store: SharedStore, repoId: string, values: Args, io: ServerIo): Promise<number> {
  const fail = (message: string) => (io.stderr(`sprintdigest-server: ${message}\n`), 1);
  const since = values.since === undefined ? undefined : sprintDate(values.since);
  if (since === null) return fail('--since must be a date such as 2026-03-01, or an ISO date-time.');
  if (values.limit !== undefined && !/^[1-9]\d*$/.test(values.limit)) return fail('--limit must be a whole number from 1.');
  const events = await store.auditEvents(repoId, { ...(since ? { since } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}) });
  if (!events.length) return (io.stdout(`No audit events for ${repoId}.\n`), 0);
  for (const e of events) {
    io.stdout(`${[`${e.at.slice(0, 16).replace('T', ' ')} UTC`, `${e.actorName} (${e.actorRole})`, VERB[e.action], e.target, e.detail].filter(Boolean).join('  ')}\n`);
  }
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
        limit: { type: 'string' },
        'preview-hours': { type: 'string' },
        email: { type: 'string' },
        'slack-env': { type: 'string' },
        'cap-usd': { type: 'string' },
        'retention-days': { type: 'string' },
        yes: { type: 'boolean' },
      },
    }));
  } catch (err) {
    return fail(`${(err as Error).message}\n${USAGE}`);
  }
  if (!['serve', 'token', 'sprint', 'repo', 'digest', 'context', 'delete-data', 'retention', 'audit'].includes(command ?? '')) return fail(USAGE);
  const sub = { digest: 'send-due', context: 'distill', retention: 'apply' }[command as string];
  if (sub ? positionals.join(' ') !== sub : positionals.length) return fail(USAGE);
  const storage = { databaseUrl: io.env.DATABASE_URL, dataDir: values.data };
  if (!storage.databaseUrl && !storage.dataDir) return fail('set DATABASE_URL or pass --data <dir> for a local database.');

  if (command === 'retention') {
    const { store, close } = await openStore(storage);
    try {
      return await retentionCommand(store, new Date(), io);
    } finally {
      await close();
    }
  }

  if (command === 'context') {
    let deps: ReturnType<typeof digestDepsFromEnv>;
    try {
      deps = digestDepsFromEnv(io.env);
    } catch (err) {
      return fail((err as Error).message);
    }
    const { store, close } = await openStore(storage);
    try {
      const results = await distill({ ...deps, store });
      for (const r of results) io.stdout(`${r.repoId}  ${r.result}\n`);
      if (!results.length) io.stdout('No shared summaries to distill.\n');
      // Summaries left unread (no key, the cap, a failed call), so cron can alert (D82).
      return results.some((r) => distillNeedsAttention(r.result)) ? 1 : 0;
    } finally {
      await close();
    }
  }

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
      return results.some((r) => needsAttention(r.result)) ? 1 : 0;
    } finally {
      await close();
    }
  }

  if (command === 'token' || command === 'sprint' || command === 'repo' || command === 'delete-data' || command === 'audit') {
    if (!values.repo) return fail('--repo is required.');
    const repoId = repoIdFrom(values.repo);
    if (!repoId) return fail('--repo must be a repo URL or host/path id, e.g. git@github.com:acme/webapp.git or github.com/acme/webapp.');
    if (command === 'delete-data') return deleteDataCommand(storage, repoId, values, io);
    if (command === 'audit') {
      const { store, close } = await openStore(storage);
      try {
        return await auditCommand(store, repoId, values, io);
      } finally {
        await close();
      }
    }
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
      // Recorded before the token is shown; the token itself never reaches the log.
      await store.recordAudit({ repoId, at: new Date().toISOString(), ...ADMIN_ACTOR, action: 'token.issued', target: person, detail: values.reader ? 'reader' : 'developer' });
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
  let rateLimit: number | null;
  try {
    rateLimit = rateLimitFromEnv(io.env);
  } catch (err) {
    return fail((err as Error).message);
  }
  const { store, close } = await openStore(storage);
  let digests: HandlerOptions['digests'];
  try {
    digests = digestDepsFromEnv(io.env);
  } catch (err) {
    await close();
    return fail((err as Error).message);
  }
  const server = await startServer({ store, port, host: io.env.HOST ?? '127.0.0.1', log: (line) => io.stdout(`${line}\n`), digests, rateLimit });
  if (!digests.llm) io.stdout('No ANTHROPIC_API_KEY: serving digests and reports already written, but not writing new ones.\n');
  io.stdout(`sprintdigest-server listening on ${server.url}\n`);
  await new Promise<void>((stop) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop());
  });
  await server.close();
  await close();
  return 0;
}
