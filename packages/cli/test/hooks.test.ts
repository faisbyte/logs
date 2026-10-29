import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The repo's own pre-commit hook: a commit is blocked when the build or tests fail.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HOOK = join(ROOT, '.githooks/pre-commit');

/** A throwaway repo using the hook, with a fake pnpm whose `test` passes or fails on demand. */
function repoWithHook(testsPass: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'digest-hook-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.githooks'));
  cpSync(HOOK, join(dir, '.githooks/pre-commit'));
  git('config', 'core.hooksPath', '.githooks');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "fake test output"\nexit ${testsPass ? 0 : 1}\n`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  writeFileSync(join(dir, 'a.txt'), 'x');
  git('add', 'a.txt');
  const commit = () => {
    try {
      execFileSync('git', ['commit', '-qm', 'x'], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      return { ok: true, stderr: '' };
    } catch (err) {
      return { ok: false, stderr: String((err as { stderr?: string }).stderr) };
    }
  };
  return { commit, log: () => git('log', '--oneline').trim() };
}

describe('pre-commit hook', () => {
  it('is executable and wired up by pnpm install', () => {
    expect(statSync(HOOK).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.prepare).toContain('core.hooksPath .githooks');
  });

  it('blocks the commit and shows the test output when tests fail', () => {
    const repo = repoWithHook(false);
    const result = repo.commit();
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('fake test output');
    expect(result.stderr).toContain('Commit blocked: the build or tests failed.');
  });

  it('lets the commit through when tests pass', () => {
    const repo = repoWithHook(true);
    expect(repo.commit().ok).toBe(true);
    expect(repo.log()).toMatch(/ x$/);
  });
});
