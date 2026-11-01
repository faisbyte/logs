// The Phase 8 context A/B experiment (docs/context-experiment.md, DECISIONS.md D80, D84).
//   node scripts/context-experiment/harness.mjs selftest   checks the scoring with two reference solutions (free)
//   node scripts/context-experiment/harness.mjs brief      extracts the teammates' items and saves the real brief (one model call)
//   node scripts/context-experiment/harness.mjs check      one short isolated claude -p run, proving the isolation
//   node scripts/context-experiment/harness.mjs pilot      2 runs per arm, A B A B, scored by the hidden tests
// EXPERIMENT_WORK must name a scratch directory outside any repo: run copies and transcripts go there. Results go to
// .digest/experiment/. ANTHROPIC_API_KEY comes from the environment or the repo's .env and is never printed.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const FIXTURE = join(HERE, 'fixture');
const MODEL = 'claude-sonnet-5-5';
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1;
const TASK =
  "Add an account lockout to src/auth/login.js: after 5 failed logins for an account, lock it for 15 minutes. A locked account gets { ok: false, reason: 'locked' }, even with the right password. Add tests. Keep the change small.";

const core = await import(join(REPO, 'packages/core/dist/index.js'));
const results = core.ensureDigestDir(REPO, 'experiment');
const work = () => {
  const dir = process.env.EXPERIMENT_WORK;
  if (!dir || !existsSync(dir)) throw new Error('set EXPERIMENT_WORK to an existing scratch directory outside any repo.');
  return dir;
};
const save = (name, value) => writeFileSync(join(results, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const line = readFileSync(join(REPO, '.env'), 'utf8').split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const key = line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set and not in .env.');
  return key;
}

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const ext = join(homedir(), '.vscode/extensions');
  const latest = readdirSync(ext).filter((d) => d.startsWith('anthropic.claude-code-')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  if (!latest) throw new Error('no claude binary: set CLAUDE_BIN.');
  return join(ext, latest, 'resources/native-binary/claude');
}

const sh = (command, args, cwd, extra = {}) => {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
  if (r.error) throw r.error;
  return r;
};

/** A fresh copy of the fixture with its own one-commit git history. */
function freshRepo(dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  const git = (...args) => sh('git', ['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', ...args], dir);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'login-service');
  return dir;
}

// ---- Hidden tests: kept here, written into a run's copy only after the agent has exited. ----

const HIDDEN_INSTANCE = `// One login-service process: runs logins against a key-value state file shared with other processes.
import { readFileSync, writeFileSync } from 'node:fs';
import { hashPassword } from '../src/auth/password.js';
import { createLogin } from '../src/auth/login.js';
import { createKv } from '../src/lib/kv.js';
import { memoryUsers } from '../src/users/store.js';

const [stateFile, clockMs, attempts] = process.argv.slice(2);
const state = new Map(Object.entries(JSON.parse(readFileSync(stateFile, 'utf8'))));
const transport = {
  async get(key) { return state.get(key) ?? null; },
  async set(key, raw) { state.set(key, raw); },
  async delete(key) { state.delete(key); },
};
const users = memoryUsers([{ id: 'u1', email: 'ana@example.com', name: 'Ana', passwordHash: hashPassword('right horse') }]);
const login = createLogin({ users, kv: createKv(transport), clock: () => Number(clockMs) });
const out = [];
for (const password of attempts.split(',')) out.push(await login('ana@example.com', password));
writeFileSync(stateFile, JSON.stringify(Object.fromEntries(state)));
process.stdout.write(JSON.stringify(out.at(-1)));
`;

const HIDDEN_TEST = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogin } from '../src/auth/login.js';
import { hashPassword } from '../src/auth/password.js';
import { createKv, memoryTransport } from '../src/lib/kv.js';
import { memoryUsers } from '../src/users/store.js';

const EMAIL = 'ana@example.com';
const RIGHT = 'right horse';

test('task: 5 failed logins lock the account for 15 minutes', async () => {
  let t = 1_700_000_000_000;
  const clock = () => t;
  const users = memoryUsers([{ id: 'u1', email: EMAIL, name: 'Ana', passwordHash: hashPassword(RIGHT) }]);
  const login = createLogin({ users, kv: createKv(memoryTransport({ now: clock })), clock });
  for (let i = 0; i < 5; i++) assert.equal((await login(EMAIL, 'wrong')).ok, false);
  assert.deepEqual(await login(EMAIL, RIGHT), { ok: false, reason: 'locked' });
  t += 15 * 60 * 1000 + 1000;
  assert.equal((await login(EMAIL, RIGHT)).ok, true);
});

