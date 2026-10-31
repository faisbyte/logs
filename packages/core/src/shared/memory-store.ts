import { bySessionStart, decidePush, decideRetract, digestSummaryKey, hashToken, matchesQuery, newToken, summaryKey, teamReportFrom, type Retraction, type RetractResult, type Identity, type PushIdentity, type Role, type PushResult, type StoredSummary, type SummaryQuery, type TeamReport } from './store.js';
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
  type TicketTitle,
  type TitleResult,
  type TrackerTicket,
  type UnlinkResult,
  decideTitle,
} from './tickets.js';

import { randomUUID } from 'node:crypto';
import { checkNewDigest, defaultRepoSettings, sameReport, type DigestPatch, type DigestStore, type DigestKind, type DigestStatus, type NewDigest, type RepoSettings, type ReportKey, type StoredDigest } from './digests.js';

/** A shared store kept in memory: for tests, and the reference implementation of the contracts. */
export class InMemorySummaryStore implements SharedStore, DigestStore {
  readonly #summaries = new Map<string, StoredSummary>();
  /** token hash → identity */
  readonly #tokens = new Map<string, Identity>();
  readonly #links: ManualTicketLink[] = [];
  readonly #sprints = new Map<string, Sprint[]>();
  /** Tracker tickets by repo, then by key. */
  readonly #tracker = new Map<string, Map<string, TrackerTicket>>();
  readonly #digests: StoredDigest[] = [];
  readonly #retractions: Retraction[] = [];
  readonly #spend: { repoId: string; usd: number; at: string }[] = [];
  readonly #settings = new Map<string, RepoSettings>();
  readonly #titles = new Map<string, Map<string, TicketTitle>>();
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

  async retract(identity: PushIdentity, ref: { agent: StoredSummary['summary']['agent']; sessionId: string }): Promise<RetractResult> {
    const stored = this.#summaries.get(summaryKey(identity.repoId, ref));
    const decision = decideRetract(identity, stored);
    if (decision.status !== 'retract') return decision;
    const retractedAt = this.#now().toISOString();
    stored!.retractedAt = retractedAt;
    this.#retractions.push({ repoId: identity.repoId, agent: ref.agent, sessionId: ref.sessionId, developerId: identity.developerId, payloadHash: stored!.payloadHash, retractedAt });
    const key = digestSummaryKey(ref);
    for (let i = this.#digests.length - 1; i >= 0; i--) {
      const d = this.#digests[i]!;
      if (d.repoId !== identity.repoId || !d.summaryKeys.includes(key)) continue;
      if (d.status === 'sent') d.status = 'withdrawn';
      else this.#digests.splice(i, 1);
    }
    return { status: 'retracted', retractedAt };
  }

  async retractions(repoId: string): Promise<Retraction[]> {
    return structuredClone(this.#retractions.filter((r) => r.repoId === repoId));
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

  async saveDigest(digest: NewDigest): Promise<StoredDigest> {
    checkNewDigest(digest);
    const existing = this.#digests.find(
      (d) => d.repoId === digest.repoId && (digest.kind === 'scheduled' ? d.kind === 'scheduled' && d.periodKey === digest.periodKey : sameReport(d, digest)),
    );
    if (existing) return structuredClone(existing);
    const stored: StoredDigest = { ...structuredClone(digest), summaryKeys: [...(digest.summaryKeys ?? [])], id: randomUUID(), deliveries: {}, sentAt: null };
    this.#digests.push(stored);
    return structuredClone(stored);
  }

  async getDigest(repoId: string, id: string): Promise<StoredDigest | null> {
    const d = this.#digests.find((x) => x.repoId === repoId && x.id === id);
    return d ? structuredClone(d) : null;
  }

  async findReport(repoId: string, key: ReportKey): Promise<StoredDigest | null> {
    const d = this.#digests.find((x) => x.repoId === repoId && sameReport(x, key));
    return d ? structuredClone(d) : null;
  }

  async scheduledDigest(repoId: string, periodKey: string): Promise<StoredDigest | null> {
    const d = this.#digests.find((x) => x.repoId === repoId && x.kind === 'scheduled' && x.periodKey === periodKey);
    return d ? structuredClone(d) : null;
  }

  async digests(repoId: string, filter: { kinds?: DigestKind[]; statuses?: DigestStatus[] } = {}): Promise<StoredDigest[]> {
    return structuredClone(
      this.#digests
        .filter((d) => d.repoId === repoId && (!filter.kinds || filter.kinds.includes(d.kind)) && (!filter.statuses || filter.statuses.includes(d.status)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    );
  }

  async updateDigest(repoId: string, id: string, patch: DigestPatch): Promise<void> {
    const d = this.#digests.find((x) => x.repoId === repoId && x.id === id);
    if (!d) return;
    const { deliveries, ...rest } = patch;
    Object.assign(d, rest, { deliveries: { ...d.deliveries, ...deliveries } });
  }

  async recordSpend(repoId: string, usd: number, at: string): Promise<void> {
    this.#spend.push({ repoId, usd, at });
  }

  async spendSince(repoId: string, since: string): Promise<number> {
    return this.#spend.filter((s) => s.repoId === repoId && Date.parse(s.at) >= Date.parse(since)).reduce((n, s) => n + s.usd, 0);
  }

  async repoSettings(repoId: string): Promise<RepoSettings> {
    return structuredClone(this.#settings.get(repoId) ?? defaultRepoSettings(repoId));
  }

  async saveRepoSettings(repoId: string, patch: Partial<Omit<RepoSettings, 'repoId'>>): Promise<RepoSettings> {
    const next = { ...(await this.repoSettings(repoId)), ...structuredClone(patch), repoId };
    this.#settings.set(repoId, next);
    return structuredClone(next);
  }

  async scheduledRepos(): Promise<string[]> {
    return [...this.#settings.values()].filter((s) => s.schedule !== 'off').map((s) => s.repoId).sort();
  }

  async setTicketTitle(identity: PushIdentity, ticketKey: string, title: string): Promise<TitleResult> {
    const decision = decideTitle(ticketKey, title);
    if (decision.status !== 'save') return decision;
    const titles = this.#titles.get(identity.repoId) ?? this.#titles.set(identity.repoId, new Map()).get(identity.repoId)!;
    titles.set(ticketKey, { key: ticketKey, title: decision.title, setBy: identity.developerId, setAt: this.#now().toISOString() });
    return { status: 'saved' };
  }

  async ticketTitles(repoId: string): Promise<TicketTitle[]> {
    return structuredClone([...(this.#titles.get(repoId)?.values() ?? [])].sort((a, b) => a.key.localeCompare(b.key)));
  }
}
