import { describe, expect, it } from 'vitest';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { FakeTracker, refreshTracker } from '../../src/shared/tracker.js';
import { payloadFor } from './store-contract.js';

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };

describe('refreshTracker', () => {
  it("asks the tracker about every ticket the repo's summaries and manual links mention, and keeps what it knows", async () => {
    const store = new InMemorySummaryStore();
    await store.push(alice, payloadFor({ sessionId: 's1', ticketRefs: ['PROJ-1', 'PROJ-2'] }));
    await store.push(alice, payloadFor({ sessionId: 's2', ticketRefs: ['PROJ-1'] }));
    await store.addTicketLink(alice, { agent: 'claude-code', sessionId: 's2' }, 'OPS-4');
    const tracker = new FakeTracker([
      { key: 'PROJ-1', title: 'Login', sprint: 'Sprint 1' },
      { key: 'OPS-4', title: 'Alerts', sprint: null },
      { key: 'PROJ-99', title: 'Unrelated', sprint: 'Sprint 1' },
    ]);
    expect(await refreshTracker(store, tracker, REPO)).toEqual({ asked: 3, known: 2 });
    expect(tracker.requests).toEqual([['OPS-4', 'PROJ-1', 'PROJ-2']]);
    expect(await store.trackerTickets(REPO)).toEqual([
      { key: 'OPS-4', title: 'Alerts', sprint: null },
      { key: 'PROJ-1', title: 'Login', sprint: 'Sprint 1' },
    ]);
  });

  it('asks in batches, and not at all when there are no tickets', async () => {
    const store = new InMemorySummaryStore();
    const tracker = new FakeTracker([]);
    expect(await refreshTracker(store, tracker, REPO)).toEqual({ asked: 0, known: 0 });
    expect(tracker.requests).toEqual([]);
    for (let i = 0; i < 3; i++) await store.push(alice, payloadFor({ sessionId: `s${i}`, ticketRefs: Array.from({ length: 50 }, (_, j) => `P${i}-${j}`) }));
    await refreshTracker(store, tracker, REPO);
    expect(tracker.requests.map((r) => r.length)).toEqual([100, 50]);
  });
});
