import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession } from '../../src/redact/session.js';
import { chunkSession, condenseSession } from '../../src/summarize/condense.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import type { LlmRequest } from '../../src/summarize/llm.js';
import { DEFAULT_CHUNK_TOKENS } from '../../src/summarize/settings.js';
import { summarizeSession } from '../../src/summarize/summarize.js';
import { evalOnly } from '../fixtures.js';
import { asLlmReply, compareToGolden, goldens } from './compare.js';
import { llmSummary } from './helpers.js';

// Recency bias: a decision and a rejected approach in the first few turns, then a long run of unrelated work.
describe('an early decision in a long session (eval.early)', () => {
  const redacted = redactSession(parseClaudeCodeFile(evalOnly.early)!);
  const golden = goldens().find((g) => g.fixture === 'eval.early')!;
  const isMerge = (r: LlmRequest) => r.system.startsWith('You are merging');

  it('starts the later parts well after the decision, at the default chunk size', () => {
    const { turns, segmentStarts } = condenseSession(redacted);
    const chunks = chunkSession(turns, DEFAULT_CHUNK_TOKENS, segmentStarts);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]!.text).toContain('No JWTs');
    expect(chunks.slice(1).some((c) => /JWT|Postgres/.test(c.text))).toBe(false);
  });

  it('keeps the early decision and rejected approach even when the merge only picks recent candidates', async () => {
    const translations = (part: string) =>
      Array.from({ length: 4 }, (_, i) => ({ decision: `Translation choice ${i + 1} in part ${part}`, reason: 'Fits the button.' }));
    const llm = new FakeLlmClient((request) => {
      const content = request.messages[0]!.content;
      if (isMerge(request)) {
        const latest = (prefix: string) => [...content.matchAll(new RegExp(`^(${prefix}\\d+) `, 'gm'))].map((m) => m[1]!).slice(-6);
        return JSON.stringify({ goal: golden.goal, whatWasDone: golden.whatWasDone, aiInvolvement: 'heavy', decisionIds: latest('D'), rejectedApproachIds: latest('R'), followUpIds: latest('F') });
      }
      const part = /Transcript \(part (\d+) of/.exec(content)![1]!;
      if (part === '1') return JSON.stringify({ ...asLlmReply(golden), decisions: [...asLlmReply(golden).decisions, ...translations(part)] });
      return JSON.stringify(
        llmSummary({
          goal: 'Translate UI strings.',
          whatWasDone: 'Translated more screens.',
          decisions: translations(part),
          rejectedApproaches: [1, 2, 3, 4].map((i) => ({ approach: `Machine translation pass ${i} in part ${part}`, reason: 'Too literal.' })),
          risksOrFollowUps: [],
        }),
      );
    });
    const summary = await summarizeSession(redacted, llm, { chunkTokens: DEFAULT_CHUNK_TOKENS });
    expect(compareToGolden(summary, golden)).toEqual({ missingDecisions: [], missingRejectedApproaches: [], rejectedListedAsDecision: [], forbiddenMentions: [] });
  });
});
