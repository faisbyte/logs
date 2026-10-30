import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySummaryStore, localPushTarget, saveSummary } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { draftSummary } from '../../core/test/review/helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

// Approving a summary with no tickets asks first, when the repo uses sprints or tickets (DECISIONS.md D61).

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const ID = '11111111-0000-4000-8000-000000000001';
const QUESTION = 'No tickets tagged. Approve anyway? [y/N] ';

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, ...extra });
  return { exitCode, stdout, stderr };
}

async function setup({ sprint = true, ticketRefs = [] as string[] } = {}) {
  const store = new InMemorySummaryStore();
  if (sprint) await store.saveSprint(REPO_ID, { name: 'Sprint 1', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
  const pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-approve-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/WebApp.git'], { cwd: repo });
  saveSummary(repo, draftSummary({ sessionId: ID, ticketRefs, branch: 'main' }));
  return { repo, pushTarget };
}
const status = (repo: string) => JSON.parse(readFileSync(join(repo, '.digest/summaries', `claude-code-${ID}.json`), 'utf8')).status;

describe('approving a summary with no tickets', () => {
  it('asks first when the shared store has sprints, and approves only on yes', async () => {
    const { repo, pushTarget } = await setup();
    const asked: string[] = [];
    const no = await run(['approve', '11111111', '--repo', repo], { pushTarget, confirm: async (q) => (asked.push(q), false) });
    expect(asked).toEqual([QUESTION]);
    expect(no).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('Not approved. Tag its tickets with sprintdigest review (e to edit), or pass --yes.') });
    expect(status(repo)).toBe('draft');
    expect((await run(['approve', '11111111', '--repo', repo], { pushTarget, confirm: async () => true })).exitCode).toBe(0);
    expect(status(repo)).toBe('approved');
  });

  it('without a terminal, needs --yes', async () => {
    const { repo, pushTarget } = await setup();
    expect((await run(['approve', '11111111', '--repo', repo], { pushTarget })).stderr).toContain('No tickets tagged. Re-run with --yes to approve anyway');
    expect((await run(['approve', '11111111', '--yes', '--repo', repo], { pushTarget })).exitCode).toBe(0);
    expect(status(repo)).toBe('approved');
  });

  it('asks when tickets are configured locally, even with no shared store', async () => {
    const { repo } = await setup({ sprint: false });
    mkdirSync(join(repo, '.digest'), { recursive: true });
    writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ tickets: { keys: ['PROJ'] } }));
    const asked: string[] = [];
    await run(['approve', '11111111', '--repo', repo], { confirm: async (q) => (asked.push(q), true) });
    expect(asked).toEqual([QUESTION]);
  });

  it('does not ask when the summary has tickets, or when the repo uses neither sprints nor tickets', async () => {
    const tagged = await setup({ ticketRefs: ['PROJ-142'] });
    const asked: string[] = [];
    await run(['approve', '11111111', '--repo', tagged.repo], { pushTarget: tagged.pushTarget, confirm: async (q) => (asked.push(q), true) });
    const plain = await setup({ sprint: false });
    await run(['approve', '11111111', '--repo', plain.repo], { pushTarget: plain.pushTarget, confirm: async (q) => (asked.push(q), true) });
    expect(asked).toEqual([]);
    expect([status(tagged.repo), status(plain.repo)]).toEqual(['approved', 'approved']);
  });

  it('asks in the interactive review too, and stays on the summary on no', async () => {
    const { repo, pushTarget } = await setup();
    const answers = ['a', 'n', 's'];
    const prompts: string[] = [];
    const result = await run(['review', '--repo', repo], { pushTarget, ask: async (q) => (prompts.push(q), answers.shift() ?? 'q') });
    expect(prompts).toEqual(['[a]pprove  [e]dit  [r]eject  [s]kip  [q]uit: ', QUESTION, '[a]pprove  [e]dit  [r]eject  [s]kip  [q]uit: ']);
    expect(result.stdout).toContain('0 approved, 0 rejected, 1 skipped');
    expect(status(repo)).toBe('draft');
  });
});
