import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, InMemorySummaryStore, localPushTarget, reject, saveSummary, type PushTarget } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { draftSummary } from '../../core/test/review/helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO_ID, developerId: 'bob', developerName: 'Bob' };
const id = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`;

function devRepo(remote = 'git@github.com:Acme/WebApp.git') {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-push-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  return repo;
}
const stored = (repo: string, sessionId: string) => JSON.parse(readFileSync(join(repo, '.digest/summaries', `claude-code-${sessionId}.json`), 'utf8'));

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup() {
  const store = new InMemorySummaryStore();
  const target = localPushTarget(store, (await store.issueToken(alice)).token);
  const repo = devRepo();
  saveSummary(repo, approve(draftSummary({ sessionId: id(1) })).summary as ReturnType<typeof draftSummary>);
  saveSummary(repo, draftSummary({ sessionId: id(2) }));
  saveSummary(repo, reject(draftSummary({ sessionId: id(3) })));
  return { store, target, repo };
}

describe('sprintdigest push', () => {
  it('pushes approved summaries only, and records that they were pushed', async () => {
    const { store, target, repo } = await setup();
    const { exitCode, stdout } = await run(['push', '--repo', repo], { pushTarget: target });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('11111111  pushed');
    expect(stdout).toContain('Pushed 1 summary to github.com/acme/webapp. 1 draft still needs review; rejected summaries are never pushed.');
    expect((await store.list({ repoId: REPO_ID })).map((s) => s.summary.sessionId)).toEqual([id(1)]);
    expect(stored(repo, id(1)).pushedAt).not.toBeNull();
    expect(stored(repo, id(2)).pushedAt).toBeNull();
  });

  it('has nothing to do the second time, and an approved summary can no longer be reopened', async () => {
    const { target, repo } = await setup();
    await run(['push', '--repo', repo], { pushTarget: target });
    expect((await run(['push', '--repo', repo], { pushTarget: target })).stdout).toContain('Nothing to push');
    const reopen = await run(['reopen', '1111', '--repo', repo]);
    expect(reopen.exitCode).toBe(1);
    expect(reopen.stderr).toContain('already pushed');
  });

  it('treats a summary the store already has as pushed (idempotent)', async () => {
    const { target, repo } = await setup();
    await run(['push', '--repo', repo], { pushTarget: target });
    writeFileSync(join(repo, '.digest/summaries', `claude-code-${id(1)}.json`), JSON.stringify({ ...stored(repo, id(1)), pushedAt: null }));
    const { exitCode, stdout } = await run(['push', '--repo', repo], { pushTarget: target });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('11111111  already pushed');
  });

  it('never pushes a summary whose approval no longer holds', async () => {
    const { store, target, repo } = await setup();
    writeFileSync(join(repo, '.digest/summaries', `claude-code-${id(1)}.json`), JSON.stringify({ ...stored(repo, id(1)), goal: 'Changed after approval.' }));
    const { exitCode, stdout } = await run(['push', '--repo', repo], { pushTarget: target });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/11111111 +not pushed: .*changed after it was approved/);
    expect(await store.list({ repoId: REPO_ID })).toEqual([]);
  });

  it('reports what the store refused, and leaves it unpushed', async () => {
    const { store, repo } = await setup();
    const refusing: PushTarget = { push: async () => ({ status: 'rejected', errors: ['goal: contains a secret (github_token)'] }) };
    const { exitCode, stdout } = await run(['push', '--repo', repo], { pushTarget: refusing });
    expect(exitCode).toBe(1);
    expect(stdout).toContain('11111111  rejected by the store: goal: contains a secret (github_token)');
    expect(stored(repo, id(1)).pushedAt).toBeNull();
    expect(await store.list({ repoId: REPO_ID })).toEqual([]);
  });

  it('stops at the first auth failure', async () => {
    const { store, repo } = await setup();
    const { exitCode, stderr } = await run(['push', '--repo', repo], { pushTarget: localPushTarget(store, 'dgt_wrong') });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('the store refused the token: unknown or revoked token');
  });

  it('needs a configured store and a hosted origin remote', async () => {
    const { repo, target } = await setup();
    expect((await run(['push', '--repo', repo])).stderr).toContain('no shared store is configured');
    const local = devRepo('');
    expect((await run(['push', '--repo', local], { pushTarget: target })).stderr).toContain('no git remote named origin');
  });

  it('puts two developers on the same repo into one combined list', async () => {
    const store = new InMemorySummaryStore();
    const aliceRepo = devRepo('git@github.com:Acme/WebApp.git');
    const bobRepo = devRepo('https://github.com/acme/webapp.git');
    saveSummary(aliceRepo, approve(draftSummary({ sessionId: id(1), goal: 'Alice: rate limit login.' })).summary as ReturnType<typeof draftSummary>);
    saveSummary(bobRepo, approve(draftSummary({ sessionId: id(2), goal: 'Bob: speed up search.' })).summary as ReturnType<typeof draftSummary>);
    await run(['push', '--repo', aliceRepo], { pushTarget: localPushTarget(store, (await store.issueToken(alice)).token) });
    await run(['push', '--repo', bobRepo], { pushTarget: localPushTarget(store, (await store.issueToken(bob)).token) });
    const report = await store.teamReport({ repoId: REPO_ID, from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
    expect(report).toMatchObject({ summaryCount: 2, developerCount: 2 });
    expect(report.summaries.map((s) => `${s.developerName}: ${s.summary.goal}`).sort()).toEqual(['Alice: Alice: rate limit login.', 'Bob: Bob: speed up search.']);
  });
});
