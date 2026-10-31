import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { ticketReport, type TicketReport } from '../../src/shared/ticket-report.js';
import type { SummaryRef } from '../../src/shared/tickets.js';
import type { SessionSummary } from '../../src/summarize/schema.js';
import { payloadFor } from './store-contract.js';

// Grouping by sprint, then ticket (DECISIONS.md D45, D46).

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
const day = (d: string, h = '09') => `2026-03-${d}T${h}:00:00.000Z`;

let store: InMemorySummaryStore;
const push = (who: typeof alice, sessionId: string, start: string, end: string, tickets: Pick<SessionSummary, 'ticketRefs' | 'ticketSources'> & { branch?: string }) =>
  store.push(who, payloadFor({ sessionId, startedAt: start, endedAt: end, branch: tickets.branch ?? 'main', ticketRefs: tickets.ticketRefs, ticketSources: tickets.ticketSources }));
const ref = (sessionId: string): SummaryRef => ({ agent: 'claude-code', sessionId });

/** sprint → ticket → session ids, and sprint → unlinked session ids. */
function shape(report: TicketReport) {
  return Object.fromEntries(
    report.sprints.map((g) => [
      g.sprint?.name ?? '(no sprint)',
      {
        ...Object.fromEntries(g.tickets.map((t) => [t.key, t.summaries.map((e) => e.summary.summary.sessionId)])),
        ...(g.unlinked.length ? { unlinked: g.unlinked.map((s) => s.summary.sessionId) } : {}),
      },
    ]),
  );
}

beforeEach(async () => {
  store = new InMemorySummaryStore({ now: () => new Date('2026-03-20T12:00:00.000Z') });
  await store.saveSprint(REPO, { name: 'Sprint 1', from: day('02', '00'), to: day('16', '00') });
  await store.saveSprint(REPO, { name: 'Sprint 2', from: day('16', '00'), to: day('30', '00') });
  await push(alice, 'a1', day('03'), day('03', '11'), { ticketRefs: ['PROJ-1'], ticketSources: { 'PROJ-1': 'branch' }, branch: 'feature/PROJ-1-login' });
  // Crosses the sprint boundary: starts on Sprint 1's last evening, ends in Sprint 2.
  await push(bob, 'b1', day('15', '22'), day('16', '02'), { ticketRefs: ['PROJ-2', 'PROJ-1'], ticketSources: { 'PROJ-2': 'branch', 'PROJ-1': 'commit' } });
  await push(alice, 'a2', day('17'), day('17', '10'), { ticketRefs: [], ticketSources: {} });
  await push(bob, 'b2', day('18'), day('18', '10'), { ticketRefs: ['PROJ-3'], ticketSources: { 'PROJ-3': 'manual' } });
  await push(alice, 'a3', day('31'), day('31', '10'), { ticketRefs: [], ticketSources: {} });
});

