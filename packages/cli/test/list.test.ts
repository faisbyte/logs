import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintFile, markProcessed, readState, sessionKey, writeState } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixtureEnv = { CLAUDE_CONFIG_DIR: join(FIXTURES, 'claude-code'), CODEX_HOME: join(FIXTURES, 'codex') };
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

async function run(argv: string[], context: { cwd?: string; env?: Record<string, string> } = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    cwd: context.cwd ?? tempDir('digest-cwd-'),
    env: context.env ?? fixtureEnv,
    homeDir: '/nonexistent-home',
    timeZone: 'UTC',
  });
  return { exitCode, stdout, stderr };
}

const rows = (stdout: string) => stdout.split('\n').slice(1).filter((l) => /^\d{4}-/.test(l));

describe('digest list', () => {
  it('lists Claude Code and Codex sessions for the repo, newest first', async () => {
    const { exitCode, stdout } = await run(['list', '--repo', '/work/acme-webapp']);
    expect(exitCode).toBe(0);
    expect(stdout.split('\n')[0]).toMatch(/^STARTED\s+AGENT\s+SESSION\s+DURATION\s+TURNS\s+TOOLS\s+FILES\s+COMMITS\s+STATUS\s+BRANCH\s+TITLE$/);
    expect(rows(stdout).map((r) => r.split(/\s+/)[3])).toEqual([
      '019c0004',
      '019c0003',
      '019c0002',
      'c1a5e003',
      'c1a5e002',
      '019c0001',
      'c1a5e001',
    ]);
  });

  it('shows timing, counts, branch, status and title for each session', async () => {
    const { stdout } = await run(['list', '--repo', '/work/acme-webapp']);
    const basic = rows(stdout).find((r) => r.includes('c1a5e001'))!;
    expect(basic.split(/\s{2,}/)).toEqual([
      '2026-03-02 09:00',
      'claude-code',
      'c1a5e001',
      '<1m',
      '1',
      '6',
      '2',
      '0',
      'new',
      'feature/PROJ-142-rate-limit',
      'Rate limit login endpoint',
    ]);
  });

  it('falls back to the first prompt when a session has no title', async () => {
    const { stdout } = await run(['list', '--repo', '/work/acme-webapp']);
    expect(rows(stdout).find((r) => r.includes('019c0001'))).toMatch(/Add a unit test for the login rate limiter\.$/);
  });

  it('ends with a count per agent', async () => {
    const { stdout } = await run(['list', '--repo', '/work/acme-webapp']);
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('7 sessions for /work/acme-webapp (3 Claude Code, 4 Codex)');
  });

  it('prints machine-readable sessions with repo-relative files for --json', async () => {
    const { stdout } = await run(['list', '--json', '--repo', '/work/acme-webapp']);
    const sessions = JSON.parse(stdout);
    expect(sessions).toHaveLength(7);
    expect(sessions.find((s: { sourceSessionId: string }) => s.sourceSessionId.startsWith('c1a5e001'))).toMatchObject({
      agent: 'claude-code',
      status: 'new',
      turnCount: 1,
      toolCallCount: 6,
      filesTouched: ['src/middleware/rateLimit.ts', 'src/routes/login.ts'],
      commitShas: [],
    });
  });

  it('says where it looked when no sessions match', async () => {
    const { exitCode, stdout } = await run(['list', '--repo', '/work/nothing-here']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No Claude Code or Codex sessions found for /work/nothing-here');
    expect(stdout).toContain(join(FIXTURES, 'claude-code', 'projects'));
  });

  it('reports an unreadable state file instead of crashing', async () => {
    const repo = tempDir('digest-badstate-');
    mkdirSync(join(repo, '.digest'));
    writeFileSync(join(repo, '.digest/state.json'), 'not json');
    const { exitCode, stderr } = await run(['list', '--repo', repo]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^digest list: Unreadable \.digest\/state\.json/);
  });

  it('fails with a hint outside a git repo when no --repo is given', async () => {
    const { exitCode, stderr } = await run(['list']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--repo');
  });

  describe('inside a real git repo', () => {
    const repo = tempDir('digest-repo-');
    const claudeDir = tempDir('digest-claude-');
    const git = (args: string[], date?: string) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'dev@example.com']);
    git(['config', 'user.name', 'Dev']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['commit', '-q', '--allow-empty', '-m', 'during session'], '2026-03-02T09:00:30Z');
    mkdirSync(join(repo, 'src'));

    // The basic fixture, relocated into this repo on branch main.
    const session = readFileSync(join(FIXTURES, 'claude-code/projects/-work-acme-webapp/c1a5e001-0000-4000-8000-000000000001.jsonl'), 'utf8')
      .replaceAll('/work/acme-webapp', repo)
      .replaceAll('feature/PROJ-142-rate-limit', 'main');
    const sessionFile = join(claudeDir, 'projects', 'p', 'c1a5e001-0000-4000-8000-000000000001.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
    writeFileSync(sessionFile, session);
    const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(claudeDir, 'no-codex') };

    it('finds the repo from a subdirectory and counts commits made during the session', async () => {
      const { stdout } = await run(['list', '--json'], { cwd: join(repo, 'src'), env });
      const [listed] = JSON.parse(stdout);
      expect(listed.commitShas).toEqual([git(['rev-parse', 'HEAD'])]);
    });

    it('shows processed and changed sessions from .digest/state.json without writing to it', async () => {
      const key = sessionKey({ agent: 'claude-code', sourceSessionId: 'c1a5e001-0000-4000-8000-000000000001' });
      writeState(repo, markProcessed(readState(repo), key, fingerprintFile(sessionFile), new Date()));
      const stateBefore = readFileSync(join(repo, '.digest/state.json'), 'utf8');

      expect(JSON.parse((await run(['list', '--json'], { cwd: repo, env })).stdout)[0].status).toBe('processed');
      writeFileSync(sessionFile, session + '{"type":"last-prompt"}\n');
      expect(JSON.parse((await run(['list', '--json'], { cwd: repo, env })).stdout)[0].status).toBe('changed');
      expect(readFileSync(join(repo, '.digest/state.json'), 'utf8')).toBe(stateBefore);
    });
  });
});
