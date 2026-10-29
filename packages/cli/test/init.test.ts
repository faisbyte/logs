import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

/** A repo with one commit and a local bare remote to push to. */
function repoWithRemote() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'digest-init-')));
  const [repo, remote] = [join(base, 'work'), join(base, 'remote.git')];
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-qm', 'first');
  /** git push, returning everything it printed. */
  const pushWithStderr = (env: Record<string, string> = {}) => {
    try {
      return execFileSync('sh', ['-c', 'git push -q origin main 2>&1'], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
    } catch (err) {
      throw new Error(`push failed: ${(err as { stdout?: string }).stdout}`);
    }
  };
  return { repo, git, pushWithStderr };
}

async function init(repo: string) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(['init', '--repo', repo], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), homeDir: '/nonexistent-home', env: {} });
  return { exitCode, stdout, stderr };
}

describe('digest init', () => {
  it('installs an executable pre-push hook that only prints a reminder', async () => {
    const { repo, pushWithStderr } = repoWithRemote();
    const { exitCode, stdout } = await init(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Installed a pre-push reminder');
    const hook = join(repo, '.git/hooks/pre-push');
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    // Nothing but comments, one echo and exit 0: it can't run digest, block or slow the push.
    const lines = readFileSync(hook, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['echo', 'exit']);
    expect(lines.at(-1)).toBe('exit 0');
    expect(pushWithStderr()).toContain('digest: when you are ready, run `digest sync` to summarise, review and share this work.');
  });

  it('never blocks a push, even with no node or pnpm on the PATH', async () => {
    const { repo, git, pushWithStderr } = repoWithRemote();
    await init(repo);
    writeFileSync(join(repo, 'b.txt'), 'y');
    git('add', '.');
    git('commit', '-qm', 'second');
    pushWithStderr({ PATH: '/usr/bin:/bin' });
    expect(git('ls-remote', 'origin', 'main')).toContain(git('rev-parse', 'HEAD').trim());
  });

  it('is idempotent, and never touches a pre-push hook it did not write', async () => {
    const { repo } = repoWithRemote();
    await init(repo);
    expect((await init(repo)).stdout).toContain('already installed');
    const other = repoWithRemote();
    writeFileSync(join(other.repo, '.git/hooks/pre-push'), '#!/bin/sh\necho mine\n');
    const result = await init(other.repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('a pre-push hook already exists');
    expect(readFileSync(join(other.repo, '.git/hooks/pre-push'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('respects core.hooksPath, and never creates a missing hooks directory', async () => {
    const { repo, git } = repoWithRemote();
    git('config', 'core.hooksPath', '.myhooks');
    const result = await init(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not exist');
    expect(existsSync(join(repo, '.myhooks'))).toBe(false);
    execFileSync('mkdir', [join(repo, '.myhooks')]);
    expect((await init(repo)).exitCode).toBe(0);
    expect(existsSync(join(repo, '.myhooks/pre-push'))).toBe(true);
  });
});
