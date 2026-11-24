import type { ContextItem, CostFlag, CostReport, CostSession, StoredSummary } from '@digest/core';

// Small synthetic records shaped like the server's answers, for the developer-view component tests.

export const summary = (over: Partial<StoredSummary['summary']> & { developerName?: string } = {}): StoredSummary => {
  const { developerName = 'Alice', ...fields } = over;
  return {
    repoId: 'github.com/acme/webapp',
    developerId: developerName.toLowerCase(),
    developerName,
    pushedAt: '2026-04-08T12:00:00.000Z',
    payloadHash: 'h',
    retractedAt: null,
    summary: {
      sessionId: 's1',
      agent: 'claude-code',
      editedByDeveloper: false,
      approvedAt: '2026-04-08T11:00:00.000Z',
      approvedBy: 'developer',
      goal: 'Lock accounts after repeated failed logins.',
      outcome: 'completed',
      whatWasDone: 'Added a lockout after 5 failed logins.',
      decisions: [{ decision: 'Count failures per account.', reason: 'Offices share one address.' }],
      rejectedApproaches: [{ approach: 'Counting in process memory.', reason: 'Counts reset on deploy.' }],
      risksOrFollowUps: ['Tell support about the lockout.'],
      aiInvolvement: 'heavy',
      filesTouched: ['src/auth/lockout.ts', 'src/auth/login.ts'],
      ticketRefs: ['PROJ-201'],
      ticketSources: { 'PROJ-201': 'branch' },
      branch: 'feature/PROJ-201-lockout',
      startedAt: '2026-04-07T09:00:00.000Z',
      endedAt: '2026-04-07T11:30:00.000Z',
      ...fields,
    },
  } as StoredSummary;
};

export const item = (over: Partial<ContextItem> = {}): ContextItem => ({
  id: 'ctx-00000001',
  repoId: 'github.com/acme/webapp',
  type: 'pitfall',
  text: 'Counting failed logins in process memory was tried and dropped.',
  reason: 'Counts reset on every deploy.',
  paths: ['src/auth/lockout.ts'],
  tickets: ['PROJ-201'],
  sources: ['claude-code/b2b2b2b2-0000-4000-8000-000000000002'],
  date: '2026-04-07',
  status: 'active',
  supersededBy: null,
  retiredBy: null,
  retiredAt: null,
  createdAt: '2026-04-08T00:00:00.000Z',
  ...over,
});

export const costSession = (over: Partial<CostSession> = {}): CostSession => ({
  agent: 'claude-code',
  sessionId: 'c0000001-0000-4000-8000-000000000001',
  developerId: 'alice',
  developerName: 'Alice',
  date: '2026-04-07',
  startedAt: '2026-04-07T10:00:00.000Z',
  endedAt: '2026-04-07T11:00:00.000Z',
  requests: 12,
  models: ['claude-opus-5-5'],
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 300,
  micros: 1_250_000,
  unpricedRequests: 0,
  billing: 'subscription',
  place: 'shared',
  repoId: 'github.com/acme/webapp',
  commits: [{ repoId: 'github.com/acme/webapp', sha: 'a1b2c3d4'.repeat(5) }],
  tickets: ['PROJ-201'],
  flags: [],
  ...over,
});

export const costFlag = (over: Partial<CostFlag> = {}): CostFlag => ({
  id: 'f-1',
  repoId: 'github.com/acme/webapp',
  agent: 'claude-code',
  sessionId: 'c0000001-0000-4000-8000-000000000001',
  developerId: 'alice',
  flaggedBy: 'pat',
  flaggedByName: 'Pat (PO)',
  flaggedAt: '2026-04-08T09:00:00.000Z',
  notes: [{ by: 'pat', name: 'Pat (PO)', role: 'reader', at: '2026-04-08T09:00:00.000Z', text: 'Is this ours?' }],
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});

export const costReport = (over: Partial<CostReport> = {}): CostReport => ({
  repoId: 'github.com/acme/webapp',
  from: '2026-04-06T00:00:00.000Z',
  to: '2026-04-20T00:00:00.000Z',
  scope: 'all',
  totalMicros: 3_750_000,
  billing: { api: 2_500_000, subscription: 1_250_000, unknown: 0 },
  places: { shared: 1_250_000, company: 0, outside: 2_500_000, unknown: 0 },
  unpricedRequests: 0,
  developers: [
    { developerId: 'alice', developerName: 'Alice', micros: 1_250_000, sessions: 1 },
    { developerId: 'bob', developerName: 'Bob', micros: 2_500_000, sessions: 1 },
  ],
  models: [{ model: 'claude-opus-5-5', micros: 3_750_000 }],
  tickets: [{ ticket: 'PROJ-201', title: 'Account lockout', micros: 1_250_000 }],
  sessions: [costSession(), costSession({ sessionId: 'd0000002', developerId: 'bob', developerName: 'Bob', micros: 2_500_000, billing: 'api', place: 'outside', repoId: null, commits: [], tickets: [] })],
  ...over,
});
