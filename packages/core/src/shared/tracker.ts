import type { SharedStore, TrackerTicket } from './tickets.js';

// Issue trackers (Jira, Linear) behind one interface (DECISIONS.md D47). Their credentials live only in the
// server's environment. Phase 6 ships the interface and a fake; real clients come once there is a sandbox.

export interface Tracker {
  /** The tickets the tracker knows among `keys`, with titles and current sprints. Unknown keys are left out. */
  lookup(keys: string[]): Promise<TrackerTicket[]>;
}

/** A tracker that knows a fixed list of tickets, and records what it was asked. */
export class FakeTracker implements Tracker {
  readonly requests: string[][] = [];
  readonly #tickets: Map<string, TrackerTicket>;

  constructor(tickets: TrackerTicket[]) {
    this.#tickets = new Map(tickets.map((t) => [t.key, t]));
  }

  async lookup(keys: string[]): Promise<TrackerTicket[]> {
    this.requests.push([...keys]);
    return keys.flatMap((k) => (this.#tickets.has(k) ? [{ ...this.#tickets.get(k)! }] : []));
  }
}

const BATCH = 100;

/** Asks the tracker about every ticket the repo's summaries and manual links mention, and stores what it knows. */
export async function refreshTracker(store: SharedStore, tracker: Tracker, repoId: string): Promise<{ asked: number; known: number }> {
  const [summaries, links] = await Promise.all([store.list({ repoId }), store.ticketLinks(repoId)]);
  const keys = [...new Set([...summaries.flatMap((s) => s.summary.ticketRefs), ...links.map((l) => l.ticketKey)])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  let known = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const tickets = await tracker.lookup(keys.slice(i, i + BATCH));
    await store.saveTrackerTickets(repoId, tickets);
    known += tickets.length;
  }
  return { asked: keys.length, known };
}
