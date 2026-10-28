import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession } from '../../src/redact/session.js';
import { chunkTurns, condenseSession } from '../../src/summarize/condense.js';
import { estimateSummaryCost, INPUT_SAFETY_MARGIN, OUTPUT_TOKENS_PER_CALL } from '../../src/summarize/estimate.js';
import { claude } from '../fixtures.js';

const settings = { model: 'claude-haiku-5-5', effort: 'low' as const, chunkTokens: 60_000 };

describe('estimateSummaryCost', () => {
  it('estimates one request for a session that fits in one chunk', () => {
    const estimate = estimateSummaryCost(redactSession(parseClaudeCodeFile(claude.basic)!), settings);
    expect(estimate.requests).toBe(1);
    expect(estimate.inputTokens).toBeGreaterThan(500);
    expect(estimate.outputTokens).toBe(OUTPUT_TOKENS_PER_CALL);
    expect(estimate.costUsd).toBeGreaterThan(0);
    expect(estimate.costUsd).toBeLessThan(0.01);
  });

  it('adds a request per chunk plus the merge call for long sessions', () => {
    const long = redactSession(parseClaudeCodeFile(claude.long)!);
    const chunks = chunkTurns(condenseSession(long).turns, 1_000).length;
    expect(chunks).toBeGreaterThan(2);
    expect(estimateSummaryCost(long, { ...settings, chunkTokens: 1_000 }).requests).toBe(chunks + 1);
  });

  it('reports unknown cost for a model without a price', () => {
    expect(estimateSummaryCost(redactSession(parseClaudeCodeFile(claude.basic)!), { ...settings, model: 'mystery' }).costUsd).toBeNull();
  });
});

// What the Phase 3 real run measured (DECISIONS.md D22): unmargined estimate vs the API's actual counts.
const observed = [
  { session: '74ef5e02', rawInput: 5_570, input: 6_500, requests: 1, output: 617 },
  { session: '70aeaa9c', rawInput: 16_753, input: 17_606, requests: 1, output: 2_093 },
  { session: '1740fae9', rawInput: 47_728, input: 46_357, requests: 1, output: 1_568 },
  { session: 'd94236d8', rawInput: 26_874, input: 27_214, requests: 1, output: 684 },
  { session: 'ad86b19b', rawInput: 29_079, input: 30_945, requests: 1, output: 2_349 },
  { session: '1e399842', rawInput: 27_669, input: 29_412, requests: 1, output: 760 },
  { session: '0199ec34', rawInput: 2_610, input: 3_445, requests: 1, output: 320 },
  { session: '1740fae9 chunked', rawInput: 53_987, input: 61_909, requests: 5, output: 10_280 },
  // v2 (shell commands in the transcript tokenize more densely than prose):
  { session: '70aeaa9c v2', rawInput: 27_144, input: 39_502, requests: 4, output: 4_574 },
  { session: '74ef5e02 v2', rawInput: 11_825, input: 16_089, requests: 4, output: 2_209 },
  { session: 'ad86b19b v2', rawInput: 53_202, input: 67_702, requests: 5, output: 5_911 },
];

describe('estimate safety margin', () => {
  it.each(observed.map((o) => [o.session, o]))('errs high for %s by at least 5%', (_name, o) => {
    expect(o.rawInput * INPUT_SAFETY_MARGIN).toBeGreaterThanOrEqual(o.input * 1.05);
    expect(o.requests * OUTPUT_TOKENS_PER_CALL).toBeGreaterThanOrEqual(o.output * 1.05);
  });

  it('applies the margin to input tokens', () => {
    const redacted = redactSession(parseClaudeCodeFile(claude.basic)!);
    const { metadata, turns } = condenseSession(redacted);
    const raw = Math.ceil((metadata.length + turns.join('\n').length) / 2.5);
    expect(estimateSummaryCost(redacted, settings).inputTokens).toBeGreaterThan(raw * INPUT_SAFETY_MARGIN);
  });
});
