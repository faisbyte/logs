import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, InMemorySummaryStore, localPushTarget, saveSummary } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { draftSummary } from '../../core/test/review/helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

// sprintdigest retract (DECISIONS.md D60): withdraw your own pushed summary; locally it becomes a draft again.

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const ID = '11111111-0000-4000-8000-000000000001';

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup() {
  const store = new InMemorySummaryStore();
  const pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-retract-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git'], { cwd: repo });
  saveSummary(repo, approve(draftSummary({ sessionId: ID })).summary as ReturnType<typeof draftSummary>);
  await run(['push', '--repo', repo], { pushTarget });
  return { store, pushTarget, repo };
}
const local = (repo: string) => JSON.parse(readFileSync(join(repo, '.digest/summaries', `claude-code-${ID}.json`), 'utf8'));

describe('sprintdigest retract', () => {
  it('withdraws the pushed summary and makes the local one a draft again, ready to edit, approve and push', async () => {
    const { store, pushTarget, repo } = await setup();
    const result = await run(['retract', '11111111', '--repo', repo], { pushTarget });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'Retracted 11111111 from the shared store. It is a draft again: edit it, re-summarise it by id, or approve it and push again.\n' });
    expect(await store.list({ repoId: REPO_ID })).toEqual([]);
    expect(local(repo)).toMatchObject({ status: 'draft', approvedAt: null, approvedBy: null, approvalHash: null, pushedAt: null });
    await run(['approve', '11111111', '--repo', repo]);
    expect((await run(['push', '--repo', repo], { pushTarget })).stdout).toContain('11111111  pushed');
    expect(await store.list({ repoId: REPO_ID })).toHaveLength(1);
  });

  it("refuses another developer's token, and a summary that was never pushed", async () => {
    const { store, repo } = await setup();
    const bob = localPushTarget(store, (await store.issueToken({ repoId: REPO_ID, developerId: 'bob', developerName: 'Bob' })).token);
    const refused = await run(['retract', '11111111', '--repo', repo], { pushTarget: bob });
    expect(refused).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('only the developer who pushed a summary can retract it') });
    expect(local(repo).status).toBe('approved');
    saveSummary(repo, draftSummary({ sessionId: '22222222-0000-4000-8000-000000000002' }));
    expect((await run(['retract', '22222222', '--repo', repo], { pushTarget: bob })).stderr).toContain('22222222 was never pushed; reopen or edit it locally instead');
  });
});
