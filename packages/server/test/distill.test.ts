import { FakeLlmClient, InMemorySummaryStore, type LlmRequest } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import { distill, distillNeedsAttention } from '../src/distill.js';

// sprintdigest-server context distill (DECISIONS.md D74 option B, D82): a batch over every repo's approved summaries
// not yet distilled, under the monthly cost cap, run by cron like send-due.

const REPO = 'github.com/acme/webapp';
const API = 'github.com/acme/api';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
const now = () => new Date('2026-03-20T12:00:00.000Z');

/** One item per call, from the call's first summary, worded per call so nothing merges. */
const replies = (request: LlmRequest, call: number) => {
  const text = (request.messages[0]!.content as string).match(/^S1 .*\nGoal: (.*)$/m)?.[1] ?? 'unknown';
  return JSON.stringify({ items: [{ type: 'convention', text: `Convention ${call + 1} records that ${text.replace(/\.$/, '').toLowerCase()} works.`, reason: 'The summary says so.', paths: ['src/routes'], sources: ['S1'], supersedes: [] }] });
};

async function setup() {
  const store = new InMemorySummaryStore({ now });
  await store.push(alice, payloadFor({ sessionId: 'a1', goal: 'Rate limit login.', startedAt: '2026-03-03T09:00:00.000Z', endedAt: '2026-03-03T10:00:00.000Z' }));
  await store.push(bob, payloadFor({ sessionId: 'b1', goal: 'Lock accounts.', startedAt: '2026-03-04T09:00:00.000Z', endedAt: '2026-03-04T10:00:00.000Z' }));
  await store.push(alice, payloadFor({ sessionId: 'a2', goal: 'Audit logins.', startedAt: '2026-03-05T09:00:00.000Z', endedAt: '2026-03-05T10:00:00.000Z' }));
  await store.push({ ...alice, repoId: API }, payloadFor({ sessionId: 'x1', goal: 'Version the API.' }));
  const llm = new FakeLlmClient(replies, 'claude-sonnet-5-5');
  return { store, llm, deps: { store, llm, model: 'claude-sonnet-5-5', defaultCapUsd: 10, now, batchSize: 2 } };
}

describe('distill', () => {
  it("reads every developer's undistilled summaries, oldest first in batches, and records each run", async () => {
    const { store, llm, deps } = await setup();
    const results = await distill(deps);
    expect(results.map((r) => [r.repoId, r.result.replace(/\$\d+\.\d+/, '$x')])).toEqual([
      [API, 'distilled 1 summary in 1 call: 1 added, 0 merged, 0 superseded, 0 dropped, $x'],
      [REPO, 'distilled 3 summaries in 2 calls: 2 added, 0 merged, 0 superseded, 0 dropped, $x'],
    ]);
    expect(llm.requests.map((r) => (r.messages[0]!.content as string).match(/^S\d .*\nGoal: .*$/gm)!.map((l) => l.split('\n')[1]))).toEqual([
      ['Goal: Version the API.'],
      ['Goal: Rate limit login.', 'Goal: Lock accounts.'],
      ['Goal: Audit logins.'],
    ]);
    expect((await store.contextItems(REPO)).map((i) => i.sources)).toEqual([['claude-code/a2'], ['claude-code/a1']]);
    const runs = await store.contextRuns(REPO);
    expect(runs).toHaveLength(2);
    expect(runs.flatMap((r) => r.summaries.map((s) => s.key)).sort()).toEqual(['claude-code/a1', 'claude-code/a2', 'claude-code/b1']);
    expect(await store.spendSince(REPO, '2026-03-01T00:00:00.000Z')).toBeGreaterThan(0);
  });

  it('does nothing on a repeat run, and reads a summary again once it is re-pushed with new content', async () => {
    const { store, llm, deps } = await setup();
    await distill(deps);
    const calls = llm.requests.length;
    expect((await distill(deps)).map((r) => r.result)).toEqual(['nothing new', 'nothing new']);
    expect(llm.requests).toHaveLength(calls);
    await store.retract(alice, { agent: 'claude-code', sessionId: 'a2' });
    await store.push(alice, payloadFor({ sessionId: 'a2', goal: 'Audit logins properly.', startedAt: '2026-03-05T09:00:00.000Z', endedAt: '2026-03-05T10:00:00.000Z' }));
    expect((await distill(deps)).find((r) => r.repoId === REPO)!.result).toMatch(/^distilled 1 summary in 1 call/);
  });

  it('says what made a call retry, and stores it with the run', async () => {
    const { store, deps } = await setup();
    const bad = JSON.stringify({ items: [{ type: 'decision', text: 'See https://example.com for the limits.', reason: 'Docs.', paths: [], sources: ['S1'], supersedes: [] }] });
    const llm = new FakeLlmClient((request, call) => (call === 0 ? bad : replies(request, call)), 'claude-sonnet-5-5');
    const results = await distill({ ...deps, llm, batchSize: 10 });
    expect(results[0]!.result).toMatch(/; retried once: items\.0: text: contains a URL$/);
    expect((await store.contextRuns(API))[0]!.retryReasons).toEqual(['items.0: text: contains a URL']);
    expect(distillNeedsAttention(results[0]!.result)).toBe(false);
  });

  it('counts the items nothing in their sources backs, in the result and the run (DECISIONS.md D86)', async () => {
    const { store, deps } = await setup();
    const invented = JSON.stringify({ items: [{ type: 'pitfall', text: 'Counting logins per IP address was rejected.', reason: 'Offices share one address.', paths: [], sources: ['S1'], supersedes: [] }] });
    const results = await distill({ ...deps, llm: new FakeLlmClient(() => invented, 'claude-sonnet-5-5'), batchSize: 10 });
    expect(results[0]!.result).toMatch(/: 0 added, 0 merged, 0 superseded, 1 dropped \(1 untraced\), \$/);
    expect((await store.contextRuns(API))[0]!.untraced).toBe(1);
  });

  it('stops at the cost cap and without a key, calling no model, and flags both for cron', async () => {
    const capped = await setup();
    await capped.store.recordSpend(REPO, 10, '2026-03-05T00:00:00.000Z');
    const results = await distill(capped.deps);
    const repo = results.find((r) => r.repoId === REPO)!.result;
    expect(repo).toMatch(/^not run: This repo has reached its monthly LLM cost cap/);
    expect(distillNeedsAttention(repo)).toBe(true);
    expect(await capped.store.contextRuns(REPO)).toEqual([]);

    const keyless = await setup();
    const none = await distill({ ...keyless.deps, llm: null });
    expect(none.map((r) => r.result)).toEqual(['not run: the server has no ANTHROPIC_API_KEY', 'not run: the server has no ANTHROPIC_API_KEY']);
    expect(distillNeedsAttention('nothing new')).toBe(false);
  });

  it('records the spend of a failed call, keeps its summaries for the next run, and flags it', async () => {
    const { store, deps } = await setup();
    const llm = new FakeLlmClient(['not json', 'still not json'], 'claude-sonnet-5-5');
    const [api] = await distill({ ...deps, llm });
    expect(api!.result).toBe('failed: Context extraction failed its checks twice: the reply was not valid JSON');
    expect(distillNeedsAttention(api!.result)).toBe(true);
    expect(await store.spendSince(API, '2026-03-01T00:00:00.000Z')).toBeGreaterThan(0);
    expect(await store.distilledSummaries(API)).toEqual([]);
  });
});
