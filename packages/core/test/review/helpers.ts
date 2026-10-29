import { SessionSummarySchema, type SessionSummary } from '../../src/summarize/schema.js';

export const draftSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  SessionSummarySchema.parse({
    sessionId: 'c1a5e001-0000-4000-8000-000000000001',
    agent: 'claude-code',
    status: 'draft',
    goal: 'Rate limit the login endpoint.',
    outcome: 'completed',
    whatWasDone: 'Added an in-memory sliding-window limiter to login.',
    decisions: [{ decision: 'Use an in-memory limiter', reason: 'There is a single API instance.' }],
    rejectedApproaches: [{ approach: 'A Redis-backed limiter', reason: 'No Redis in this deployment.' }],
    risksOrFollowUps: ['The limiter will not hold across multiple instances.'],
    aiInvolvement: 'heavy',
    filesTouched: ['src/middleware/rateLimit.ts', 'src/routes/login.ts'],
    ticketRefs: ['PROJ-142'],
    branch: 'feature/PROJ-142-rate-limit',
    startedAt: '2026-03-02T09:00:00.000Z',
    endedAt: '2026-03-02T09:30:00.000Z',
    editedByDeveloper: false,
    approvedAt: null,
    generatedAt: '2026-10-28T10:00:00.000Z',
    promptVersion: 'summarize-v4',
    model: 'claude-haiku-5-5',
    usage: { inputTokens: 1000, outputTokens: 200, requests: 1, costUsd: 0.0002 },
    ...overrides,
  });
