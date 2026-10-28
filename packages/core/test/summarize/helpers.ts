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
