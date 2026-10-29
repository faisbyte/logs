import { bySessionStart, decidePush, hashToken, matchesQuery, newToken, summaryKey, teamReportFrom, type Identity, type PushIdentity, type Role, type PushResult, type StoredSummary, type SummaryQuery, type TeamReport } from './store.js';
import {
  byFrom,
  byLinkTime,
  decideLink,
  decideSprint,
  decideUnlink,
  type LinkResult,
  type ManualTicketLink,
  type SharedStore,
  type Sprint,
  type SprintResult,
  type SummaryRef,
  type TrackerTicket,
  type UnlinkResult,
} from './tickets.js';

/** A shared store kept in memory: for tests, and the reference implementation of the contracts. */
export class InMemorySummaryStore implements SharedStore {
  readonly #summaries = new Map<string, StoredSummary>();
  /** token hash → identity */
  readonly #tokens = new Map<string, Identity>();
  readonly #links: ManualTicketLink[] = [];
  readonly #sprints = new Map<string, Sprint[]>();
  /** Tracker tickets by repo, then by key. */
  readonly #tracker = new Map<string, Map<string, TrackerTicket>>();
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
    const linked = (s: StoredSummary) => this.#linksOf(s.repoId, s.summary).map((l) => l.ticketKey);
    return structuredClone([...this.#summaries.values()].filter((s) => matchesQuery(s, query, linked(s))).sort(bySessionStart));
  }

  async teamReport(query: { repoId: string; from: string; to: string }): Promise<TeamReport> {
    return teamReportFrom(query, await this.list(query));
  }

  async issueToken(identity: PushIdentity, role: Role = 'developer'): Promise<{ token: string }> {
    for (const [hash, held] of this.#tokens) if (held.repoId === identity.repoId && held.developerId === identity.developerId && held.role === role) this.#tokens.delete(hash);
    const token = newToken();
    this.#tokens.set(hashToken(token), { repoId: identity.repoId, developerId: identity.developerId, developerName: identity.developerName, role });
    return { token };
  }

  async authenticate(token: string): Promise<Identity | null> {
    const identity = token ? this.#tokens.get(hashToken(token)) : undefined;
    return identity ? { ...identity } : null;
  }

  #linksOf(repoId: string, ref: SummaryRef) {
    return this.#links.filter((l) => l.repoId === repoId && l.agent === ref.agent && l.sessionId === ref.sessionId);
  }

  async addTicketLink(identity: PushIdentity, ref: SummaryRef, ticketKey: string): Promise<LinkResult> {
    const linked = this.#linksOf(identity.repoId, ref).some((l) => l.ticketKey === ticketKey);
    const decision = decideLink(identity, this.#summaries.get(summaryKey(identity.repoId, ref)), ticketKey, linked);
    if (decision.status !== 'create') return decision;
    this.#links.push({ repoId: identity.repoId, agent: ref.agent, sessionId: ref.sessionId, ticketKey, addedBy: identity.developerId, addedAt: this.#now().toISOString() });
    return { status: 'created' };
  }

  async removeTicketLink(identity: PushIdentity, ref: SummaryRef, ticketKey: string): Promise<UnlinkResult> {
    const link = this.#linksOf(identity.repoId, ref).find((l) => l.ticketKey === ticketKey);
    const decision = decideUnlink(identity, this.#summaries.get(summaryKey(identity.repoId, ref)), ticketKey, link !== undefined);
    if (decision.status !== 'remove') return decision;
    this.#links.splice(this.#links.indexOf(link!), 1);
    return { status: 'removed' };
  }

  async ticketLinks(repoId: string): Promise<ManualTicketLink[]> {
    return structuredClone(this.#links.filter((l) => l.repoId === repoId).sort(byLinkTime));
  }

  async saveSprint(repoId: string, sprint: Sprint): Promise<SprintResult> {
    const existing = this.#sprints.get(repoId) ?? [];
    const decision = decideSprint(existing, sprint);
    if (decision.status !== 'save') return decision;
    this.#sprints.set(repoId, [...existing.filter((s) => s.name !== decision.sprint.name), decision.sprint]);
    return { status: 'saved' };
  }

  async removeSprint(repoId: string, name: string): Promise<boolean> {
    const existing = this.#sprints.get(repoId) ?? [];
    this.#sprints.set(repoId, existing.filter((s) => s.name !== name));
    return existing.some((s) => s.name === name);
  }

  async sprints(repoId: string): Promise<Sprint[]> {
    return structuredClone([...(this.#sprints.get(repoId) ?? [])].sort(byFrom));
  }

  async saveTrackerTickets(repoId: string, tickets: TrackerTicket[]): Promise<void> {
    const known = this.#tracker.get(repoId) ?? new Map<string, TrackerTicket>();
    for (const t of tickets) known.set(t.key, { key: t.key, title: t.title, sprint: t.sprint });
    this.#tracker.set(repoId, known);
  }

  async trackerTickets(repoId: string): Promise<TrackerTicket[]> {
    return structuredClone([...(this.#tracker.get(repoId)?.values() ?? [])].sort((a, b) => a.key.localeCompare(b.key)));
  }
}
