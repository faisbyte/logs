// Seeds a throwaway digest-server database for the end-to-end tests: two tokens (a developer and a reader), a sprint, and
// digests in every state the archive shows. Run before the server starts (PGlite is single-process).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '.data');
const REPO = 'github.com/acme/webapp';
const { openStore } = await import(join(HERE, '../../../packages/server/dist/cli.js'));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const { store, close } = await openStore({ dataDir: join(DATA, 'db') });

const developer = (await store.issueToken({ repoId: REPO, developerId: 'alice', developerName: 'Alice' })).token;
const reader = (await store.issueToken({ repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)' }, 'reader')).token;
await store.saveSprint(REPO, { name: 'Sprint 7', from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z' });

const body = (title, extra = '') =>
  [
    `# ${title}`,
    extra,
    'Sprint 7 delivered the account lockout after repeated failed logins.',
    '**AI involvement: moderate for every ticket.** AI wrote parts of the changes.',
    '## PROJ-201: Account lockout',
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
const preview = await store.saveDigest({ ...base, kind: 'scheduled', periodKey: 'week:2026-04-20', periodLabel: 'Week of 2026-04-20', markdown: body('AI work update: Week of 2026-04-20'), status: 'preview', previewUntil: '2026-04-28T06:00:00.000Z', createdAt: '2026-04-27T06:00:00.000Z' });
await close();

writeFileSync(join(DATA, 'seed.json'), JSON.stringify({ repoId: REPO, developer, reader, ids: { withdrawn: withdrawn.id, corrected: corrected.id, report: report.id, preview: preview.id } }, null, 2));
console.log('seeded e2e data');