describe('ticketReport', () => {
  it('groups summaries by the sprint containing their start, then by ticket, with unlinked ones apart', async () => {
    const report = await ticketReport(store, REPO, { from: day('01', '00'), to: '2026-04-01T00:00:00.000Z' });
    expect(shape(report)).toEqual({
      'Sprint 1': { 'PROJ-1': ['a1', 'b1'], 'PROJ-2': ['b1'] },
      'Sprint 2': { 'PROJ-3': ['b2'], unlinked: ['a2'] },
      '(no sprint)': { unlinked: ['a3'] },
    });
    expect(report).toMatchObject({ repoId: REPO, summaryCount: 5, developerCount: 2 });
    expect(report.sprints[0]!.sprint).toEqual({ name: 'Sprint 1', from: day('02', '00'), to: day('16', '00') });
  });

  it('says where each link came from, and who added a manual one and when', async () => {
    await store.addTicketLink(alice, ref('a2'), 'OPS-9');
    const report = await ticketReport(store, REPO, { sprint: 'Sprint 2' });
    const links = report.sprints.flatMap((g) => g.tickets.flatMap((t) => t.summaries.map((e) => e.link)));
    expect(links).toEqual([
      { sessionId: 'a2', ticketKey: 'OPS-9', source: 'manual', addedBy: 'alice', addedAt: '2026-03-20T12:00:00.000Z' },
      { sessionId: 'b2', ticketKey: 'PROJ-3', source: 'manual', addedBy: 'bob', addedAt: '2026-10-29T12:00:00.000Z' },
    ]);
    expect(shape(report)).toEqual({ 'Sprint 2': { 'OPS-9': ['a2'], 'PROJ-3': ['b2'] } });
    const sprint1 = await ticketReport(store, REPO, { sprint: 'Sprint 1' });
    expect(sprint1.sprints[0]!.tickets.find((t) => t.key === 'PROJ-1')!.summaries.map((e) => e.link.source)).toEqual(['branch', 'commit']);
  });

  it("puts a ticket the tracker knows in the tracker's sprint, or in no sprint, whatever the session dates", async () => {
    await store.saveTrackerTickets(REPO, [
      { key: 'PROJ-2', title: 'Search speed', sprint: 'Sprint 2' },
      { key: 'PROJ-3', title: 'Someday', sprint: null },
      { key: 'PROJ-9', title: 'Not in any summary', sprint: 'Sprint 1' },
    ]);
    const report = await ticketReport(store, REPO, { from: day('01', '00'), to: '2026-04-01T00:00:00.000Z' });
    expect(shape(report)).toEqual({
      'Sprint 1': { 'PROJ-1': ['a1', 'b1'] },
      'Sprint 2': { 'PROJ-2': ['b1'], unlinked: ['a2'] },
      '(no sprint)': { 'PROJ-3': ['b2'], unlinked: ['a3'] },
    });
    expect(report.sprints[1]!.tickets[0]).toMatchObject({ key: 'PROJ-2', title: 'Search speed' });
    expect(report.sprints[0]!.tickets[0]).toMatchObject({ key: 'PROJ-1', title: null });
  });

  it('lists a tracker sprint that has no dates after the dated ones', async () => {
    await store.saveTrackerTickets(REPO, [{ key: 'PROJ-1', title: 'Login', sprint: 'Hardening' }]);
    const report = await ticketReport(store, REPO, { sprint: 'Hardening' });
    expect(report.sprints.map((g) => g.sprint)).toEqual([{ name: 'Hardening', from: null, to: null }]);
    expect(shape(report)).toEqual({ Hardening: { 'PROJ-1': ['a1', 'b1'] } });
  });

  it('selects by date range with the usual overlap rule, so a range in Sprint 2 still shows the boundary session under Sprint 1', async () => {
    const report = await ticketReport(store, REPO, { from: day('16', '00'), to: day('17', '00') });
    expect(shape(report)).toEqual({ 'Sprint 1': { 'PROJ-1': ['b1'], 'PROJ-2': ['b1'] } });
  });

  it('returns no groups for an empty selection', async () => {
    expect(await ticketReport(store, REPO, { sprint: 'Sprint 9' })).toMatchObject({ summaryCount: 0, developerCount: 0, sprints: [] });
  });

  it('uses a title set by hand when the tracker has none, and the tracker title when it has one (DECISIONS.md D67)', async () => {
    await store.setTicketTitle(alice, 'PROJ-1', 'Login hardening');
    await store.setTicketTitle(alice, 'PROJ-2', 'Hand title');
    await store.saveTrackerTickets(REPO, [{ key: 'PROJ-2', title: 'Search speed', sprint: 'Sprint 1' }]);
    const report = await ticketReport(store, REPO, { sprint: 'Sprint 1' });
    const titles = Object.fromEntries(report.sprints.flatMap((g) => g.tickets.map((t) => [t.key, t.title])));
    expect(titles).toEqual({ 'PROJ-1': 'Login hardening', 'PROJ-2': 'Search speed' });
  });
});
