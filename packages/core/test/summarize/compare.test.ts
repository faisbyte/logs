import { describe, expect, it } from 'vitest';
import { compareToGolden, type Golden } from './compare.js';
import { llmSummary } from './helpers.js';

const golden: Golden = {
  fixture: 'claude.messy',
  goal: 'Speed up search.',
  outcome: 'partial',
  whatWasDone: 'Dropped a cache for a trigram index.',
  decisions: [{ decision: 'Use a Postgres trigram index', reason: 'No extra service.', mustMention: ['trigram|pg_trgm'] }],
  rejectedApproaches: [{ approach: 'Redis cache', reason: "Ops won't run another service.", mustMention: ['redis'] }],
  risksOrFollowUps: ['Migration unfinished.'],
  aiInvolvement: 'heavy',
  mustNotMention: ['websocket'],
};

describe('compareToGolden', () => {
  it('finds nothing wrong with a summary that covers the golden', () => {
    const summary = llmSummary({ decisions: [{ decision: 'Switch to a pg_trgm index', reason: 'x' }], rejectedApproaches: [{ approach: 'A Redis cache', reason: 'y' }] });
    expect(compareToGolden(summary, golden)).toEqual({ missingDecisions: [], missingRejectedApproaches: [], rejectedListedAsDecision: [], forbiddenMentions: [] });
  });

  it('reports missing decisions and rejected approaches', () => {
    const report = compareToGolden(llmSummary({ decisions: [], rejectedApproaches: [] }), golden);
    expect(report.missingDecisions).toEqual(['Use a Postgres trigram index']);
    expect(report.missingRejectedApproaches).toEqual(['Redis cache']);
  });

  it('flags a rejected approach that ended up as a decision', () => {
    const report = compareToGolden(llmSummary({ decisions: [{ decision: 'Put Redis in front of search', reason: 'speed' }] }), golden);
    expect(report.rejectedListedAsDecision).toEqual(['Redis cache']);
  });

  it.each([
    'Drop the Redis cache and use a Postgres trigram index instead.',
    'Use a trigram index rather than a Redis cache',
    'Replace the Redis cache with a pg_trgm index',
    'Switch away from Redis to a trigram index',
  ])('does not flag a decision that names the rejected approach as what it replaced: %s', (decision) => {
    expect(compareToGolden(llmSummary({ decisions: [{ decision, reason: 'x' }] }), golden).rejectedListedAsDecision).toEqual([]);
  });

  it('flags mentions of things that are not in the source', () => {
    expect(compareToGolden(llmSummary({ whatWasDone: 'Added a WebSocket feed.' }), golden).forbiddenMentions).toEqual(['websocket']);
  });
});
