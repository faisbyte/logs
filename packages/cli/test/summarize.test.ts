import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLlmClient } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { fixtureRepo, reply, tempDir } from './helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

async function run(argv: string[], env: Record<string, string>, extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    cwd: tempDir('digest-cwd-'),
    env,
    homeDir: '/nonexistent-home',
    ...extra,
  });
  return { exitCode, stdout, stderr };
}

describe('digest summarize', () => {
  it('summarises one session into a draft and marks it processed', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
    const { exitCode, stdout } = await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^c1a5e001 +summarised +[\d,]+ in \/ [\d,]+ out tokens +\$\d+\.\d{4}$/m);
    expect(stdout).toContain('Drafts are in .digest/summaries/');
    const draft = JSON.parse(readFileSync(join(repo, '.digest/summaries/claude-code-c1a5e001-0000-4000-8000-000000000001.json'), 'utf8'));
    expect(draft).toMatchObject({ status: 'draft', ticketRefs: ['PROJ-142'] });
    const list = await run(['list', '--json', '--repo', repo], env);
    expect(JSON.parse(list.stdout).find((s: { sourceSessionId: string }) => s.sourceSessionId.startsWith('c1a5e001')).status).toBe('processed');
  });

  describe('ticket keys from commit messages (DECISIONS.md D44)', () => {
    // A commit on the session's branch inside its time window (09:00:00 to 09:00:54).
    function withCommit(message: string) {
      const { repo, env } = fixtureRepo();
      const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2026-03-02T09:00:30Z', GIT_COMMITTER_DATE: '2026-03-02T09:00:30Z' } });
      git(['checkout', '-q', '-b', 'feature/PROJ-142-rate-limit']);
      git(['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message]);
      return { repo, env };
    }
    const draftOf = (repo: string) => JSON.parse(readFileSync(join(repo, '.digest/summaries/claude-code-c1a5e001-0000-4000-8000-000000000001.json'), 'utf8'));

    it('adds keys from commit messages for the configured projects only', async () => {
      const { repo, env } = withCommit('PROJ-150: limiter tests. Hash keys with SHA-256, ask GPT-4 for UTF-8 names');
      mkdirSync(join(repo, '.digest'), { recursive: true });
      writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ tickets: { keys: ['PROJ'] } }));
      await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
      expect(draftOf(repo)).toMatchObject({ ticketRefs: ['PROJ-142', 'PROJ-150'], ticketSources: { 'PROJ-142': 'branch', 'PROJ-150': 'commit' } });
      expect(readFileSync(join(repo, '.digest/summaries/claude-code-c1a5e001-0000-4000-8000-000000000001.json'), 'utf8')).not.toContain('limiter tests');
    });

    it('ignores commit messages when no project keys are configured', async () => {
      const { repo, env } = withCommit('PROJ-150: limiter tests');
      await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
      expect(draftOf(repo)).toMatchObject({ ticketRefs: ['PROJ-142'], ticketSources: { 'PROJ-142': 'branch' } });
    });

    it('applies a changed ticket config to a cached draft on the next run', async () => {
      const { repo, env } = withCommit('PROJ-150: limiter tests');
      const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
      await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
      writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ tickets: { keys: ['PROJ'] } }));
      await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
      expect(llm.requests).toHaveLength(1);
      expect(draftOf(repo).ticketRefs).toEqual(['PROJ-142', 'PROJ-150']);
    });
  });

  it('saves files relative to the repo root, even for a session launched in a subdirectory', async () => {
    const { repo, env } = fixtureRepo();
    await run(['summarize', 'c1a5e003', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
    const draft = JSON.parse(readFileSync(join(repo, '.digest/summaries/claude-code-c1a5e003-0000-4000-8000-000000000003.json'), 'utf8'));
    expect(draft.filesTouched).toContain('packages/api/src/admin/users.ts');
    expect(draft.filesTouched).toContain('notebooks/audit-volume.ipynb');
    expect(draft.filesTouched.every((f: string) => !f.startsWith('/'))).toBe(true);
  });

  it('serves an unchanged session from the cache on the next run', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
    await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
    const second = await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
    expect(second.stdout).toMatch(/^c1a5e001 +cached$/m);
    expect(llm.requests).toHaveLength(1);
  });

  it('summarises every non-empty session with --all', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
    const { exitCode, stdout } = await run(['summarize', '--all', '--yes', '--repo', repo], env, { llm });
    expect(exitCode).toBe(0);
    expect(stdout.match(/ summarised /g)).toHaveLength(6);
    expect(stdout).not.toContain('019c0004');
  });

  it('prints the plan and estimated cost for --estimate without calling the model or writing anything', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
    const { exitCode, stdout } = await run(['summarize', '--all', '--estimate', '--repo', repo], env, { llm });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/6 sessions to summarise with claude-haiku-5-5 \(0 cached\): about [\d,]+ input and [\d,]+ output tokens, estimated \$\d+\.\d{4}/);
    expect(llm.requests).toEqual([]);
    expect(existsSync(join(repo, '.digest'))).toBe(false);
  });

  it('asks before sending more than one session, and stops if the answer is no', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
    const questions: string[] = [];
    const confirm = async (q: string) => (questions.push(q), false);
    const { exitCode, stderr } = await run(['summarize', '--all', '--repo', repo], env, { llm, confirm });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/Send 6 sessions to claude-haiku-5-5 for about \$\d+\.\d{4}\? \[y\/N\]/);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Cancelled');
    expect(llm.requests).toEqual([]);
  });

  it('goes ahead when confirmed, and skips the question with --yes or for a single session', async () => {
    const { repo, env } = fixtureRepo();
    let asked = 0;
    const confirm = async () => (asked++, true);
    expect((await run(['summarize', '--all', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5'), confirm })).exitCode).toBe(0);
    const other = fixtureRepo();
    await run(['summarize', '--all', '--yes', '--repo', other.repo], other.env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5'), confirm });
    await run(['summarize', 'c1a5e002', '--repo', fixtureRepo().repo], other.env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5'), confirm });
    expect(asked).toBe(1);
  });

  it('refuses a multi-session run it cannot ask about, pointing at --yes', async () => {
    const { repo, env } = fixtureRepo();
    const { exitCode, stderr } = await run(['summarize', '--all', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--yes');
  });

  it('explains how to provide the API key when it is missing', async () => {
    const { repo, env } = fixtureRepo();
    const { exitCode, stderr } = await run(['summarize', 'c1a5e001', '--repo', repo], env);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('ANTHROPIC_API_KEY');
  });

  it('reports a session that fails and carries on with the rest', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient((request) => (request.messages[0]!.content.includes('Add rate limiting') ? 'not json' : reply(request)), 'claude-haiku-5-5');
    const { exitCode, stdout } = await run(['summarize', '--all', '--yes', '--repo', repo], env, { llm });
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^c1a5e001 +failed: Summary for c1a5e001-.* failed validation twice/m);
    expect(stdout.match(/ summarised /g)).toHaveLength(5);
  });

  it('rejects empty sessions, unknown ids and a missing selection', async () => {
    const { repo, env } = fixtureRepo();
    const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
    expect((await run(['summarize', '019c0004', '--repo', repo], env, { llm })).stderr).toContain('empty');
    expect((await run(['summarize', 'ffffffff', '--repo', repo], env, { llm })).stderr).toContain('No session matching');
    expect((await run(['summarize', '--repo', repo], env, { llm })).stderr).toContain('session id or --all');
    expect(llm.requests).toEqual([]);
  });

  it('skips a repo that does not exist, without creating it', async () => {
    const { env } = fixtureRepo();
    const gone = join(tmpdir(), `digest-gone-${Date.now()}`);
    const { exitCode, stderr } = await run(['summarize', 'c1a5e001', '--repo', gone], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`skipped: ${gone} does not exist`);
    expect(existsSync(gone)).toBe(false);
  });

  it('skips a directory that is not in a git repo, and the home directory', async () => {
    const { repo, env } = fixtureRepo();
    const plain = tempDir('digest-plain-');
    expect((await run(['summarize', '--all', '--repo', plain], env, { llm: new FakeLlmClient(reply) })).stderr).toContain('is not inside a git repository');
    const asHome = await run(['summarize', '--all', '--repo', repo], env, { llm: new FakeLlmClient(reply), homeDir: repo });
    expect(asHome.stderr).toContain('home directory');
    expect(existsSync(join(plain, '.digest'))).toBe(false);
  });

  it('honours the model and redaction settings in .digest/config.json', async () => {
    const { repo, env } = fixtureRepo();
    mkdirSync(join(repo, '.digest'));
    writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ summarize: { model: 'claude-sonnet-5-5' }, redaction: { deny: ['login'] } }));
    const llm = new FakeLlmClient(reply, 'claude-sonnet-5-5');
    const { stdout } = await run(['summarize', 'c1a5e001', '--estimate', '--repo', repo], env, { llm });
    expect(stdout).toContain('with claude-sonnet-5-5');
    await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
    expect(llm.requests[0]!.messages[0]!.content).not.toContain('login');
  });

  describe('with reviewed summaries', () => {
    const draftFile = (repo: string) => join(repo, '.digest/summaries/claude-code-c1a5e001-0000-4000-8000-000000000001.json');
    const summarised = async (repo: string, env: Record<string, string>) => {
      await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
    };

    it.each([
      ['approved', 'approve'],
      ['edited', 'edit'],
    ])('never re-summarises a summary the developer has %s, even by id', async (label, action) => {
      const { repo, env } = fixtureRepo();
      await summarised(repo, env);
      if (action === 'approve') await run(['approve', 'c1a5e001', '--repo', repo], env);
      else writeFileSync(draftFile(repo), JSON.stringify({ ...JSON.parse(readFileSync(draftFile(repo), 'utf8')), editedByDeveloper: true, goal: 'Edited.' }));
      writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ summarize: { chunkTokens: 20_000 } })); // a cache miss
      const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
      const byId = await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
      expect(byId.stdout).toMatch(new RegExp(`^c1a5e001 +kept: ${label} summaries are never re-summarised$`, 'm'));
      const all = await run(['summarize', '--all', '--yes', '--repo', repo], env, { llm });
      expect(all.stdout).toMatch(/^c1a5e001 +kept/m);
      expect(llm.requests.some((r) => r.messages[0]!.content.includes('Add rate limiting'))).toBe(false);
      expect(JSON.parse(readFileSync(draftFile(repo), 'utf8')).status).toBe(action === 'approve' ? 'approved' : 'draft');
    });

    it('skips rejected summaries with --all, and re-summarises one only when asked for it by id', async () => {
      const { repo, env } = fixtureRepo();
      await summarised(repo, env);
      await run(['reject', 'c1a5e001', '--repo', repo], env);
      writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ summarize: { chunkTokens: 20_000 } }));
      const llm = new FakeLlmClient(reply, 'claude-haiku-5-5');
      const all = await run(['summarize', '--all', '--yes', '--estimate', '--repo', repo], env, { llm });
      expect(all.stdout).toMatch(/^5 sessions to summarise/m);
      expect((await run(['summarize', '--all', '--yes', '--repo', repo], env, { llm })).stdout).toMatch(/^c1a5e001 +skipped: rejected$/m);
      expect(JSON.parse(readFileSync(draftFile(repo), 'utf8')).status).toBe('rejected');
      await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm });
      expect(JSON.parse(readFileSync(draftFile(repo), 'utf8')).status).toBe('draft');
    });

    it('auto-approves new summaries when the config says so, marked as automatic', async () => {
      const { repo, env } = fixtureRepo();
      mkdirSync(join(repo, '.digest'));
      writeFileSync(join(repo, '.digest/config.json'), JSON.stringify({ review: { autoApprove: true } }));
      const { stdout } = await run(['summarize', 'c1a5e001', '--repo', repo], env, { llm: new FakeLlmClient(reply, 'claude-haiku-5-5') });
      expect(stdout).toMatch(/^c1a5e001 +summarised .* approved automatically$/m);
      expect(JSON.parse(readFileSync(draftFile(repo), 'utf8'))).toMatchObject({ status: 'approved', approvedBy: 'auto' });
      expect((await run(['review', '--list', '--repo', repo], env)).stdout).toContain('approved automatically');
    });

    it('leaves new summaries as drafts by default', async () => {
      const { repo, env } = fixtureRepo();
      await summarised(repo, env);
      expect(JSON.parse(readFileSync(draftFile(repo), 'utf8'))).toMatchObject({ status: 'draft', approvedBy: null });
    });
  });
});
