import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySummaryStore, localPushTarget } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { contextItem } from '../../core/test/shared/context-contract.js';
import { runCli, type CliIo } from '../src/cli.js';

// sprintdigest context propose (DECISIONS.md D75 option A, D83): a marked AGENTS.md section on a new branch in a
// temporary worktree, the diff shown first, and a pull request through gh. Never the default branch, never text
// outside the markers.

const REPO_ID = 'github.com/acme/webapp';
const alice = { repoId: REPO_ID, developerId: 'alice', developerName: 'Alice' };
const OWN = '# Agents\n\nTeam text that must stay exactly as it is.  \n';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const now = () => new Date('2026-03-20T12:00:00.000Z');

async function setup({ claudeMd = '# Claude\n\nUse pnpm.\n' as string | null } = {}) {
  const store = new InMemorySummaryStore({ now });
  await store.applyContextChanges(REPO_ID, { added: [contextItem({ repoId: REPO_ID })], merged: [], superseded: [] });
  const pushTarget = localPushTarget(store, (await store.issueToken(alice)).token);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'digest-cli-propose-')));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'alice@example.com');
  git(repo, 'config', 'user.name', 'Alice');
  writeFileSync(join(repo, 'AGENTS.md'), OWN);
  if (claudeMd !== null) writeFileSync(join(repo, 'CLAUDE.md'), claudeMd);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  // The remote URL the repo id comes from, kept apart from the push URL to the local bare repo.
  git(repo, 'config', 'remote.origin.pushurl', origin);
  git(repo, 'config', 'remote.origin.url', 'git@github.com:Acme/WebApp.git');
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  const ghCalls: string[][] = [];
  const run: CliIo['run'] = (command, args, cwd) => {
    if (command === 'gh') {
      ghCalls.push(args);
      return args[0] === 'auth' ? { status: 0, stdout: '', stderr: '' } : { status: 0, stdout: 'https://github.com/acme/webapp/pull/7\n', stderr: '' };
    }
    // Fetches go to the local bare repo too.
    const fixed = command === 'git' && args[0] === 'fetch' ? args.map((a) => (a === 'origin' ? origin : a)) : args;
    const r = spawnSync(command, fixed, { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { store, pushTarget, repo, origin, run, ghCalls, mainSha: git(repo, 'rev-parse', 'main') };
}

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', timeZone: 'UTC', env: {}, now, ...extra });
  return { exitCode, stdout, stderr };
}

describe('sprintdigest context propose', () => {
  it('shows the diff, asks, then commits on a new branch, pushes it and opens a pull request against the default branch', async () => {
    const s = await setup();
    const seenBeforeAsking: string[] = [];
    let out = '';
    const result = await run(['context', 'propose', '--repo', s.repo], {
      pushTarget: s.pushTarget,
      run: s.run,
      stdout: (t) => (out += t),
      confirm: async (q) => (seenBeforeAsking.push(out, q), true),
    });
    expect(result.exitCode).toBe(0);
    expect(seenBeforeAsking[0]).toContain('+<!-- sprintdigest:context:start -->');
    expect(seenBeforeAsking[0]).toContain('+@AGENTS.md');
    expect(seenBeforeAsking[1]).toBe('Commit this on sprintdigest/context-2026-03-20 and open a pull request against main? [y/N] ');
    expect(out).toContain('Opened https://github.com/acme/webapp/pull/7\n');

    const branch = 'sprintdigest/context-2026-03-20';
    const agents = git(s.origin, 'show', `${branch}:AGENTS.md`);
    expect(agents.startsWith(OWN)).toBe(true);
    expect(agents).toContain('(ctx-0000000a): Counting failed logins in memory was tried and dropped.');
    expect(git(s.origin, 'show', `${branch}:CLAUDE.md`)).toBe('# Claude\n\nUse pnpm.\n\n@AGENTS.md');
    expect(git(s.origin, 'rev-parse', 'main')).toBe(s.mainSha);
    expect(s.ghCalls.at(-1)).toEqual(expect.arrayContaining(['pr', 'create', '--base', 'main', '--head', branch]));

    // The developer's own checkout and branch are untouched, and the temporary worktree is gone.
    expect(git(s.repo, 'branch', '--show-current')).toBe('main');
    expect(readFileSync(join(s.repo, 'AGENTS.md'), 'utf8')).toBe(OWN);
    expect(git(s.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('commits and pushes nothing when the developer says no, and leaves no branch or worktree behind', async () => {
    const s = await setup();
    const result = await run(['context', 'propose', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run, confirm: async () => false });
    expect(result).toMatchObject({ exitCode: 1, stderr: 'sprintdigest context propose: Cancelled; nothing was committed or pushed.\n' });
    expect(result.stdout).toContain('+<!-- sprintdigest:context:start -->');
    expect(git(s.origin, 'branch', '--list', 'sprintdigest/*')).toBe('');
    expect(git(s.repo, 'branch', '--list', 'sprintdigest/*')).toBe('');
    expect(git(s.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(s.ghCalls.filter((c) => c[0] === 'pr')).toEqual([]);
  });

  it('needs --yes without a terminal, still showing the diff, and leaves CLAUDE.md alone when there is none', async () => {
    const s = await setup({ claudeMd: null });
    const asked = await run(['context', 'propose', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run });
    expect(asked).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('Re-run with --yes') });
    const yes = await run(['context', 'propose', '--yes', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run });
    expect(yes.exitCode).toBe(0);
    expect(yes.stdout.indexOf('+<!-- sprintdigest:context:start -->')).toBeLessThan(yes.stdout.indexOf('Opened'));
    expect(spawnSync('git', ['show', 'sprintdigest/context-2026-03-20:CLAUDE.md'], { cwd: s.origin }).status).not.toBe(0);
  });

  it('says so when AGENTS.md already has these notes, and uses a fresh branch name when one is taken', async () => {
    const s = await setup();
    await run(['context', 'propose', '--yes', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run });
    // The team merges the pull request.
    git(s.origin, 'update-ref', 'refs/heads/main', 'refs/heads/sprintdigest/context-2026-03-20');
    expect(await run(['context', 'propose', '--yes', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run })).toMatchObject({ exitCode: 0, stdout: 'AGENTS.md already has these notes; nothing to propose.\n' });
    await s.store.applyContextChanges(REPO_ID, { added: [contextItem({ repoId: REPO_ID, id: 'ctx-0000000b', type: 'decision', text: 'Accounts lock after 5 failed logins.', reason: 'Fewer support calls.' })], merged: [], superseded: [] });
    expect((await run(['context', 'propose', '--yes', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run })).stdout).toContain('sprintdigest/context-2026-03-20-2');
  });

  it('refuses to start without a logged-in gh, or with broken markers, before making any branch', async () => {
    const s = await setup();
    const noGh: CliIo['run'] = (command, args, cwd) => (command === 'gh' ? { status: 1, stdout: '', stderr: 'not logged in' } : s.run!(command, args, cwd));
    expect(await run(['context', 'propose', '--yes', '--repo', s.repo], { pushTarget: s.pushTarget, run: noGh })).toMatchObject({ exitCode: 1, stderr: 'sprintdigest context propose: this needs the GitHub CLI, logged in (gh auth login).\n' });
    writeFileSync(join(s.repo, 'AGENTS.md'), `${OWN}<!-- sprintdigest:context:start -->\n`);
    git(s.repo, 'commit', '-q', '-am', 'broken markers');
    git(s.repo, 'push', '-q', 'origin', 'main');
    expect((await run(['context', 'propose', '--yes', '--repo', s.repo], { pushTarget: s.pushTarget, run: s.run })).stderr).toContain('markers that are missing, repeated or out of order');
    expect(git(s.repo, 'branch', '--list', 'sprintdigest/*')).toBe('');
    expect(existsSync(join(s.repo, '.digest/worktrees/sprintdigest-context-2026-03-20'))).toBe(false);
  });
});
