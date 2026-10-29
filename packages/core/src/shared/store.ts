import { createHash, randomBytes } from 'node:crypto';
import { validatePush, type UploadPayload } from './payload.js';

// The shared store (DECISIONS.md D39, D40). Implementations differ in where they keep data; the rules
// below (validation, idempotency, immutability, query semantics) are shared and pinned by contract tests.

/** Who is pushing: established from a token by the receiving side, never taken from the payload. */
export interface PushIdentity {
  repoId: string;
  developerId: string;
  developerName: string;
}

export interface StoredSummary {
  repoId: string;
  developerId: string;
  developerName: string;
  pushedAt: string;
  /** sha256 of the payload; a repeat push with the same hash is a no-op. */
  payloadHash: string;
  /** Room for retraction by the author (Phase 10); retracted summaries are left out of every query. */
  retractedAt: string | null;
  summary: UploadPayload;
}

export type PushResult =
  | { status: 'created' | 'unchanged'; stored: StoredSummary }
  | { status: 'conflict'; reason: string }
  | { status: 'rejected'; errors: string[] };

export interface SummaryQuery {
  repoId: string;
  branch?: string;
  ticket?: string;
  developerId?: string;
  /** Sessions overlapping [from, to): ended at or after `from`, started before `to`. */
  from?: string;
  to?: string;
}

/** Everything every developer pushed for a repo in a date range: the input to the Phase 7 team report. */
export interface TeamReport {
  repoId: string;
  from: string;
  to: string;
  summaryCount: number;
  developerCount: number;
  summaries: StoredSummary[];
}

export interface SummaryStore {
  /** `payload` is untrusted input: it is validated with the shared schema and secret detectors first. */
  push(identity: PushIdentity, payload: unknown): Promise<PushResult>;
  list(query: SummaryQuery): Promise<StoredSummary[]>;
  teamReport(query: { repoId: string; from: string; to: string }): Promise<TeamReport>;
}

export interface TokenStore {
  /** Issues the token for one developer on one repo, replacing any earlier one. The token is returned once and stored only as a hash. */
  issueToken(identity: PushIdentity): Promise<{ token: string }>;
  authenticate(token: string): Promise<PushIdentity | null>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const newToken = () => `dgt_${randomBytes(32).toString('base64url')}`;
export const hashToken = (token: string) => sha256(token);
export const payloadHash = (payload: UploadPayload) => sha256(JSON.stringify(payload));
export const summaryKey = (repoId: string, s: Pick<UploadPayload, 'agent' | 'sessionId'>) => JSON.stringify([repoId, s.agent, s.sessionId]);

/** The push rules: validate, then create, accept a repeat, or refuse a change or another developer's session. */
export function decidePush(
  identity: PushIdentity,
  input: unknown,
  existing: (key: string) => StoredSummary | undefined,
  now: Date,
): PushResult | { status: 'create'; key: string; stored: StoredSummary } {
  const validation = validatePush(input);
  if (!validation.ok) return { status: 'rejected', errors: validation.errors };
  const payload = validation.payload;
  const key = summaryKey(identity.repoId, payload);
  const hash = payloadHash(payload);
  const current = existing(key);
  if (current) {
    if (current.developerId !== identity.developerId) return { status: 'conflict', reason: `session ${payload.sessionId} was pushed by another developer.` };
    if (current.payloadHash === hash) return { status: 'unchanged', stored: current };
    return { status: 'conflict', reason: `session ${payload.sessionId} was already pushed with different content; pushed summaries are immutable.` };
  }
  return {
    status: 'create',
    key,
    stored: { repoId: identity.repoId, developerId: identity.developerId, developerName: identity.developerName, pushedAt: now.toISOString(), payloadHash: hash, retractedAt: null, summary: payload },
  };
}

export function matchesQuery(s: StoredSummary, q: SummaryQuery): boolean {
  if (s.repoId !== q.repoId || s.retractedAt) return false;
  if (q.branch !== undefined && s.summary.branch !== q.branch) return false;
  if (q.ticket !== undefined && !s.summary.ticketRefs.includes(q.ticket)) return false;
  if (q.developerId !== undefined && s.developerId !== q.developerId) return false;
  if (q.from !== undefined && Date.parse(s.summary.endedAt) < Date.parse(q.from)) return false;
  if (q.to !== undefined && Date.parse(s.summary.startedAt) >= Date.parse(q.to)) return false;
  return true;
}

export const bySessionStart = (a: StoredSummary, b: StoredSummary) =>
  Date.parse(a.summary.startedAt) - Date.parse(b.summary.startedAt) || a.summary.sessionId.localeCompare(b.summary.sessionId);

export function teamReportFrom(query: { repoId: string; from: string; to: string }, summaries: StoredSummary[]): TeamReport {
  return { ...query, summaryCount: summaries.length, developerCount: new Set(summaries.map((s) => s.developerId)).size, summaries };
}

export type ReceiveResult = PushResult | { status: 'unauthorized' | 'forbidden'; reason: string };

/** The receiving side of one push: the token decides who is pushing and to which repo, then the store's rules apply. */
export async function receivePush(store: SummaryStore & TokenStore, token: string, repoId: string, payload: unknown): Promise<ReceiveResult> {
  const identity = await store.authenticate(token);
  if (!identity) return { status: 'unauthorized', reason: 'unknown or revoked token' };
  if (identity.repoId !== repoId) return { status: 'forbidden', reason: 'this token is for a different repo' };
  return store.push(identity, payload);
}

/** What a pusher learns about one push. */
export type PushOutcome =
  | { status: 'created' | 'unchanged' }
  | { status: 'conflict' | 'unauthorized' | 'forbidden'; reason: string }
  | { status: 'rejected'; errors: string[] };

/** What `digest push` talks to: the store behind its auth. The token lives inside the target, never in a summary. */
export interface PushTarget {
  push(repoId: string, payload: UploadPayload): Promise<PushOutcome>;
}

/** A PushTarget for a store in this process (tests, and local end-to-end runs). */
export const localPushTarget = (store: SummaryStore & TokenStore, token: string): PushTarget => ({
  push: (repoId, payload) => receivePush(store, token, repoId, payload),
});
