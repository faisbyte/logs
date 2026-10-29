import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRemoteUrl, repoIdentity } from '../../src/shared/repo-id.js';

describe('normalizeRemoteUrl', () => {
  it.each([
    'git@github.com:Acme/WebApp.git',
    'https://github.com/Acme/WebApp.git',
    'https://github.com/acme/webapp',
    'https://github.com/acme/webapp/',
    'ssh://git@github.com/acme/webapp.git',
    'ssh://git@github.com:22/acme/webapp.git',
    'git://github.com/acme/webapp.git',
    'https://dev:not-a-real-password@github.com/acme/webapp.git',
    'https://GitHub.com/acme/webapp.git',
  ])('maps %s to github.com/acme/webapp', (url) => {
    expect(normalizeRemoteUrl(url)).toBe('github.com/acme/webapp');
  });

  it('keeps nested group paths', () => {
    expect(normalizeRemoteUrl('git@gitlab.example.com:platform/tools/digest.git')).toBe('gitlab.example.com/platform/tools/digest');
  });

  it('never keeps credentials', () => {
    expect(normalizeRemoteUrl('https://dev:not-a-real-password@github.com/acme/webapp.git')).not.toContain('password');
  });

  it.each(['/srv/git/webapp.git', 'file:///srv/git/webapp.git', 'not a url', ''])('has no identity for a local or unparseable remote: %s', (url) => {
    expect(normalizeRemoteUrl(url)).toBeNull();
  });
});

describe('repoIdentity', () => {
  const repo = (...remotes: [string, string][]) => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-repoid-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [name, url] of remotes) execFileSync('git', ['remote', 'add', name, url], { cwd: dir });
    return dir;
  };

  it('uses origin', () => {
    expect(repoIdentity(repo(['upstream', 'git@github.com:other/fork.git'], ['origin', 'git@github.com:acme/webapp.git']))).toEqual({ repoId: 'github.com/acme/webapp' });
  });

  it('explains a repo without a usable remote', () => {
    expect(repoIdentity(repo())).toEqual({ error: expect.stringMatching(/no git remote named origin/) });
    expect(repoIdentity(repo(['origin', '/srv/git/webapp.git']))).toEqual({ error: expect.stringMatching(/not a hosted repo URL/) });
  });
});
