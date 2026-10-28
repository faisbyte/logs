import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeLlmClient, type LlmRequest } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { llmSummary } from '../../core/test/summarize/helpers.js';
import { runCli, type CliIo } from '../src/cli.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Copies every fixture session, rewriting /work/acme-webapp to a temp repo the CLI can write .digest/ into. */
function fixtureRepo() {
  const repo = tempDir('digest-sum-repo-');
  const home = tempDir('digest-sum-agents-');
  cpSync(join(FIXTURES, 'claude-code'), join(home, 'claude'), { recursive: true });
  cpSync(join(FIXTURES, 'codex'), join(home, 'codex'), { recursive: true });
  const rewrite = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) rewrite(path);
      else if (name.endsWith('.jsonl')) writeFileSync(path, readFileSync(path, 'utf8').replaceAll('/work/acme-webapp', repo));
    }
  };
  rewrite(home);
  return { repo, env: { CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') } };
}

const reply = (request: LlmRequest) =>
  request.system.startsWith('You are merging')
    ? JSON.stringify({ goal: 'g', outcome: 'completed', whatWasDone: 'w', aiInvolvement: 'moderate' })
    : JSON.stringify(llmSummary());

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
});
