import { bySessionStart, type StoredSummary } from './store.js';
import { byFrom, type ManualTicketLink, type SharedStore, type Sprint, type TicketLink, type TrackerTicket } from './tickets.js';

// Summaries grouped by sprint, then by ticket (DECISIONS.md D46). The sprint of a link is the tracker's sprint
// for a ticket the tracker knows, and otherwise the dated sprint containing the session's start.

export type TicketReportFilter = { from: string; to: string } | { sprint: string };

export interface TicketGroup {
  key: string;
  /** From the tracker, when it knows the ticket. */
  title: string | null;
  summaries: { summary: StoredSummary; link: TicketLink }[];
}

export interface SprintGroup {
  /** null for summaries in no sprint. A sprint known only from a tracker has no dates. */
  sprint: { name: string; from: string | null; to: string | null } | null;
  tickets: TicketGroup[];
  unlinked: StoredSummary[];
}

export interface TicketReport {
  repoId: string;
  filter: TicketReportFilter;
  summaryCount: number;
  developerCount: number;
  sprints: SprintGroup[];
}

/** Every link of a pushed summary: its own ticket keys, then the manual links added since. */
export function linksOf(stored: StoredSummary, manual: readonly ManualTicketLink[]): TicketLink[] {
  const s = stored.summary;
  const own = s.ticketRefs.map((ticketKey): TicketLink => {
    // Summaries pushed before ticket sources existed: a key in the branch name came from it, any other was typed in.
    const source = s.ticketSources[ticketKey] ?? (s.branch?.includes(ticketKey) ? 'branch' : 'manual');
    return { sessionId: s.sessionId, ticketKey, source, addedBy: source === 'manual' ? stored.developerId : null, addedAt: source === 'manual' ? s.approvedAt : null };
  });
  const added = manual
    .filter((l) => l.agent === s.agent && l.sessionId === s.sessionId && !s.ticketRefs.includes(l.ticketKey))
    .map((l): TicketLink => ({ sessionId: l.sessionId, ticketKey: l.ticketKey, source: 'manual', addedBy: l.addedBy, addedAt: l.addedAt }));
  return [...own, ...added];
}

const byKey = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function groupByTicket(input: { summaries: StoredSummary[]; manual: ManualTicketLink[]; sprints: Sprint[]; tracker: TrackerTicket[]; onlySprint?: string }): SprintGroup[] {
  const tracker = new Map(input.tracker.map((t) => [t.key, t]));
  const dated = (s: StoredSummary) => {
    const start = new Date(s.summary.startedAt).toISOString();
    return input.sprints.find((sp) => sp.from <= start && start < sp.to)?.name ?? null;
  };
  const sprintOf = (s: StoredSummary, key: string) => (tracker.has(key) ? tracker.get(key)!.sprint : dated(s));

  const groups = new Map<string | null, { tickets: Map<string, TicketGroup['summaries']>; unlinked: StoredSummary[] }>();
  const group = (name: string | null) => groups.get(name) ?? groups.set(name, { tickets: new Map(), unlinked: [] }).get(name)!;
  const wanted = (name: string | null) => input.onlySprint === undefined || name === input.onlySprint;

  for (const summary of [...input.summaries].sort(bySessionStart)) {
    const links = linksOf(summary, input.manual);
    if (links.length === 0) {
      if (wanted(dated(summary))) group(dated(summary)).unlinked.push(summary);
      continue;
    }
    for (const link of links) {
      const name = sprintOf(summary, link.ticketKey);
      if (!wanted(name)) continue;
      const tickets = group(name).tickets;
      (tickets.get(link.ticketKey) ?? tickets.set(link.ticketKey, []).get(link.ticketKey)!).push({ summary, link });
    }
  }

  const known = new Map(input.sprints.map((s) => [s.name, s]));
  // Dated sprints by start, then tracker-only sprints by name, then no sprint.
  const rank = (name: string | null) => (name === null ? 2 : known.has(name) ? 0 : 1);
  const sortKey = (name: string | null) => known.get(name ?? '')?.from ?? name ?? '';
  return [...groups.keys()]
    .sort((a, b) => rank(a) - rank(b) || sortKey(a).localeCompare(sortKey(b)))
    .map((name) => {
      const g = groups.get(name)!;
      const sprint = known.get(name ?? '');
      return {
        sprint: name === null ? null : { name, from: sprint?.from ?? null, to: sprint?.to ?? null },
        tickets: [...g.tickets.keys()].sort(byKey).map((key) => ({ key, title: tracker.get(key)?.title ?? null, summaries: g.tickets.get(key)! })),
        unlinked: g.unlinked,
      };
    });
}

/** The grouped view of a repo for a date range (sessions overlapping it) or for one sprint. */
export async function ticketReport(store: SharedStore, repoId: string, filter: TicketReportFilter): Promise<TicketReport> {
  const [summaries, manual, sprints, tracker] = await Promise.all([
    store.list('sprint' in filter ? { repoId } : { repoId, from: filter.from, to: filter.to }),
    store.ticketLinks(repoId),
    store.sprints(repoId),
    store.trackerTickets(repoId),
  ]);
  const sprintGroups = groupByTicket({ summaries, manual, sprints: [...sprints].sort(byFrom), tracker, ...('sprint' in filter ? { onlySprint: filter.sprint } : {}) });
  const shown = new Map<string, StoredSummary>();
  for (const g of sprintGroups) for (const s of [...g.unlinked, ...g.tickets.flatMap((t) => t.summaries.map((e) => e.summary))]) shown.set(`${s.summary.agent}/${s.summary.sessionId}`, s);
  return { repoId, filter, summaryCount: shown.size, developerCount: new Set([...shown.values()].map((s) => s.developerId)).size, sprints: sprintGroups };
}
