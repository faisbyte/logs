import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, InMemorySummaryStore, localPushTarget, saveSummary } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { draftSummary } from '../../core/test/review/helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

// digest link, digest unlink and digest tickets (DECISIONS.md D45, D46).

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const id = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`;

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup() {
  const store = new InMemorySummaryStore({ now: () => new Date('2026-03-20T12:00:00.000Z') });
  const pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-tickets-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git'], { cwd: repo });
  saveSummary(repo, approve(draftSummary({ sessionId: id(1) })).summary as ReturnType<typeof draftSummary>);
  saveSummary(repo, approve(draftSummary({ sessionId: id(2), goal: 'Tidy the audit log.', ticketRefs: [], branch: 'main', startedAt: '2026-03-17T09:00:00.000Z', endedAt: '2026-03-17T10:00:00.000Z' })).summary as ReturnType<typeof draftSummary>);
  saveSummary(repo, draftSummary({ sessionId: id(3) }));
  await run(['push', '--repo', repo], { pushTarget });
  return { store, pushTarget, repo };
}

describe('digest link and unlink', () => {
  it('links a pushed summary to another ticket, and removes that link again', async () => {
    const { store, pushTarget, repo } = await setup();
    expect(await run(['link', '11111111', 'OPS-7', '--repo', repo], { pushTarget })).toMatchObject({ exitCode: 0, stdout: 'Linked 11111111 to OPS-7.\n' });
    expect((await run(['link', '11111111', 'OPS-7', '--repo', repo], { pushTarget })).stdout).toBe('11111111 is already linked to OPS-7.\n');
    expect(await store.ticketLinks(REPO_ID)).toMatchObject([{ sessionId: id(1), ticketKey: 'OPS-7', addedBy: 'alice' }]);
    expect(await run(['unlink', '11111111', 'OPS-7', '--repo', repo], { pushTarget })).toMatchObject({ exitCode: 0, stdout: 'Removed the link from 11111111 to OPS-7.\n' });
    expect(await store.ticketLinks(REPO_ID)).toEqual([]);
  });

  it("refuses to unlink a key that is part of the summary, and explains", async () => {
    const { pushTarget, repo } = await setup();
    const result = await run(['unlink', '11111111', 'PROJ-142', '--repo', repo], { pushTarget });
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('part of the approved summary') });
  });

  it('points to review for a summary that has not been pushed yet', async () => {
    const { pushTarget, repo } = await setup();
    const result = await run(['link', '33333333', 'OPS-7', '--repo', repo], { pushTarget });
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('33333333 has not been pushed; add ticket keys while reviewing it (digest review) instead') });
  });
});

describe('digest tickets', () => {
  it('prints summaries grouped by sprint, then ticket, with unlinked ones apart', async () => {
    const { store, pushTarget, repo } = await setup();
    await store.saveSprint(REPO_ID, { name: 'Sprint 1', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
    await store.saveTrackerTickets(REPO_ID, [{ key: 'PROJ-142', title: 'Rate limit login', sprint: null }]);
    await run(['link', '22222222', 'OPS-7', '--repo', repo], { pushTarget });
    await store.saveTrackerTickets(REPO_ID, [{ key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 1' }]);
    const { exitCode, stdout } = await run(['tickets', '--from', '2026-03-01', '--to', '2026-04-01', '--repo', repo], { pushTarget });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      [
        'Sprint 1 (2026-03-02 up to 2026-03-16)',
        '  PROJ-142  Rate limit login',
        '    2026-03-02  Alice  Rate limit the login endpoint.  (branch)',
        'No sprint',
        '  OPS-7',
        '    2026-03-17  Alice  Tidy the audit log.  (manual, added by alice)',
        '',
        '2 summaries from 1 developer.',
        '',
      ].join('\n'),
    );
  });

  it('selects one sprint by name, and shows unlinked summaries', async () => {
    const { store, pushTarget, repo } = await setup();
    await store.saveSprint(REPO_ID, { name: 'Sprint 2', from: '2026-03-16T00:00:00.000Z', to: '2026-03-30T00:00:00.000Z' });
    const { stdout } = await run(['tickets', '--sprint', 'Sprint 2', '--repo', repo], { pushTarget });
    expect(stdout).toBe(['Sprint 2 (2026-03-16 up to 2026-03-30)', '  Unlinked', '    2026-03-17  Alice  Tidy the audit log.', '', '1 summary from 1 developer.', ''].join('\n'));
  });

  it('needs --from and --to, or --sprint', async () => {
    const { pushTarget, repo } = await setup();
    expect((await run(['tickets', '--from', '2026-03-01', '--repo', repo], { pushTarget })).stderr).toContain('pass --from and --to, or --sprint');
    expect((await run(['tickets', '--from', 'soon', '--to', '2026-04-01', '--repo', repo], { pushTarget })).stderr).toContain('--from and --to must be dates such as 2026-03-01');
    expect((await run(['tickets', '--sprint', 'Nope', '--repo', repo], { pushTarget })).stdout).toBe('Nothing pushed for that selection.\n');
  });
});
