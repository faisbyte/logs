import { randomBytes } from 'node:crypto';
import { AgentSchema } from '../schema.js';
import { hashToken, type PushIdentity } from '../shared/store.js';
import type { CostAccount, CostRecord, CostStore } from './store.js';
import { usageEvents } from './telemetry.js';

// Who and what cost tracking records (Phase 12, DECISIONS.md D106, D107). Telemetry from any account the admin hasn't
// registered is dropped, and the only repos ever named are company ones.

const HOUR = 3_600_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turns tracking on for a repo; usage from before then is never recorded. Already on: nothing changes. */
export async function enableCost(store: CostStore, repoId: string, now: Date): Promise<void> {
  if (await costEnabled(store, repoId)) return;
  await store.putCostConfig('repo', repoId, { repoId, enabledAt: now.toISOString(), developersTold: true });
}
export const disableCost = (store: CostStore, repoId: string) => store.removeCostConfig('repo', repoId);
export const costEnabled = async (store: CostStore, repoId: string) => (await store.costConfig('repo')).some((r) => r.repoId === repoId);

const accountKey = (repoId: string, email: string) => JSON.stringify([repoId, email.toLowerCase()]);

export type AccountResult = { status: 'saved' } | { status: 'conflict'; reason: string };

export async function saveAccount(store: CostStore, input: CostAccount): Promise<AccountResult> {
  const account = { ...input, email: input.email.trim().toLowerCase() };
  if (!EMAIL.test(account.email)) return { status: 'conflict', reason: 'email must be an address' };
  for (const held of await store.costConfig('account')) {
    if (held.repoId === account.repoId && held.email === account.email) continue;
    if (held.email === account.email && held.developerId !== account.developerId) return { status: 'conflict', reason: `that email is already registered to ${held.developerId}` };
    if (held.developerId === account.developerId && held.developerName !== account.developerName) {
      return { status: 'conflict', reason: `developer id ${held.developerId} is already ${held.developerName}; one id must mean one person on this server` };
    }
  }
  await store.putCostConfig('account', accountKey(account.repoId, account.email), account);
  return { status: 'saved' };
}
export const removeAccount = (store: CostStore, repoId: string, email: string) => store.removeCostConfig('account', accountKey(repoId, email));

/** "host/org/repo", or "host/org/*" for a whole organisation; false for anything wider or malformed. */
export async function savePattern(store: CostStore, pattern: string): Promise<boolean> {
  const p = pattern.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/[\w.-]+)+(\/\*)?$/.test(p) || (!p.endsWith('/*') && p.split('/').length < 3)) return false;
  await store.putCostConfig('pattern', p, { pattern: p });
  return true;
}
export const removePattern = (store: CostStore, pattern: string) => store.removeCostConfig('pattern', pattern.trim().toLowerCase());

const matches = (pattern: string, repoId: string) => (pattern.endsWith('/*') ? repoId.startsWith(pattern.slice(0, -1)) : repoId === pattern);

/** A credential agents send telemetry with. It can only send; it reads nothing. */
export async function issueIngestToken(store: CostStore, label: string, now: Date): Promise<{ token: string }> {
  const token = `dgi_${randomBytes(32).toString('base64url')}`;
  await store.putCostConfig('ingest', label, { label, hash: hashToken(token), createdAt: now.toISOString() });
  return { token };
}
export const revokeIngestToken = (store: CostStore, label: string) => store.removeCostConfig('ingest', label);
export const isIngestToken = async (store: CostStore, token: string) => Boolean(token) && (await store.costConfig('ingest')).some((t) => t.hash === hashToken(token));

export type IngestResult = { status: 'ok'; recorded: number } | { status: 'invalid' };

export async function ingestUsage(store: CostStore, body: unknown, now: Date): Promise<IngestResult> {
  const read = usageEvents(body);
  if (!read) return { status: 'invalid' };
  if (!read.events.length) return { status: 'ok', recorded: 0 };
  const [accounts, repos, patterns] = [await store.costConfig('account'), await store.costConfig('repo'), await store.costConfig('pattern')];
  const enabledAt = new Map(repos.map((r) => [r.repoId, r.enabledAt]));
  const latest = new Date(now.getTime() + HOUR).toISOString();
  const records: CostRecord[] = [];
  for (const { account: email, organizationId, ...event } of read.events) {
    if (event.at > latest) continue;
    const account = accounts.find(
      (a) => a.email === email && (a.organizationId === null || a.organizationId === organizationId) && (enabledAt.get(a.repoId) ?? '~') <= event.at,
    );
    if (!account) continue;
    const company = event.repoId !== null && (enabledAt.has(event.repoId) || patterns.some((p) => matches(p.pattern, event.repoId!)));
    records.push({
      ...event,
      developerId: account.developerId,
      developerName: account.developerName,
      billing: event.billing ?? account.billing,
      place: event.repoId === null ? 'unknown' : company ? 'company' : 'outside',
      repoId: company ? event.repoId : null,
    });
  }
  return { status: 'ok', recorded: await store.recordUsage(records) };
}

export type CommitResult = { status: 'recorded' | 'unchanged' | 'off' } | { status: 'invalid'; reason: string };

/** A commit made during a session, reported by its developer. Only the hash and the session are kept. */
export async function recordCommit(store: CostStore, identity: PushIdentity, input: { agent?: unknown; sessionId?: unknown; sha?: unknown }, now: Date): Promise<CommitResult> {
  const agent = AgentSchema.safeParse(input.agent);
  if (!agent.success) return { status: 'invalid', reason: `agent must be one of ${AgentSchema.options.join(', ')}` };
  if (typeof input.sessionId !== 'string' || !/^[\w.:-]{1,200}$/.test(input.sessionId)) return { status: 'invalid', reason: 'sessionId must be a session id' };
  if (typeof input.sha !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.sha)) return { status: 'invalid', reason: 'sha must be a full commit hash' };
  if (!(await costEnabled(store, identity.repoId))) return { status: 'off' };
  const saved = await store.saveCommit({ repoId: identity.repoId, developerId: identity.developerId, agent: agent.data, sessionId: input.sessionId, sha: input.sha.toLowerCase(), at: now.toISOString() });
  return { status: saved ? 'recorded' : 'unchanged' };
}

