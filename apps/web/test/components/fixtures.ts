import type { ContextItem, StoredSummary } from '@digest/core';

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
