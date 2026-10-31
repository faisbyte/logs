import { describe, expect, it } from 'vitest';
import { assertDigestSource, digestInput, isDigestInput } from '../../src/digest/input.js';
import { redactSession } from '../../src/redact/session.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { ticketReport } from '../../src/shared/ticket-report.js';
import { guardRequest } from '../../src/summarize/llm.js';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { claude } from '../fixtures.js';
import { payloadFor } from '../shared/store-contract.js';

// What a digest is written from (DECISIONS.md D49): the shared narrative of approved summaries, grouped by ticket.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
const at = (d: string) => `2026-03-${d}T09:00:00.000Z`;

async function report() {
  const store = new InMemorySummaryStore();
  await store.saveSprint(REPO, { name: 'Sprint 1', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
  await store.saveTrackerTickets(REPO, [{ key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 1' }]);
  await store.push(alice, payloadFor({ sessionId: 'a1', startedAt: at('03'), endedAt: at('03'), aiInvolvement: 'heavy' }));
  await store.push(bob, payloadFor({ sessionId: 'b1', startedAt: at('04'), endedAt: at('04'), aiInvolvement: 'light', goal: 'Tune the limiter window.' }));
  await store.push(bob, payloadFor({ sessionId: 'b2', startedAt: at('05'), endedAt: at('05'), aiInvolvement: 'moderate', ticketRefs: [], branch: 'main', goal: 'Clean up logging.' }));
  return { store, report: await ticketReport(store, REPO, { sprint: 'Sprint 1' }) };
}

describe('digestInput', () => {
  it('keeps the shared narrative per ticket, with titles, and leaves out who did the work', async () => {
    const input = digestInput((await report()).report);
    expect(input.period).toEqual({ label: 'Sprint 1 (2026-03-02 to 2026-03-15)', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
    expect(input.coverage).toEqual({ summaryCount: 3, developerCount: 2 });
    expect(input.tickets.map((t) => [t.key, t.title, t.work.map((w) => w.goal)])).toEqual([['PROJ-142', 'Rate limit login', ['Rate limit the login endpoint.', 'Tune the limiter window.']]]);
    expect(input.unlinked.map((w) => w.goal)).toEqual(['Clean up logging.']);
    const text = JSON.stringify({ ...input, hash: undefined });
    for (const hidden of ['alice', 'Alice', 'Bob', 'a1', 'b1', 'src/middleware', 'feature/PROJ-142']) expect(text).not.toContain(hidden);
  });

  it('gives each ticket the most common AI involvement of its work, the higher one on a tie', async () => {
    expect(digestInput((await report()).report).tickets[0]!.aiInvolvement).toBe('heavy');
  });

  it('merges a ticket that appears in more than one sprint group', async () => {
    const { store } = await report();
    await store.saveTrackerTickets(REPO, [{ key: 'OPS-1', title: null, sprint: 'Later' }]);
    await store.addTicketLink(bob, { agent: 'claude-code', sessionId: 'b1' }, 'OPS-1');
    await store.push(alice, payloadFor({ sessionId: 'a2', startedAt: at('20'), endedAt: at('20'), ticketRefs: ['OPS-1'], branch: 'ops' }));
    const input = digestInput(await ticketReport(store, REPO, { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }));
    expect(input.tickets.map((t) => [t.key, t.work.length])).toEqual([['OPS-1', 2], ['PROJ-142', 2]]);
    expect(input.period.label).toBe('2026-03-01 to 2026-03-31');
  });

  it('has a hash that changes with the content and nothing else', async () => {
    const first = digestInput((await report()).report);
    expect(digestInput((await report()).report).hash).toBe(first.hash);
    const { store } = await report();
    await store.saveTrackerTickets(REPO, [{ key: 'PROJ-142', title: 'Rate limit sign-in', sprint: 'Sprint 1' }]);
    expect(digestInput(await ticketReport(store, REPO, { sprint: 'Sprint 1' })).hash).not.toBe(first.hash);
  });

  it('is frozen and branded, and is the only non-session input an LLM request accepts', async () => {
    const input = digestInput((await report()).report);
    expect(isDigestInput(input)).toBe(true);
    expect(Object.isFrozen(input.tickets[0]!.work[0])).toBe(true);
    expect(() => assertDigestSource({ ...input })).toThrow(/digestInput/);
    const request = (source: unknown) => ({ source, system: 's', messages: [], schema: {} as never, maxTokens: 1 }) as never;
    expect(() => guardRequest(request(input))).not.toThrow();
    expect(() => guardRequest(request(redactSession(parseClaudeCodeFile(claude.basic)!)))).not.toThrow();
    expect(() => guardRequest(request({ tickets: [] }))).toThrow();
  });

  it('keeps one timeline of all work, oldest first, with dates and tickets, and nothing about who (DECISIONS.md D65)', async () => {
    const input = digestInput((await report()).report);
    expect(input.timeline.map((w) => [w.from, w.to, w.tickets, w.goal])).toEqual([
      ['2026-03-03', '2026-03-03', ['PROJ-142'], 'Rate limit the login endpoint.'],
      ['2026-03-04', '2026-03-04', ['PROJ-142'], 'Tune the limiter window.'],
      ['2026-03-05', '2026-03-05', [], 'Clean up logging.'],
    ]);
  });
});
