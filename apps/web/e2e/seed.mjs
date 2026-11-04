// Seeds a throwaway digest-server database for the end-to-end tests: two tokens (a developer and a reader), a sprint, and
// digests in every state the archive shows. Run before the server starts (PGlite is single-process).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '.data');
const REPO = 'github.com/acme/webapp';
const { openStore } = await import(join(HERE, '../../../packages/server/dist/cli.js'));
const core = await import(join(HERE, '../../../packages/core/dist/index.js'));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const { store, close } = await openStore({ dataDir: join(DATA, 'db') });

const developer = (await store.issueToken({ repoId: REPO, developerId: 'alice', developerName: 'Alice' })).token;
const reader = (await store.issueToken({ repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)' }, 'reader')).token;
await store.saveSprint(REPO, { name: 'Sprint 7', from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z' });

// Approved summaries from two developers on two tickets, pushed the way the CLI pushes them.
const summaryBase = { agent: 'claude-code', status: 'draft', editedByDeveloper: false, approvedAt: null, generatedAt: '2026-04-15T00:00:00.000Z', promptVersion: 'e2e', model: 'e2e', usage: { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 }, aiInvolvement: 'heavy' };
const pushSummary = (who, s) => store.push({ repoId: REPO, developerId: who.toLowerCase(), developerName: who }, core.uploadPayload(core.approve(core.SessionSummarySchema.parse({ ...summaryBase, ...s }))));
await pushSummary('Alice', {
  sessionId: 'e2e00001-0000-4000-8000-000000000001', startedAt: '2026-04-07T09:00:00.000Z', endedAt: '2026-04-07T11:00:00.000Z', branch: 'feature/PROJ-201-lockout', ticketRefs: ['PROJ-201'],
  goal: 'Lock accounts after repeated failed logins.', outcome: 'completed', whatWasDone: 'Added a lockout after 5 failed logins, counted per account.',
  decisions: [{ decision: 'Failed logins are counted per account.', reason: 'Offices share one network address.' }],
  rejectedApproaches: [{ approach: 'Counting failures in process memory.', reason: 'Counts reset on every deploy.' }],
  risksOrFollowUps: ['Tell support about the lockout.'], filesTouched: ['src/auth/lockout.ts', 'src/auth/login.ts'],
});
await pushSummary('Bob', {
  sessionId: 'e2e00002-0000-4000-8000-000000000002', startedAt: '2026-04-12T09:00:00.000Z', endedAt: '2026-04-12T10:00:00.000Z', branch: 'feature/PROJ-201-message', ticketRefs: ['PROJ-201', 'PROJ-202'],
  goal: 'Tell a locked user when they can try again.', outcome: 'completed', whatWasDone: 'The lockout message now shows the minutes left.',
  decisions: [], rejectedApproaches: [], risksOrFollowUps: [], filesTouched: ['src/auth/messages.ts'],
});
await store.saveTrackerTickets(REPO, [{ key: 'PROJ-201', title: 'Account lockout', sprint: 'Sprint 7' }]);

// Context items in every state.
const ctx = (over) => ({ repoId: REPO, paths: ['src/auth/lockout.ts'], tickets: ['PROJ-201'], sources: ['claude-code/e2e00001-0000-4000-8000-000000000001'], date: '2026-04-07', status: 'active', supersededBy: null, retiredBy: null, retiredAt: null, createdAt: '2026-04-15T00:00:00.000Z', ...over });
await store.applyContextChanges(REPO, {
  added: [
    ctx({ id: 'ctx-e2e00001', type: 'pitfall', text: 'Counting failed logins in process memory was tried and dropped.', reason: 'Counts reset on every deploy.' }),
    ctx({ id: 'ctx-e2e00002', type: 'decision', text: 'Failed logins are counted per account.', reason: 'Offices share one network address.', paths: ['src/auth/login.ts'] }),
    ctx({ id: 'ctx-e2e00003', type: 'convention', text: 'Lockout messages say when to try again.', reason: 'Fewer support tickets.', paths: ['src/auth/messages.ts'], date: '2026-04-12', sources: ['claude-code/e2e00002-0000-4000-8000-000000000002'] }),
    ctx({ id: 'ctx-e2e00004', type: 'decision', text: 'Accounts lock after 3 failed logins.', reason: 'A first guess.', status: 'superseded', supersededBy: 'ctx-e2e00002' }),
    ctx({ id: 'ctx-e2e00005', type: 'convention', text: 'Lockout state is kept in the session.', reason: 'It was simplest.', status: 'retired', retiredBy: 'alice', retiredAt: '2026-04-13T00:00:00.000Z' }),
  ],
  merged: [],
  superseded: [],
});

const body = (title, extra = '') =>
  [
    `# ${title}`,
    extra,
    'Sprint 7 delivered the account lockout after repeated failed logins.',
    '**AI involvement: moderate for every ticket.** AI wrote parts of the changes.',
    '## PROJ-201: Account lockout · PROJ-202: Lockout messages',
    'Accounts now lock after 5 failed logins and unlock automatically after 15 minutes.',
    '**Key decisions:**',
    '- Accounts unlock automatically after 15 minutes, because unlocking by hand would add work for the support team.',
    '## Risks and open questions',
    '- The support team has not yet been told that locked accounts unlock automatically.',
    '_Based on 3 summaries that 2 developers chose to share._',
    '',
  ]
    .filter(Boolean)
    .join('\n\n');
const base = { repoId: REPO, from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z', inputHash: 'h', promptVersion: 'digest-v2', model: 'claude-sonnet-5-5', summaryCount: 3, developerCount: 2, costUsd: 0.05, previewUntil: null };
const label = 'Sprint 7 (2026-04-06 to 2026-04-19)';

const withdrawn = await store.saveDigest({ ...base, kind: 'scheduled', periodKey: 'sprint:Sprint 7', periodLabel: label, markdown: body(`AI work update: ${label}`), status: 'withdrawn', createdAt: '2026-04-20T06:00:00.000Z' });
const corrected = await store.saveDigest({
  ...base,
  kind: 'scheduled',
  periodKey: 'sprint:Sprint 7',
  periodLabel: label,
  markdown: body(`AI work update (corrected): ${label}`, '_This corrects the update sent on 2026-04-20: a developer withdrew a summary it included._'),
  status: 'sent',
  corrects: withdrawn.id,
  createdAt: '2026-04-21T06:00:00.000Z',
});
await store.updateDigest(REPO, corrected.id, { sentAt: '2026-04-21T06:01:00.000Z' });
const report = await store.saveDigest({ ...base, kind: 'report', periodKey: 'range:2026-04-01/2026-04-15', periodLabel: '2026-04-01 to 2026-04-14', markdown: body('AI work update: 2026-04-01 to 2026-04-14'), status: 'ready', createdAt: '2026-04-15T09:00:00.000Z' });
// Kept with two terms the jargon check flagged after its one retry (D68, D71).
const preview = await store.saveDigest({
  ...base,
  kind: 'scheduled',
  periodKey: 'week:2026-04-20',
  periodLabel: 'Week of 2026-04-20',
  markdown: body('AI work update: Week of 2026-04-20', 'The sign-in API now sends a webhook to the support team when an account locks.'),
  status: 'preview',
  previewUntil: '2026-04-28T06:00:00.000Z',
  createdAt: '2026-04-27T06:00:00.000Z',
  warnings: ['jargon: API', 'jargon: webhook'],
  jargonRetried: true,
});
await close();

writeFileSync(join(DATA, 'seed.json'), JSON.stringify({ repoId: REPO, developer, reader, ids: { withdrawn: withdrawn.id, corrected: corrected.id, report: report.id, preview: preview.id } }, null, 2));
console.log('seeded e2e data');
