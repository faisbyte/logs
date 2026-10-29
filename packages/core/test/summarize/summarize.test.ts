import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { parseCodexFile } from '../../src/parsers/codex.js';
import { redactSession, type RedactedSession } from '../../src/redact/session.js';
import { chunkTurns, condenseSession, estimateTokens } from '../../src/summarize/condense.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import type { LlmRequest } from '../../src/summarize/llm.js';
import { mergeSystemPrompt, PROMPT_VERSION } from '../../src/summarize/prompt.js';
import { coverParts, summarizeSession } from '../../src/summarize/summarize.js';
import { claude, codex } from '../fixtures.js';
import { llmSummary, pickAll } from './helpers.js';

const redacted = (file: string) => redactSession((parseClaudeCodeFile(file) ?? parseCodexFile(file))!, { home: false });
const json = (o: object) => JSON.stringify(o);
const options = { chunkTokens: 60_000, now: () => new Date('2026-10-28T10:00:00.000Z') };

describe('summarizeSession (one chunk)', () => {
  it('sends system prompt, metadata and condensed transcript, and builds a draft summary', async () => {
    const llm = new FakeLlmClient([json(llmSummary())], 'claude-haiku-5-5');
    const summary = await summarizeSession(redacted(claude.basic), llm, options);

    const [request] = llm.requests;
    expect(request!.system).toContain('You are summarising one AI coding session for a team log.');
    expect(request!.messages[0]!.content).toContain('Branch: feature/PROJ-142-rate-limit');
    expect(request!.messages[0]!.content).toContain('TOOL Write src/middleware/rateLimit.ts');
    expect(summary).toMatchObject({
      status: 'draft',
      goal: 'Rate limit the login endpoint.',
      filesTouched: ['src/middleware/rateLimit.ts', 'src/routes/login.ts'],
      ticketRefs: ['PROJ-142'],
      promptVersion: PROMPT_VERSION,
      model: 'claude-haiku-5-5',
      generatedAt: '2026-10-28T10:00:00.000Z',
    });
    expect(summary.usage.requests).toBe(1);
    expect(summary.usage.costUsd).toBeGreaterThan(0);
  });

  it('retries once with the validation error and the previous reply', async () => {
    const llm = new FakeLlmClient(['not json at all', json(llmSummary())]);
    const summary = await summarizeSession(redacted(claude.basic), llm, options);
    expect(summary.goal).toBe('Rate limit the login endpoint.');
    const retry = llm.requests[1]!;
    expect(retry.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(retry.messages[1]!.content).toBe('not json at all');
    expect(retry.messages[2]!.content).toMatch(/not valid JSON/);
    expect(summary.usage.requests).toBe(2);
  });

  it('names schema violations in the retry', async () => {
    const { outcome: _missing, ...noOutcome } = llmSummary();
    const llm = new FakeLlmClient([json(noOutcome), json(llmSummary())]);
    await summarizeSession(redacted(claude.basic), llm, options);
    expect(llm.requests[1]!.messages[2]!.content).toContain('outcome');
  });

  it('retries when the post-check finds a code block or a placeholder', async () => {
    const llm = new FakeLlmClient([json(llmSummary({ whatWasDone: 'Ran ```pnpm test```' })), json(llmSummary())]);
    await summarizeSession(redacted(claude.basic), llm, options);
    expect(llm.requests[1]!.messages[2]!.content).toContain('whatWasDone contains a code block');
  });

  it('treats a reply cut off at max_tokens as invalid', async () => {
    const llm = new FakeLlmClient([{ text: '{"goal": "Rate li', stopReason: 'max_tokens' }, json(llmSummary())]);
    await summarizeSession(redacted(claude.basic), llm, options);
    expect(llm.requests[1]!.messages[2]!.content).toMatch(/cut off/);
  });

  it('fails with a clear message after a second invalid reply', async () => {
    const llm = new FakeLlmClient(['nope', 'still nope']);
    await expect(summarizeSession(redacted(claude.basic), llm, options)).rejects.toThrow(
      /Summary for c1a5e001-0000-4000-8000-000000000001 failed validation twice: .*not valid JSON/,
    );
  });

  it('fails without retrying when the model refuses', async () => {
    const llm = new FakeLlmClient([{ text: '', stopReason: 'refusal' }, json(llmSummary())]);
    await expect(summarizeSession(redacted(claude.basic), llm, options)).rejects.toThrow(/refused/);
    expect(llm.requests).toHaveLength(1);
  });

  it('refuses empty sessions and anything that is not a RedactedSession', async () => {
    const llm = new FakeLlmClient([json(llmSummary())]);
    await expect(summarizeSession(redacted(codex.empty), llm, options)).rejects.toThrow(/empty/);
    const raw = parseClaudeCodeFile(claude.basic)! as unknown as RedactedSession;
    await expect(summarizeSession(raw, llm, options)).rejects.toThrow(/unredacted/);
    expect(llm.requests).toEqual([]);
  });

  it('reports unknown cost for a model without a price', async () => {
    const summary = await summarizeSession(redacted(claude.basic), new FakeLlmClient([json(llmSummary())], 'mystery-model'), options);
    expect(summary.usage.costUsd).toBeNull();
  });
});

describe('summarizeSession (long sessions in chunks)', () => {
  const messy = redacted(claude.messy);
  const turns = condenseSession(messy).turns;
  // Big enough for the first turn alone, so the Redis turn and the "No Redis" turn land in different chunks.
  const chunkTokens = estimateTokens(turns[0]!);

  const script = (request: LlmRequest) => {
    const content = request.messages[0]!.content;
    if (request.system.startsWith('You are merging')) return pickAll(request);
    if (/Transcript \(part 1 of/.test(content)) {
      return json(llmSummary({ goal: 'Speed up search.', whatWasDone: 'Added a Redis cache.', decisions: [{ decision: 'Put a Redis cache in front of search', reason: 'The query runs on every keystroke.' }], risksOrFollowUps: [] }));
    }
    if (!content.includes('USER: No Redis')) {
      return json(llmSummary({ goal: 'Speed up search.', outcome: 'partial', whatWasDone: 'Continued the search work.', decisions: [], risksOrFollowUps: [] }));
    }
    return json(
      llmSummary({
        goal: 'Speed up search.',
        outcome: 'partial',
        whatWasDone: 'Removed the cache and wrote a trigram migration.',
        decisions: [{ decision: 'Use a Postgres trigram index', reason: 'No extra service to run.' }],
        reversedDecisions: [{ id: 'D1', reason: "Ops won't run another service." }],
        risksOrFollowUps: ['The trigram migration is unfinished and a ranking test fails.'],
      }),
    );
  };

  it('splits the session into several chunks', () => {
    expect(chunkTurns(turns, chunkTokens).length).toBeGreaterThan(1);
  });

  it('turns a decision reversed in a later part into a rejected approach, not a decision', async () => {
    const llm = new FakeLlmClient(script);
    const summary = await summarizeSession(messy, llm, { ...options, chunkTokens });
    expect(summary.decisions).toEqual([{ decision: 'Use a Postgres trigram index', reason: 'No extra service to run.' }]);
    expect(summary.rejectedApproaches).toContainEqual({ approach: 'Put a Redis cache in front of search', reason: "Ops won't run another service." });
    expect(JSON.stringify(summary.decisions)).not.toContain('Redis');
  });

  it('tells later parts about earlier decisions by id', async () => {
    const llm = new FakeLlmClient(script);
    await summarizeSession(messy, llm, { ...options, chunkTokens });
    expect(llm.requests[1]!.messages[0]!.content).toContain('D1: Put a Redis cache in front of search');
    expect(llm.requests[1]!.messages[0]!.content).toMatch(/Transcript \(part 2 of \d\)/);
  });

  it('merges the narrative in one final call and sums usage across every request', async () => {
    const llm = new FakeLlmClient(script);
    const summary = await summarizeSession(messy, llm, { ...options, chunkTokens });
    const merge = llm.requests.at(-1)!;
    expect(merge.system).toMatch(/^You are merging/);
    expect(merge.messages[0]!.content).toContain('Removed the cache and wrote a trigram migration.');
    expect(summary).toMatchObject({ goal: 'Speed up search.', whatWasDone: 'Tried a cache, then moved to a trigram index.' });
    expect(summary.risksOrFollowUps).toEqual(['The trigram migration is unfinished and a ranking test fails.']);
    expect(summary.usage.requests).toBe(llm.requests.length);
  });

  it('ignores reversals of ids that were never recorded', async () => {
    const llm = new FakeLlmClient((request) =>
      request.system.startsWith('You are merging') ? pickAll(request) : json(llmSummary({ reversedDecisions: [{ id: 'D99', reason: 'x' }] })),
    );
    const summary = await summarizeSession(messy, llm, { ...options, chunkTokens });
    expect(summary.rejectedApproaches).toEqual([]);
    expect(summary.decisions.length).toBeGreaterThan(0);
  });

  it('makes no merge call for a session that fits in one chunk', async () => {
    const llm = new FakeLlmClient([json(llmSummary())]);
    await summarizeSession(messy, llm, options);
    expect(llm.requests).toHaveLength(1);
  });
});

describe('summarizeSession (merging distills rather than concatenates)', () => {
  const long = redacted(claude.long);
  const chunkTokens = 1_000;
  const many = (prefix: string, part: string) => Array.from({ length: 5 }, (_, i) => `${prefix} ${i + 1} from ${part}`);
  const partReply = (request: LlmRequest, outcome: 'completed' | 'partial' = 'completed') => {
    const part = /Transcript \(part (\d+) of/.exec(request.messages[0]!.content)![1]!;
    return json(
      llmSummary({
        outcome,
        whatWasDone: `Part ${part}: ${'Added audit logging to more admin endpoints and their tests. '.repeat(4)}`,
        decisions: many('Decision', `part ${part}`).map((decision) => ({ decision, reason: 'because' })),
        rejectedApproaches: many('Approach', `part ${part}`).map((approach) => ({ approach, reason: 'because' })),
        risksOrFollowUps: many('Follow-up', `part ${part}`),
      }),
    );
  };
  const mergeNarrative = { goal: 'Add audit logging to admin actions.', whatWasDone: 'Added audit logging to every admin area, with tests.', aiInvolvement: 'heavy' };

  it('has many parts to merge', () => {
    expect(chunkTurns(condenseSession(long).turns, chunkTokens).length).toBeGreaterThan(5);
  });

  it('caps each list at 6 items chosen by the merge, and is about as long as a single-part summary', async () => {
    const llm = new FakeLlmClient((request) => (request.system.startsWith('You are merging') ? pickAll(request, mergeNarrative) : partReply(request)));
    const merged = await summarizeSession(long, llm, { ...options, chunkTokens });
    expect(merged.decisions.length).toBeLessThanOrEqual(6);
    expect(merged.rejectedApproaches.length).toBeLessThanOrEqual(6);
    expect(merged.risksOrFollowUps.length).toBeLessThanOrEqual(6);

    const single = JSON.parse(partReply(llm.requests[0]!));
    const size = (s: { goal: string; whatWasDone: string; decisions: unknown[]; rejectedApproaches: unknown[]; risksOrFollowUps: unknown[] }) =>
      JSON.stringify([s.goal, s.whatWasDone, s.decisions, s.rejectedApproaches, s.risksOrFollowUps]).length;
    expect(size(merged)).toBeLessThan(size(single) * 1.5);
  });

  it('offers each candidate once, removing exact duplicates across parts', async () => {
    const llm = new FakeLlmClient((request) =>
      request.system.startsWith('You are merging') ? pickAll(request, mergeNarrative) : json(llmSummary({ risksOrFollowUps: ['Same risk everywhere'] })),
    );
    await summarizeSession(long, llm, { ...options, chunkTokens });
    expect(llm.requests.at(-1)!.messages[0]!.content.match(/Same risk everywhere/g)).toHaveLength(1);
  });

  it.each([
    ['more than 6 items', { decisionIds: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'], rejectedApproachIds: [], followUpIds: [] }, 'decisionIds'],
    ['an id that was not offered', { decisionIds: [], rejectedApproachIds: ['R999'], followUpIds: [] }, 'R999 was not offered'],
  ])('retries when the merge picks %s', async (_label, bad, expected) => {
    let merges = 0;
    const llm = new FakeLlmClient((request) => {
      if (!request.system.startsWith('You are merging')) return partReply(request);
      return ++merges === 1 ? json({ ...mergeNarrative, ...bad }) : pickAll(request, mergeNarrative);
    });
    await summarizeSession(long, llm, { ...options, chunkTokens });
    expect(llm.requests.at(-1)!.messages.at(-1)!.content).toContain(expected);
  });

  it('takes the outcome from the last part, the end state of the session', async () => {
    const parts = chunkTurns(condenseSession(long).turns, chunkTokens).length;
    const llm = new FakeLlmClient((request) => {
      if (request.system.startsWith('You are merging')) return pickAll(request, mergeNarrative);
      return partReply(request, request.messages[0]!.content.includes(`(part ${parts} of`) ? 'abandoned' : 'completed');
    });
    expect((await summarizeSession(long, llm, { ...options, chunkTokens })).outcome).toBe('abandoned');
  });
});

describe('summarizeSession (the merge covers every part)', () => {
  const long = redacted(claude.long);
  const isMerge = (request: LlmRequest) => request.system.startsWith('You are merging');
  const partOf = (request: LlmRequest) => /Transcript \(part (\d+) of/.exec(request.messages[0]!.content)![1]!;
  const partReply = (request: LlmRequest, has: (part: number) => boolean = () => true) => {
    const part = partOf(request);
    const items = (prefix: string) => (has(Number(part)) ? [1, 2].map((i) => `${prefix} ${i} from part ${part}`) : []);
    return json(
      llmSummary({
        decisions: items('Decision').map((decision) => ({ decision, reason: 'because' })),
        rejectedApproaches: items('Approach').map((approach) => ({ approach, reason: 'because' })),
        risksOrFollowUps: items('Follow-up'),
      }),
    );
  };
  // A recency-biased merge: picks only the last 6 candidates of each list.
  const latestSix = (request: LlmRequest) => {
    const ids = (prefix: string) => [...request.messages[0]!.content.matchAll(new RegExp(`^(${prefix}\\d+) `, 'gm'))].map((m) => m[1]!).slice(-6);
    return json({ goal: 'g', whatWasDone: 'w', aiInvolvement: 'heavy', decisionIds: ids('D'), rejectedApproachIds: ids('R'), followUpIds: ids('F') });
  };
  const fromParts = (items: string[]) => [...new Set(items.map((t) => /from part (\d+)/.exec(t)![1]))].map(Number).sort((a, b) => a - b);

  /** The long fixture with its second half moved 20 hours later: two work periods. */
  function twoPeriods(): RedactedSession {
    const s = parseClaudeCodeFile(claude.long)!;
    const half = s.transcript.indexOf(s.transcript.filter((e) => e.kind === 'user')[30]!);
    const shift = (iso: string) => new Date(Date.parse(iso) + 20 * 3_600_000).toISOString();
    return redactSession({ ...s, endedAt: shift(s.endedAt), transcript: s.transcript.map((e, i) => (i >= half ? { ...e, timestamp: shift(e.timestamp) } : e)) }, { home: false });
  }

  it('labels each part with its work period and each candidate with its part', async () => {
    const session = twoPeriods();
    const llm = new FakeLlmClient((r) => (isMerge(r) ? latestSix(r) : partReply(r)));
    await summarizeSession(session, llm, { ...options, chunkTokens: 2_000 });
    const merge = llm.requests.at(-1)!.messages[0]!.content;
    expect(merge).toMatch(/^Part 1 of \d+ \(work period 1 of 2\):/m);
    expect(merge).toMatch(/^Part \d+ of \d+ \(work period 2 of 2\):/m);
    expect(merge).toContain('D1 (part 1): Decision 1 from part 1 (reason: because)');
    expect(merge).toContain('R1 (part 1): Approach 1 from part 1 (reason: because)');
    expect(merge).toContain('F1 (part 1): Follow-up 1 from part 1');
  });

  it('tells the merge to cover every work period and to pick from every part', () => {
    expect(mergeSystemPrompt()).toContain('"goal" and "whatWasDone" must cover every work period');
    expect(mergeSystemPrompt()).toContain('at least one id from each part that has candidates in that list');
  });

  it('gives every part with candidates at least one pick in each list, still at most 6', async () => {
    const llm = new FakeLlmClient((r) => (isMerge(r) ? latestSix(r) : partReply(r)));
    const summary = await summarizeSession(long, llm, { ...options, chunkTokens: 2_000 });
    expect(llm.requests.filter((r) => !isMerge(r))).toHaveLength(4);
    for (const list of [summary.decisions.map((d) => d.decision), summary.rejectedApproaches.map((r) => r.approach), summary.risksOrFollowUps]) {
      expect(fromParts(list)).toEqual([1, 2, 3, 4]);
      expect(list.length).toBeLessThanOrEqual(6);
    }
  });

  it('only guarantees picks for parts that offered candidates', async () => {
    const llm = new FakeLlmClient((r) => (isMerge(r) ? latestSix(r) : partReply(r, (part) => part === 1 || part === 4)));
    const summary = await summarizeSession(long, llm, { ...options, chunkTokens: 2_000 });
    expect(fromParts(summary.decisions.map((d) => d.decision))).toEqual([1, 4]);
  });

  it("keeps the model's picks, in session order, when they already cover every part", async () => {
    const firstOfEach = (request: LlmRequest) => {
      const ids = (prefix: string) => [...request.messages[0]!.content.matchAll(new RegExp(`^(${prefix}\\d+) .*?: \\w+ 1 from`, 'gm'))].map((m) => m[1]!).reverse();
      return json({ goal: 'g', whatWasDone: 'w', aiInvolvement: 'heavy', decisionIds: ids('D'), rejectedApproachIds: ids('R'), followUpIds: ids('F') });
    };
    const llm = new FakeLlmClient((r) => (isMerge(r) ? firstOfEach(r) : partReply(r)));
    const summary = await summarizeSession(long, llm, { ...options, chunkTokens: 2_000 });
    expect(summary.decisions.map((d) => d.decision)).toEqual([1, 2, 3, 4].map((p) => `Decision 1 from part ${p}`));
  });

  it('covers each work period instead when more parts offer candidates than a list has slots', async () => {
    const session = twoPeriods();
    const llm = new FakeLlmClient((r) => (isMerge(r) ? latestSix(r) : partReply(r)));
    const summary = await summarizeSession(session, llm, { ...options, chunkTokens: 1_000 });
    const parts = llm.requests.filter((r) => !isMerge(r)).length;
    expect(parts).toBeGreaterThan(6);
    const firstPeriodParts = llm.requests.filter((r) => !isMerge(r) && !r.messages[0]!.content.includes('[resumed after')).length;
    const decisions = fromParts(summary.decisions.map((d) => d.decision));
    expect(decisions.some((p) => p <= firstPeriodParts)).toBe(true);
    expect(decisions.some((p) => p > firstPeriodParts)).toBe(true);
    expect(summary.decisions.length).toBeLessThanOrEqual(6);
  });
});

describe('coverParts', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({ id: `D${i + 1}`, part: i + 1, period: i + 1 }));

  it("leaves the model's picks alone when even the work periods outnumber the slots", () => {
    expect(coverParts(['D8', 'D7'], candidates).map((c) => c.id)).toEqual(['D7', 'D8']);
  });

  it('ignores repeated picks', () => {
    expect(coverParts(['D1', 'D1'], candidates.slice(0, 2)).map((c) => c.id)).toEqual(['D1', 'D2']);
  });
});
