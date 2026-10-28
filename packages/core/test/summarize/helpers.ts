import type { LlmRequest } from '../../src/summarize/llm.js';
import type { LlmSummary } from '../../src/summarize/schema.js';

export const llmSummary = (overrides: Partial<LlmSummary> = {}): LlmSummary => ({
  goal: 'Rate limit the login endpoint.',
  outcome: 'completed',
  whatWasDone: 'Added an in-memory sliding-window limiter to login.',
  decisions: [{ decision: 'Use an in-memory limiter', reason: 'There is a single API instance.' }],
  rejectedApproaches: [],
  risksOrFollowUps: ['The limiter will not hold across multiple instances.'],
  aiInvolvement: 'heavy',
  reversedDecisions: [],
  ...overrides,
});

/** A merge reply that keeps every candidate id it was offered (up to 6 per list). */
export const pickAll = (request: LlmRequest, narrative = { goal: 'Speed up search.', whatWasDone: 'Tried a cache, then moved to a trigram index.', aiInvolvement: 'heavy' }) => {
  const ids = (prefix: string) => [...request.messages[0]!.content.matchAll(new RegExp(`^(${prefix}\\d+):`, 'gm'))].map((m) => m[1]!).slice(0, 6);
  return JSON.stringify({ ...narrative, decisionIds: ids('D'), rejectedApproachIds: ids('R'), followUpIds: ids('F') });
};
