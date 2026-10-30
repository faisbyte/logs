import { createHash, randomBytes } from 'node:crypto';
import type { Agent } from '../schema.js';
import { validatePush, type UploadPayload } from './payload.js';

// The shared store (DECISIONS.md D39, D40). Implementations differ in where they keep data; the rules
// below (validation, idempotency, immutability, query semantics) are shared and pinned by contract tests.

/** Who is pushing: established from a token by the receiving side, never taken from the payload. */
export interface PushIdentity {
  repoId: string;
  developerId: string;
  developerName: string;
}

/** Developers push and read summaries; readers (stakeholders) read digests and reports only (DECISIONS.md D51). */
export type Role = 'developer' | 'reader';

/** Who a token belongs to. For a reader, developerId and developerName are the reader's own. */
export type Identity = PushIdentity & { role: Role };

export const READER_REFUSAL = 'reader tokens can read digests and reports only';

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

/** A developer withdrew a pushed summary (DECISIONS.md D60). The summary stays stored, never served. */
export interface Retraction {
  repoId: string;
  agent: Agent;
  sessionId: string;
  developerId: string;
  payloadHash: string;
  retractedAt: string;
}

export type RetractResult = { status: 'retracted' | 'already'; retractedAt: string } | { status: 'not-found' | 'forbidden'; reason: string };

export interface SummaryStore {
  /** `payload` is untrusted input: it is validated with the shared schema and secret detectors first. */
  push(identity: PushIdentity, payload: unknown): Promise<PushResult>;
  list(query: SummaryQuery): Promise<StoredSummary[]>;
  teamReport(query: { repoId: string; from: string; to: string }): Promise<TeamReport>;
  /** The pusher withdraws a summary: it leaves every list and report, and digests that included it are withdrawn. */
  retract(identity: PushIdentity, ref: { agent: Agent; sessionId: string }): Promise<RetractResult>;
  /** Oldest first. */
  retractions(repoId: string): Promise<Retraction[]>;
}

export interface TokenStore {
  /** Issues the token for one person, role and repo, replacing any earlier one. The token is returned once and stored only as a hash. */
  issueToken(identity: PushIdentity, role?: Role): Promise<{ token: string }>;
  authenticate(token: string): Promise<Identity | null>;
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
): PushResult | { status: 'create'; key: string; stored: StoredSummary; replaces?: boolean } {
  const validation = validatePush(input);
  if (!validation.ok) return { status: 'rejected', errors: validation.errors };
  const payload = validation.payload;
  const key = summaryKey(identity.repoId, payload);
  const hash = payloadHash(payload);
  const current = existing(key);
  if (current) {
    if (current.developerId !== identity.developerId) return { status: 'conflict', reason: `session ${payload.sessionId} was pushed by another developer.` };
    // A retracted summary can be pushed again by its developer, replacing it (D60).
    if (current.retractedAt) return { status: 'create', key, replaces: true, stored: { ...current, developerName: identity.developerName, pushedAt: now.toISOString(), payloadHash: hash, retractedAt: null, summary: payload } };
    if (current.payloadHash === hash) return { status: 'unchanged', stored: current };
    return { status: 'conflict', reason: `session ${payload.sessionId} was already pushed with different content; pushed summaries are immutable.` };
  }
  return {
    status: 'create',
    key,
    stored: { repoId: identity.repoId, developerId: identity.developerId, developerName: identity.developerName, pushedAt: now.toISOString(), payloadHash: hash, retractedAt: null, summary: payload },
  };
}

/** `linked` are the ticket keys manually linked to this summary after it was pushed (DECISIONS.md D45). */
/** The rules for retracting: only the developer who pushed it, and only once. */
export function decideRetract(identity: PushIdentity, stored: StoredSummary | undefined): RetractResult | { status: 'retract' } {
  if (!stored) return { status: 'not-found', reason: 'no pushed summary for that session in this repo' };
  if (stored.developerId !== identity.developerId) return { status: 'forbidden', reason: 'only the developer who pushed a summary can retract it' };
  if (stored.retractedAt) return { status: 'already', retractedAt: stored.retractedAt };
  return { status: 'retract' };
}

/** How digests name the summaries they were written from. */
export const digestSummaryKey = (s: { agent: string; sessionId: string }) => `${s.agent}/${s.sessionId}`;

export function matchesQuery(s: StoredSummary, q: SummaryQuery, linked: readonly string[] = []): boolean {
  if (s.repoId !== q.repoId || s.retractedAt) return false;
  if (q.branch !== undefined && s.summary.branch !== q.branch) return false;
  if (q.ticket !== undefined && !s.summary.ticketRefs.includes(q.ticket) && !linked.includes(q.ticket)) return false;
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
  if (identity.role !== 'developer') return { status: 'forbidden', reason: READER_REFUSAL };
  return store.push(identity, payload);
}
