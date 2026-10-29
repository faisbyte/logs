import { bySessionStart, decidePush, hashToken, matchesQuery, newToken, teamReportFrom, type PushIdentity, type PushResult, type StoredSummary, type SummaryQuery, type SummaryStore, type TeamReport, type TokenStore } from './store.js';

/** A SummaryStore kept in memory: for tests, and the reference implementation of the contract. */
export class InMemorySummaryStore implements SummaryStore, TokenStore {
  readonly #summaries = new Map<string, StoredSummary>();
  /** token hash → identity */
  readonly #tokens = new Map<string, PushIdentity>();
  readonly #now: () => Date;

  constructor({ now = () => new Date() }: { now?: () => Date } = {}) {
    this.#now = now;
  }

  async push(identity: PushIdentity, payload: unknown): Promise<PushResult> {
    const decision = decidePush(identity, payload, (key) => this.#summaries.get(key), this.#now());
    if (decision.status !== 'create') return structuredClone(decision);
    this.#summaries.set(decision.key, decision.stored);
    return { status: 'created', stored: structuredClone(decision.stored) };
  }

  async list(query: SummaryQuery): Promise<StoredSummary[]> {
    return structuredClone([...this.#summaries.values()].filter((s) => matchesQuery(s, query)).sort(bySessionStart));
  }

  async teamReport(query: { repoId: string; from: string; to: string }): Promise<TeamReport> {
    return teamReportFrom(query, await this.list(query));
  }

  async issueToken(identity: PushIdentity): Promise<{ token: string }> {
    for (const [hash, held] of this.#tokens) if (held.repoId === identity.repoId && held.developerId === identity.developerId) this.#tokens.delete(hash);
    const token = newToken();
    this.#tokens.set(hashToken(token), { ...identity });
    return { token };
  }

  async authenticate(token: string): Promise<PushIdentity | null> {
    const identity = token ? this.#tokens.get(hashToken(token)) : undefined;
    return identity ? { ...identity } : null;
  }
}
