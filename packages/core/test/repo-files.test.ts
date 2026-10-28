import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeFile } from '../src/parsers/claude-code.js';
import { prepareSessionForRepo, repoFiles } from '../src/repo-files.js';
import { claude } from './fixtures.js';

const repo = '/work/acme-webapp';
const base = parseClaudeCodeFile(claude.basic)!;
const withFiles = (filesTouched: string[]) => ({ ...base, filesTouched });

describe('repoFiles', () => {
  it('writes paths inside the repo relative to the repo root, even from a subdirectory cwd', () => {
    expect(repoFiles(withFiles([`${repo}/packages/api/src/a.ts`, `${repo}/README.md`]), repo)).toEqual(['README.md', 'packages/api/src/a.ts']);
  });

  it('maps Claude Code worktree paths back to the repo-relative path, once', () => {
    const files = [`${repo}/.claude/worktrees/agent-a1b2/src/search/query.ts`, `${repo}/.claude/worktrees/feature-x/src/search/query.ts`, `${repo}/src/search/query.ts`];
    expect(repoFiles(withFiles(files), repo)).toEqual(['src/search/query.ts']);
  });

  it('drops temp, scratchpad, ~/.claude and other paths outside the repo', () => {
    const files = [
      '/tmp/digest-test/x.ts',
      '/private/tmp/claude-501/scratchpad/notes.md',
      '/private/var/folders/05/T/digest-git-abc/y.ts',
      `${homedir()}/.claude/projects/p/memory/MEMORY.md`,
      '~/.claude/settings.json',
      '/work/other-project/z.ts',
      '/work/acme-webapp-legacy/w.ts',
      `${repo}/src/kept.ts`,
    ];
    expect(repoFiles(withFiles(files), repo)).toEqual(['src/kept.ts']);
  });
});

describe('prepareSessionForRepo', () => {
  function gitRepo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'digest-files-')));
    const git = (args: string[], date?: string) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'dev@example.com']);
    git(['config', 'user.name', 'Dev']);
    git(['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/limiter.ts'), 'x');
    writeFileSync(join(dir, 'README.md'), 'y');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'during'], '2026-03-02T09:00:30Z');
    return dir;
  }
  const relocated = (dir: string, filesTouched: string[]) => ({ ...base, cwd: dir, gitBranch: 'main', gitBranches: ['main'], filesTouched });

  it('fills commit SHAs made during the session', () => {
    const dir = gitRepo();
    expect(prepareSessionForRepo(relocated(dir, [`${dir}/src/limiter.ts`]), dir).commitShas).toHaveLength(1);
  });

  it('falls back to the files changed in those commits when the transcript shows none', () => {
    const dir = gitRepo();
    expect(prepareSessionForRepo(relocated(dir, ['/tmp/elsewhere.ts']), dir).filesTouched).toEqual(['README.md', 'src/limiter.ts']);
  });

  it('keeps transcript files when there are some', () => {
    const dir = gitRepo();
    expect(prepareSessionForRepo(relocated(dir, [`${dir}/src/limiter.ts`]), dir).filesTouched).toEqual(['src/limiter.ts']);
  });

  it('normalises subagent files the same way', () => {
    const dir = gitRepo();
    const session = { ...relocated(dir, []), subagents: [{ agentType: 'x', description: null, prompt: null, finalText: null, filesTouched: [`${dir}/.claude/worktrees/agent-1/src/a.ts`, '/tmp/b.ts'], toolCallCount: 1 }] };
    expect(prepareSessionForRepo(session, dir).subagents[0]!.filesTouched).toEqual(['src/a.ts']);
  });
});
