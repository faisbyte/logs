import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDigestDir } from '../src/digest-dir.js';
import { validRepoRoot } from '../src/repo.js';

const temp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
function gitRepo() {
  const dir = temp('digest-root-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'packages/api'), { recursive: true });
  return dir;
}

describe('validRepoRoot', () => {
  it('returns the git root of an existing path inside a repo', () => {
    const repo = gitRepo();
    expect(validRepoRoot(join(repo, 'packages/api'), '/nonexistent-home')).toEqual({ root: repo });
  });

  it('rejects a path that does not exist', () => {
    expect(validRepoRoot('/work/gone-project', '/nonexistent-home')).toEqual({ error: '/work/gone-project does not exist' });
  });

  it('rejects a directory that is not inside a git repo', () => {
    const dir = temp('digest-nogit-');
    expect(validRepoRoot(dir, '/nonexistent-home')).toEqual({ error: `${dir} is not inside a git repository` });
  });

  it('never treats the home directory as a repo root, even when it is one', () => {
    const home = gitRepo();
    mkdirSync(join(home, 'Documents/notes'), { recursive: true });
    expect(validRepoRoot(join(home, 'Documents/notes'), home)).toEqual({ error: `${join(home, 'Documents/notes')} is only inside your home directory's git repo, which is never treated as a project` });
  });
});

describe('ensureDigestDir', () => {
  it('refuses to create a repo root that does not exist', () => {
    const missing = join(tmpdir(), `digest-missing-${Date.now()}`);
    expect(() => ensureDigestDir(missing)).toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
  });
});