test('trap: the count is shared between instances and survives a restart', () => {
  // Two separate processes sharing only the key-value store: what three instances and a deploy look like.
  const instance = fileURLToPath(new URL('./instance.mjs', import.meta.url));
  const state = join(mkdtempSync(join(tmpdir(), 'lockout-')), 'kv.json');
  writeFileSync(state, '{}');
  const run = (attempts) => {
    const r = spawnSync(process.execPath, [instance, state, '1700000000000', attempts.join(',')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  run(['wrong', 'wrong', 'wrong']);
  assert.equal(run(['wrong', 'wrong', RIGHT]).reason, 'locked');
});
`;

function score(repo) {
  // The agent's own and the fixture's tests first, before the hidden ones exist.
  const visibleTestsPass = sh(process.execPath, ['--test'], repo).status === 0;
  mkdirSync(join(repo, 'test-hidden'), { recursive: true });
  writeFileSync(join(repo, 'test-hidden/instance.mjs'), HIDDEN_INSTANCE);
  writeFileSync(join(repo, 'test-hidden/lockout.hidden.test.js'), HIDDEN_TEST);
  const passes = (name) => sh(process.execPath, ['--test', `--test-name-pattern=^${name}:`, 'test-hidden/lockout.hidden.test.js'], repo).status === 0;
  const task = passes('task');
  const trapAvoided = passes('trap');
  const auth = readdirSync(join(repo, 'src/auth')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(repo, 'src/auth', f), 'utf8')).join('\n');
  return { taskDone: task, trapAvoided, fellIn: task && !trapAvoided, importsCache: /lib\/cache\.js/.test(auth), visibleTestsPass };
}

// ---- selftest: the scoring against two reference solutions and the untouched fixture. ----

const GOOD = `import { verifyPassword } from './password.js';
import { createSession } from './session.js';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export function createLogin({ users, kv, clock = () => Date.now() }) {
  return async function login(email, password) {
    const key = \`lockout:\${email.trim().toLowerCase()}\`;
    const state = (await kv.get(key)) ?? { failures: 0, lockedUntil: 0 };
    if (state.lockedUntil > clock()) return { ok: false, reason: 'locked' };
    const user = await users.findByEmail(email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const failures = state.lockedUntil ? 1 : state.failures + 1;
      await kv.set(key, { failures, lockedUntil: failures >= MAX_FAILURES ? clock() + LOCK_MS : 0 });
      return { ok: false, reason: 'invalid' };
    }
    await kv.delete(key);
    const token = await createSession(kv, user.id);
    return { ok: true, userId: user.id, token };
  };
}
`;
const TRAP = `import { cache } from '../lib/cache.js';
import { verifyPassword } from './password.js';
import { createSession } from './session.js';

const LOCK_MS = 15 * 60 * 1000;

export function createLogin({ users, kv, clock = () => Date.now() }) {
  return async function login(email, password) {
    const key = \`failures:\${email.trim().toLowerCase()}\`;
    if ((cache.get(key, clock()) ?? 0) >= 5) return { ok: false, reason: 'locked' };
    const user = await users.findByEmail(email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) {
      cache.increment(key, LOCK_MS, clock());
      return { ok: false, reason: 'invalid' };
    }
    cache.delete(key);
    const token = await createSession(kv, user.id);
    return { ok: true, userId: user.id, token };
  };
}
`;

function selftest() {
  const base = join(work(), 'selftest', String(Date.now()));
  const cases = { untouched: null, good: GOOD, trap: TRAP };
  const got = Object.fromEntries(
    Object.entries(cases).map(([name, code]) => {
      const repo = freshRepo(join(base, name));
      if (code) writeFileSync(join(repo, 'src/auth/login.js'), code);
      return [name, score(repo)];
    }),
  );
  console.log(JSON.stringify(got, null, 2));
  const ok = !got.untouched.taskDone && got.good.taskDone && got.good.trapAvoided && got.trap.taskDone && got.trap.fellIn && got.trap.importsCache;
  console.log(ok ? 'selftest: the scoring tells the solutions apart' : 'selftest: FAILED');
  return ok ? 0 : 1;
}

// ---- brief: the teammates' summaries through the real pipeline and the real sprintdigest context command. ----

async function brief() {
  const set = JSON.parse(readFileSync(join(HERE, 'summaries.json'), 'utf8'));
  const store = new core.InMemorySummaryStore();
  const base = { agent: 'claude-code', status: 'draft', editedByDeveloper: false, approvedAt: null, generatedAt: '2026-02-24T00:00:00.000Z', promptVersion: 'experiment', model: 'experiment', usage: { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 }, aiInvolvement: 'heavy' };
  for (const { developer, ...s } of set.summaries) {
    const result = await store.push({ repoId: set.repoId, developerId: developer, developerName: developer }, core.uploadPayload(core.approve(core.SessionSummarySchema.parse({ ...base, ...s }))));
    if (result.status !== 'created') throw new Error(`push of ${developer}'s summary: ${JSON.stringify(result)}`);
  }
  const input = core.contextInput(await store.list({ repoId: set.repoId }));
  const estimate = core.estimateContextCost(input, MODEL);
  console.log(`extraction: about $${estimate.costUsd.toFixed(4)} (one call, ${MODEL})`);
  const llm = core.AnthropicLlmClient.fromEnv({ ...process.env, ANTHROPIC_API_KEY: apiKey() }, MODEL, 'medium');
  const extraction = await core.extractContext(input, llm);
  await store.applyContextChanges(set.repoId, extraction.changes);

  // The real CLI command, in-process, against that store, from a git checkout whose origin is the fixture's repo id.
  const repo = freshRepo(join(work(), 'brief', String(Date.now())));
  sh('git', ['remote', 'add', 'origin', 'git@github.com:acme/login-service.git'], repo);
  const { runCli } = await import(join(REPO, 'packages/cli/dist/cli.js'));
  const pushTarget = core.localPushTarget(store, (await store.issueToken({ repoId: set.repoId, developerId: 'erin', developerName: 'Erin' })).token);
  let out = '';
  let err = '';
  const code = await runCli(['context', 'src/auth', '--repo', repo], { stdout: (s) => (out += s), stderr: (s) => (err += s), pushTarget, env: {} });
  if (code !== 0) throw new Error(`sprintdigest context failed: ${err}`);
  const lines = out.split('\n').filter((l) => l.startsWith('- '));
  const trap = lines.filter((l) => /cache/i.test(l) && /(instance|deploy)/i.test(l));
  save('brief.md', out);
  save('brief-extraction.json', { model: extraction.model, usage: extraction.usage, retryReasons: extraction.retryReasons, dropped: extraction.dropped, items: extraction.changes.added });
  console.log(out);
  console.log(`items in the brief: ${lines.length} (${trap.length} carrying the trap's reason); extraction cost $${extraction.usage.costUsd?.toFixed(4)}${extraction.retried ? `, retried: ${extraction.retryReasons.join('; ')}` : ''}`);
  const ok = trap.length === 1 && lines.length >= 7 && lines.length <= 9;
  console.log(ok ? 'brief: bob\'s item sits among 6-8 others' : 'brief: NOT as designed (see above); do not run the pilot with it');
  return ok ? 0 : 1;
}

// ---- One isolated claude -p run. ----

function runClaude(dir, prompt, maxTurns) {
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_API_KEY: apiKey(),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const args = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns), '--max-budget-usd', String(MAX_BUDGET_USD), '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', 'project', '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm test)', 'Bash(node --test:*)'];
  const r = sh(claudeBin(), args, join(dir, 'repo'), { env, timeout: 20 * 60 * 1000 });
  writeFileSync(join(dir, 'stream.jsonl'), r.stdout);
  if (r.stderr) writeFileSync(join(dir, 'stderr.txt'), r.stderr);
  const events = r.stdout.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  return { status: r.status, init: events.find((e) => e.type === 'system' && e.subtype === 'init'), result: events.find((e) => e.type === 'result'), home };
}

/** Directory names and modification times under a path, for a before-and-after comparison. */
const snapshot = (path) => (existsSync(path) ? readdirSync(path).map((n) => `${n}@${statSync(join(path, n)).mtimeMs}`).sort().join('\n') : '(missing)');
const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : null);
function instructionFilesAbove(dir) {
  const found = [];
  for (let d = dir; ; d = dirname(d)) {
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) if (existsSync(join(d, f))) found.push(join(d, f));
    if (dirname(d) === d) return found;
  }
}

function check() {
  const dir = join(work(), 'check', String(Date.now()));
  freshRepo(join(dir, 'repo'));
  const projects = join(homedir(), '.claude/projects');
  const before = { projects: snapshot(projects), claudeJson: mtime(join(homedir(), '.claude.json')) };
  const run = runClaude(dir, 'Reply with the single word OK. Do not use any tools.', 1);
  const after = { projects: snapshot(projects), claudeJson: mtime(join(homedir(), '.claude.json')) };
  const own = join(run.home, '.claude/projects');
  const init = run.init ?? {};
  const listed = (key) => (Array.isArray(init[key]) ? init[key] : null);
  const checks = {
    'the run finished': run.status === 0 && run.result?.subtype === 'success',
    'init event present': Boolean(run.init),
    'used ANTHROPIC_API_KEY': init.apiKeySource === 'ANTHROPIC_API_KEY',
    [`model is ${MODEL}`]: init.model === MODEL && Object.keys(run.result?.modelUsage ?? {}).every((m) => m.startsWith(MODEL)),
    'no MCP servers': (listed('mcp_servers') ?? []).length === 0,
    'no plugins': (listed('plugins') ?? []).length === 0,
    'no user skills': (listed('skills') ?? []).every((s) => !String(typeof s === 'string' ? s : s?.path ?? '').includes(homedir())),
    'owner ~/.claude/projects unchanged': before.projects === after.projects,
    'owner ~/.claude.json unchanged': before.claudeJson === after.claudeJson,
    "session written to the run's own config": existsSync(own) && readdirSync(own).length > 0,
    'no CLAUDE.md or AGENTS.md at or above the run': instructionFilesAbove(join(dir, 'repo')).length === 0 && instructionFilesAbove(run.home).length === 0,
  };
  const report = { at: new Date().toISOString(), claude: sh(claudeBin(), ['--version'], dir, { env: { PATH: process.env.PATH, HOME: run.home, CLAUDE_CONFIG_DIR: join(run.home, '.claude') } }).stdout.trim(), checks, init, costUsd: run.result?.total_cost_usd ?? null, modelUsage: run.result?.modelUsage ?? null };
  save('isolation-check.json', report);
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  console.log(`init event keys: ${Object.keys(init).join(', ')}`);
  console.log(`cost: $${report.costUsd}`);
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

// ---- pilot ----

function pilot() {
  const isolation = JSON.parse(readFileSync(join(results, 'isolation-check.json'), 'utf8'));
  if (!Object.values(isolation.checks).every(Boolean)) throw new Error('the isolation check has not passed; run check first.');
  const theBrief = readFileSync(join(results, 'brief.md'), 'utf8');
  const base = join(work(), 'pilot', String(Date.now()));
  const runs = [];
  for (const [n, arm] of ['A', 'B', 'A', 'B'].entries()) {
    const dir = join(base, `${n + 1}-${arm}`);
    const repo = freshRepo(join(dir, 'repo'));
    const prompt = arm === 'A' ? `${theBrief.trimEnd()}\n\n${TASK}` : TASK;
    writeFileSync(join(dir, 'prompt.txt'), prompt);
    console.log(`run ${n + 1} (arm ${arm})…`);
    const run = runClaude(dir, prompt, MAX_TURNS);
    const scored = score(repo);
    const row = {
      run: n + 1,
      arm,
      ...scored,
      models: Object.keys(run.result?.modelUsage ?? {}),
      costUsd: run.result?.total_cost_usd ?? null,
      turns: run.result?.num_turns ?? null,
      finished: run.result?.subtype ?? `exit ${run.status}`,
      dir,
    };
    runs.push(row);
    console.log(`  task ${row.taskDone ? 'done' : 'NOT done'}, ${row.taskDone ? (row.fellIn ? 'FELL INTO THE TRAP' : 'avoided the trap') : 'trap not scored'}, $${row.costUsd?.toFixed(4)}, ${row.turns} turns, ${row.models.join(', ')}, ${row.finished}`);
  }
  const bFellIn = runs.filter((r) => r.arm === 'B' && r.fellIn).length;
  const summary = { at: new Date().toISOString(), model: MODEL, claude: isolation.claude, runs, gate: { noBriefFellIn: bFellIn, passed: bFellIn >= 1 }, totalCostUsd: runs.reduce((n, r) => n + (r.costUsd ?? 0), 0) };
  save('pilot.json', summary);
  console.log(`gate: the no-brief arm fell in ${bFellIn} of 2 times: ${bFellIn >= 1 ? 'passed' : 'FAILED, the trap is too easy; stop and redesign'}`);
  console.log(`total cost: $${summary.totalCostUsd.toFixed(4)}`);
  return 0;
}

const commands = { selftest, brief, check, pilot };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: node scripts/context-experiment/harness.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
process.exitCode = await command();
