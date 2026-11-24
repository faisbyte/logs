import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COST_NOTICE, enableCost, flagSession, grantCost, InMemorySummaryStore, localPushTarget, saveAccount } from '@digest/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { costRecord } from '../../core/test/cost/cost-contract.js';
import { runCli, type CliIo } from '../src/cli.js';

// sprintdigest cost (Phase 12, D107): what a developer sees of their own, and the hook that reports a commit's hash.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const NOW = new Date('2026-04-08T12:00:00.000Z');

let store: InMemorySummaryStore;
let repo: string;
let pushTarget: CliIo['pushTarget'];
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@example.com', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-04-08T11:59:30Z', GIT_AUTHOR_DATE: '2026-04-08T11:59:30Z' } }).trim();

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, now: () => NOW, ...(pushTarget ? { pushTarget } : {}), ...extra });
  return { exitCode, stdout, stderr };
}
beforeEach(async () => {
  store = new InMemorySummaryStore();
  await enableCost(store, REPO, new Date('2026-04-01T00:00:00.000Z'));
  await saveAccount(store, { repoId: REPO, email: 'alice@acme.example', developerId: 'alice', developerName: 'Alice', organizationId: null, billing: 'subscription' });
  pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-cost-')));
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git');
});

describe('sprintdigest cost', () => {
  it('shows a developer their own cost by day and session, any flag on it, and what is recorded', async () => {
    await store.recordUsage([costRecord({ costMicros: 1_250_000 }), costRecord({ key: 'b', developerId: 'bob', developerName: 'Bob' })]);
    await grantCost(store, REPO, 'pat');
    await flagSession(store, { repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)', role: 'reader' }, { agent: 'claude-code', sessionId: 's1', developerId: 'alice', note: 'Is this ours?' }, NOW);
    const { exitCode, stdout } = await run(['cost', '--repo', repo]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Your AI cost on github.com/acme/webapp, 2026-03-10 up to 2026-04-09: about $1.25');
    expect(stdout).toContain('Subscription amounts are API-equivalent estimates, not money spent.');
    expect(stdout).toContain('2026-04-07  s1  about $1.25  shared repo  no commit');
    expect(stdout).toContain('Pat (PO) asked to discuss this: Is this ours?');
    expect(stdout).toContain(COST_NOTICE);
    expect(stdout).not.toMatch(/bob/i);
  });

  it('says when tracking is off, and passes on a refusal', async () => {
    await store.removeCostConfig('repo', REPO);
    expect((await run(['cost', '--repo', repo])).stdout).toBe('Cost tracking is off for github.com/acme/webapp: nothing is recorded.\n');
    pushTarget = localPushTarget(store, 'dgt_nope');
    expect(await run(['cost', '--repo', repo])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('the store refused the token') });
  });
});

describe('sprintdigest cost commit-hook', () => {
  const secret = 'git commit -m "the secret plan"';
  const hook = (over: object = {}, extra: Partial<CliIo> = {}) =>
    run(['cost', 'commit-hook'], { stdin: async () => JSON.stringify({ session_id: 'c0000001', cwd: repo, tool_name: 'Bash', tool_input: { command: secret }, ...over }), ...extra });
  const saved = () => store.commits({ developerIds: ['alice'] });

  it('reports the hash of a commit just made, and nothing else', async () => {
    git('commit', '-q', '--allow-empty', '-m', 'the secret plan');
    expect(await hook()).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await saved()).toEqual([{ repoId: REPO, developerId: 'alice', agent: 'claude-code', sessionId: 'c0000001', sha: git('rev-parse', 'HEAD'), at: expect.any(String) }]);
  });

  it('reports nothing for other commands, an old commit, or no commit at all', async () => {
    expect((await hook()).exitCode).toBe(0);
    git('commit', '-q', '--allow-empty', '-m', 'x');
    await hook({ tool_input: { command: 'git status' } });
    await hook({ tool_name: 'Read' });
    await hook({}, { now: () => new Date('2026-04-08T12:10:00.000Z') });
    expect(await saved()).toEqual([]);
  });

  it('stays silent and succeeds whatever goes wrong, so it never gets in the agent’s way', async () => {
    git('commit', '-q', '--allow-empty', '-m', 'x');
    const broken = { ...pushTarget!, recordCommit: async () => Promise.reject(new Error('down')) };
    for (const result of [await hook({}, { pushTarget: broken }), await hook({ cwd: '/nonexistent' }), await run(['cost', 'commit-hook'], { stdin: async () => 'not json' })]) expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    // A repo with no shared store set up, such as a private one, sends nothing anywhere.
    pushTarget = undefined;
    expect(await hook()).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await saved()).toEqual([]);
  });
});
