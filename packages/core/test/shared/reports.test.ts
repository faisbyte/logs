import { describe, expect, it } from 'vitest';
import type { DigestOutput } from '../../src/digest/generate.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { monthStart, onDemandReport, periodKey } from '../../src/shared/reports.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { payloadFor } from './store-contract.js';

// On-demand reports (DECISIONS.md D53): cached by period, input hash, prompt version and model, under a
// per-repo monthly LLM cost cap.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const range = { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };
const output: DigestOutput = {
  overview: 'Login is safer.',
  tickets: [{ key: 'PROJ-142', achieved: 'Repeated login attempts are limited.', aiInvolvement: 'AI wrote most of it.', keyDecisions: [] }],
  otherWork: null,
  risksAndOpenQuestions: [],
};
const now = () => new Date('2026-03-20T12:00:00.000Z');

async function setup(llmReplies: string[] = [JSON.stringify(output)]) {
  const store = new InMemorySummaryStore({ now });
  await store.push(alice, payloadFor());
  const llm = new FakeLlmClient(llmReplies, 'claude-sonnet-5-5');
  return { store, llm, deps: { store, llm, model: 'claude-sonnet-5-5', defaultCapUsd: 10, now } };
}

describe('onDemandReport', () => {
  it('generates a report once and serves it from the cache until the input changes', async () => {
    const { store, llm, deps } = await setup([JSON.stringify(output), JSON.stringify(output)]);
    const first = await onDemandReport(deps, REPO, range);
    expect(first).toMatchObject({ status: 'ok', cached: false, digest: { kind: 'report', status: 'ready', periodKey: periodKey(range), summaryCount: 1 } });
    expect(await onDemandReport(deps, REPO, range)).toMatchObject({ status: 'ok', cached: true, digest: { id: (first as { digest: { id: string } }).digest.id } });
    expect(llm.requests).toHaveLength(1);
    await store.saveTrackerTickets(REPO, [{ key: 'PROJ-142', title: 'Rate limit login', sprint: null }]);
    expect(await onDemandReport(deps, REPO, range)).toMatchObject({ status: 'ok', cached: false });
    expect(llm.requests).toHaveLength(2);
  });

  it('records what each report cost, and refuses once the monthly cap would be passed, without calling the model', async () => {
    const { store, llm, deps } = await setup();
    await store.recordSpend(REPO, 9.99, '2026-03-05T00:00:00.000Z');
    await store.recordSpend(REPO, 50, '2026-02-27T00:00:00.000Z'); // last month
    const refused = await onDemandReport(deps, REPO, range);
    expect(refused).toEqual({
      status: 'cap-reached',
      reason: expect.stringMatching(/^This repo has reached its monthly LLM cost cap: \$9\.99 of \$10\.00 spent since 2026-03-01 \(UTC\), and this report could cost up to \$0\.\d{2}\. A digest-server admin can raise it with digest-server repo --cap-usd\.$/),
    });
    expect(llm.requests).toEqual([]);
    await store.saveRepoSettings(REPO, { monthlyCapUsd: 20 });
    expect(await onDemandReport(deps, REPO, range)).toMatchObject({ status: 'ok' });
    expect(await store.spendSince(REPO, monthStart(now()))).toBeGreaterThan(9.99);
  });

  it('counts the cost of a report that failed its checks', async () => {
    const bad = JSON.stringify({ ...output, overview: 'PROJ-999 too.' });
    const { store, deps } = await setup([bad, bad]);
    expect(await onDemandReport(deps, REPO, range)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/failed its checks twice/) });
    expect(await store.spendSince(REPO, monthStart(now()))).toBeGreaterThan(0);
    expect(await store.digests(REPO)).toEqual([]);
  });

  it('still serves cached reports without a model, and says why it can not write new ones', async () => {
    const { deps } = await setup();
    await onDemandReport(deps, REPO, range);
    const noModel = { ...deps, llm: null };
    expect(await onDemandReport(noModel, REPO, range)).toMatchObject({ status: 'ok', cached: true });
    expect(await onDemandReport(noModel, REPO, { sprint: 'Sprint 9' })).toMatchObject({ status: 'ok', cached: false, digest: { summaryCount: 0 } });
    const store2 = new InMemorySummaryStore({ now });
    await store2.push(alice, payloadFor());
    expect(await onDemandReport({ ...noModel, store: store2 }, REPO, range)).toEqual({ status: 'unavailable', reason: 'The digest server has no ANTHROPIC_API_KEY, so it can only serve reports it has already written.' });
  });

  it('periods: one key per sprint or exact range, months in UTC', () => {
    expect(periodKey({ sprint: 'Sprint 1' })).toBe('sprint:Sprint 1');
    expect(periodKey(range)).toBe('range:2026-03-01T00:00:00.000Z/2026-04-01T00:00:00.000Z');
    expect(monthStart(new Date('2026-03-31T23:59:59.000Z'))).toBe('2026-03-01T00:00:00.000Z');
  });
});
