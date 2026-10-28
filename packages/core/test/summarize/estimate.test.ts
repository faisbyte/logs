import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../../src/parsers/claude-code.js';
import { redactSession } from '../../src/redact/session.js';
import { chunkTurns, condenseSession } from '../../src/summarize/condense.js';
import { estimateSummaryCost } from '../../src/summarize/estimate.js';
import { claude } from '../fixtures.js';

const settings = { model: 'claude-haiku-5-5', effort: 'low' as const, chunkTokens: 60_000 };

describe('estimateSummaryCost', () => {
  it('estimates one request for a session that fits in one chunk', () => {
    const estimate = estimateSummaryCost(redactSession(parseClaudeCodeFile(claude.basic)!), settings);
    expect(estimate.requests).toBe(1);
    expect(estimate.inputTokens).toBeGreaterThan(500);
    expect(estimate.outputTokens).toBe(1_500);
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
