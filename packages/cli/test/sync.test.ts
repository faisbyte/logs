import { execFileSync } from 'node:child_process';
import { FakeLlmClient, InMemorySummaryStore, localPushTarget } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import { fixtureRepo, reply } from './helpers.js';

const REPO_ID = 'github.com/acme/webapp';

async function setup() {
  const { repo, env } = fixtureRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/webapp.git'], { cwd: repo });
  const store = new InMemorySummaryStore();
  const { token } = await store.issueToken({ repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' });
  return { repo, env, store, pushTarget: localPushTarget(store, token), llm: new FakeLlmClient(reply, 'claude-haiku-5-5') };
}

async function sync(repo: string, env: Record<string, string>, extra: Partial<CliIo>) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(['sync', '--repo', repo], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env, ...extra });
  return { exitCode, stdout, stderr };
}

const answering = (...replies: string[]) => async () => replies.shift() ?? 'q';

describe('digest sync', () => {
  it('summarises after showing the estimate, then reviews, then pushes what was approved', async () => {
    const { repo, env, store, pushTarget, llm } = await setup();
    const questions: string[] = [];
    const confirm = async (q: string) => (questions.push(q), true);
    const { exitCode, stdout } = await sync(repo, env, { llm, pushTarget, confirm, ask: answering('a', 'a', 'r', 's', 'a', 'a') });
    expect(exitCode).toBe(0);
    const at = (text: string) => stdout.indexOf(text);
    expect(at('6 sessions to summarise with claude-haiku-5-5')).toBeGreaterThan(-1);
    expect(at('6 sessions to summarise')).toBeLessThan(at(' summarised '));
    expect(questions).toHaveLength(1);
    expect(at(' summarised ')).toBeLessThan(at('Reviewed 6 drafts: 4 approved, 1 rejected, 1 skipped.'));
    expect(at('Reviewed 6 drafts')).toBeLessThan(at('Pushed 4 summaries to github.com/acme/webapp.'));
    expect(await store.list({ repoId: REPO_ID })).toHaveLength(4);
  });

  it('stops without pushing when the developer quits the review', async () => {
    const { repo, env, store, pushTarget, llm } = await setup();
    const { exitCode, stdout } = await sync(repo, env, { llm, pushTarget, confirm: async () => true, ask: answering('a', 'q') });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('You quit the review, so nothing was pushed.');
    expect(await store.list({ repoId: REPO_ID })).toEqual([]);
  });

  it('stops before sending anything when the estimate is declined', async () => {
    const { repo, env, store, pushTarget, llm } = await setup();
    const { exitCode, stderr } = await sync(repo, env, { llm, pushTarget, confirm: async () => false, ask: answering('a') });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Cancelled');
    expect(llm.requests).toEqual([]);
    expect(await store.list({ repoId: REPO_ID })).toEqual([]);
  });

  it('checks for a shared store and a terminal before summarising anything', async () => {
    const { repo, env, pushTarget, llm } = await setup();
    expect((await sync(repo, env, { llm, confirm: async () => true, ask: answering() })).stderr).toContain('no shared store is configured');
    expect((await sync(repo, env, { llm, pushTarget, confirm: async () => true })).stderr).toContain('needs a terminal');
    expect(llm.requests).toEqual([]);
  });
});
