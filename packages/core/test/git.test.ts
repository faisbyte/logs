import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitsDuring, findRepoRoot } from '../src/git.js';

let repo: string;
const sha: Record<string, string> = {};

function git(args: string[], date?: string) {
  const env = { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
}

function commit(name: string, date: string) {
  writeFileSync(join(repo, `${name}.txt`), name);
  git(['add', '.']);
  git(['commit', '-q', '-m', name], date);
  sha[name] = git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'digest-git-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'dev@example.com']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('before', '2026-03-02T08:00:00Z');
  git(['checkout', '-q', '-b', 'feature/x']);
  commit('during-1', '2026-03-02T09:05:00Z');
  commit('during-2', '2026-03-02T09:10:00Z');
  commit('after', '2026-03-02T11:00:00Z');
  git(['checkout', '-q', 'main']);
  commit('other-branch', '2026-03-02T09:07:00Z');
  mkdirSync(join(repo, 'packages/api'), { recursive: true });
});

const session = (gitBranches: string[]) => ({
  startedAt: '2026-03-02T09:00:00.000Z',
  endedAt: '2026-03-02T09:30:00.000Z',
  gitBranches,
});

describe('findRepoRoot', () => {
  it('returns the top-level directory from anywhere inside the repo', () => {
    expect(findRepoRoot(join(repo, 'packages/api'))).toBe(repo);
  });

  it('returns null outside a git repo', () => {
    expect(findRepoRoot(realpathSync(mkdtempSync(join(tmpdir(), 'digest-nogit-'))))).toBeNull();
  });
});

describe('commitsDuring', () => {
  it("returns commits on the session's branches made within its time window, oldest first", () => {
    expect(commitsDuring(repo, session(['feature/x']))).toEqual([sha['during-1'], sha['during-2']]);
  });

  it('includes commits from every branch the session recorded', () => {
    expect(commitsDuring(repo, session(['feature/x', 'main']))).toEqual([sha['during-1'], sha['other-branch'], sha['during-2']]);
  });

  it('ignores branches that no longer exist', () => {
    expect(commitsDuring(repo, session(['deleted/branch', 'feature/x']))).toEqual([sha['during-1'], sha['during-2']]);
  });

  it('returns nothing when no recorded branch exists or the path is not a repo', () => {
    expect(commitsDuring(repo, session(['deleted/branch']))).toEqual([]);
    expect(commitsDuring(repo, session([]))).toEqual([]);
    expect(commitsDuring('/work/acme-webapp', session(['main']))).toEqual([]);
  });
});
