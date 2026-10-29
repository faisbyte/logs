import { describe, expect, it } from 'vitest';
import { checkDigest, DigestBlockedError, DigestError, estimateDigestCost, generateDigest, type DigestOutput } from '../../src/digest/generate.js';
import { digestInput, type DigestInput } from '../../src/digest/input.js';
import { DIGEST_PROMPT_VERSION, digestSystemPrompt } from '../../src/digest/prompt.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { ticketReport } from '../../src/shared/ticket-report.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { payloadFor } from '../shared/store-contract.js';

// Digest generation (DECISIONS.md D50): the 6.2 prompt, structured output rendered to Markdown, a faithfulness
// post-check and a secret block.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
// Assembled at runtime so no literal secret sits in the source (fake value).
const fakeToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

async function input(withUnlinked = true): Promise<DigestInput> {
  const store = new InMemorySummaryStore();
  await store.saveSprint(REPO, { name: 'Sprint 1', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
  await store.saveTrackerTickets(REPO, [{ key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 1' }]);
  await store.push(alice, payloadFor({ sessionId: 'a1' }));
  await store.push(bob, payloadFor({ sessionId: 'b1', ticketRefs: ['PROJ-7'], branch: 'feature/PROJ-7-search', goal: 'Speed up search.', aiInvolvement: 'moderate' }));
  if (withUnlinked) await store.push(bob, payloadFor({ sessionId: 'b2', ticketRefs: [], branch: 'main', goal: 'Clean up logging.' }));
  return digestInput(await ticketReport(store, REPO, { sprint: 'Sprint 1' }));
}

const good = (over: Partial<DigestOutput> = {}): DigestOutput => ({
  overview: 'The team made login safer and search faster.',
  tickets: [
    { key: 'PROJ-7', achieved: 'Search results come back faster.', aiInvolvement: 'The AI wrote parts of the change.', keyDecisions: [] },
    { key: 'PROJ-142', achieved: 'Login now limits repeated attempts.', aiInvolvement: 'The AI wrote most of the change.', keyDecisions: ['Keep the limiter in memory, because there is only one server.'] },
  ],
  otherWork: 'Logging was tidied up.',
  risksAndOpenQuestions: ['The limiter will not hold once there is more than one server.'],
  ...over,
});
const llmWith = (...replies: DigestOutput[]) => new FakeLlmClient(replies.map((r) => JSON.stringify(r)), 'claude-sonnet-5-5');
const now = () => new Date('2026-03-16T08:00:00.000Z');

describe('digest prompt', () => {
  it('contains the Section 6.2 prompt from PROJECT_PLAN.md verbatim', () => {
    const prompt = digestSystemPrompt();
    for (const line of [
      'You are writing a sprint update for a product owner or scrum master who is not technical.',
      'Input: approved session summaries grouped by ticket, plus ticket titles.',
      '1. A 2–3 sentence overview of the period.',
      '2. One short section per ticket: what was achieved, how AI was involved (light/moderate/heavy, in plain words), key decisions in plain language.',
      '3. "Risks and open questions": a combined list.',
      'Rules: no code, no file paths unless essential, no jargon without a short explanation, no judgement of individual developers, no invented facts.',
    ]) {
      expect(prompt).toContain(line);
    }
    expect(DIGEST_PROMPT_VERSION).toBe('digest-v1');
  });
});

describe('generateDigest', () => {
  it('renders Markdown with ticket titles from the input, the AI involvement level and the coverage line', async () => {
    const llm = llmWith(good());
    const digest = await generateDigest(await input(), llm, { now });
    expect(digest.markdown).toBe(
      [
        '# AI work update: Sprint 1 (2026-03-02 to 2026-03-15)',
        '',
        'The team made login safer and search faster.',
        '',
        '## PROJ-7',
        '',
        'Search results come back faster.',
        '',
        '**AI involvement: moderate.** The AI wrote parts of the change.',
        '',
        '## PROJ-142: Rate limit login',
        '',
        'Login now limits repeated attempts.',
        '',
        '**AI involvement: heavy.** The AI wrote most of the change.',
        '',
        '**Key decisions:**',
        '',
        '- Keep the limiter in memory, because there is only one server.',
        '',
        '## Other work',
        '',
        'Logging was tidied up.',
        '',
        '## Risks and open questions',
        '',
        '- The limiter will not hold once there is more than one server.',
        '',
        '_Based on 3 summaries that 2 developers chose to share._',
        '',
      ].join('\n'),
    );
    expect(digest).toMatchObject({ model: 'claude-sonnet-5-5', promptVersion: 'digest-v1', generatedAt: '2026-03-16T08:00:00.000Z', usage: { requests: 1, costUsd: expect.any(Number) } });
    expect(llm.requests[0]!.messages[0]!.content).toContain('Ticket PROJ-142: Rate limit login');
  });

  it.each([
    ['a ticket that is not in the input', good({ overview: 'PROJ-999 also moved.' }), /mentions PROJ-999, which is not in the input/],
    ['a section for an unknown ticket', good({ tickets: [...good().tickets, { key: 'PROJ-8', achieved: 'x', aiInvolvement: 'y', keyDecisions: [] }] }), /tickets: PROJ-8 is not in the input/],
    ['a missing ticket section', good({ tickets: good().tickets.slice(1) }), /tickets: no section for PROJ-7/],
    ['a code block', good({ otherWork: 'Run ```npm test``` again.' }), /otherWork: contains code/],
    ['other work when nothing was unlinked', good(), /otherWork: there is no work without a ticket/],
  ])('retries once, then refuses, a digest with %s', async (_, bad, message) => {
    const withUnlinked = !String(message).includes('no work without a ticket');
    await expect(generateDigest(await input(withUnlinked), llmWith(bad, bad), { now })).rejects.toThrow(DigestError);
    await expect(generateDigest(await input(withUnlinked), llmWith(bad, bad), { now })).rejects.toThrow(message);
    const fixed = withUnlinked ? good() : good({ otherWork: null });
    const llm = llmWith(bad, fixed);
    expect((await generateDigest(await input(withUnlinked), llm, { now })).usage.requests).toBe(2);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(message);
  });

  it('blocks a digest whose text matches a secret detector, without retrying', async () => {
    const llm = llmWith(good({ overview: `Deployed with ${fakeToken}.` }), good());
    const error = await generateDigest(await input(), llm, { now }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(DigestBlockedError);
    expect(String(error)).toMatch(/secret \(github_token\)/);
    expect(String(error)).not.toContain(fakeToken);
    expect(llm.requests).toHaveLength(1);
  });

  it('writes an empty period without calling the model', async () => {
    const store = new InMemorySummaryStore();
    const empty = digestInput(await ticketReport(store, REPO, { from: '2026-03-01T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z' }));
    const llm = llmWith();
    const digest = await generateDigest(empty, llm, { now });
    expect(digest.markdown).toBe('# AI work update: 2026-03-01 to 2026-03-14\n\nNo AI-assisted work was shared for this period.\n\n_Based on 0 summaries that 0 developers chose to share._\n');
    expect(digest.usage).toEqual({ inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 });
    expect(llm.requests).toEqual([]);
  });
});

describe('checkDigest', () => {
  it('accepts a faithful digest', async () => {
    expect(checkDigest(good(), await input())).toEqual([]);
  });
});

describe('estimateDigestCost', () => {
  it('estimates one request at the model price, erring high', async () => {
    const i = await input();
    const estimate = estimateDigestCost(i, 'claude-sonnet-5-5');
    expect(estimate).toMatchObject({ requests: 1, outputTokens: 3_000 });
    const actual = await generateDigest(i, llmWith(good()), { now });
    expect(estimate.inputTokens).toBeGreaterThan(actual.usage.inputTokens);
    expect(estimate.costUsd).toBeCloseTo((estimate.inputTokens * 2 + 3_000 * 10) / 1_000_000);
    expect(estimateDigestCost(i, 'unknown-model').costUsd).toBeNull();
  });
});
