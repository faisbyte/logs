// The Phase 8 context A/B experiment, round 2 (docs/context-experiment.md, DECISIONS.md D80, D84, D85). Round 1's
// login-service harness is in git history.
//   node scripts/context-experiment/harness.mjs selftest   checks each candidate's scoring with reference solutions (free)
//   node scripts/context-experiment/harness.mjs estimate   the pilot's cost estimate (free)
//   node scripts/context-experiment/harness.mjs brief      extracts the teammates' items and saves both real briefs (one model call)
//   node scripts/context-experiment/harness.mjs check      one short isolated claude -p run, proving the isolation
//   node scripts/context-experiment/harness.mjs pilot      per candidate 3 runs without the brief and 1 with it, scored by hidden tests
// Run copies and transcripts go to .digest/experiment/work/ (gitignored), results to .digest/experiment/round2/.
// ANTHROPIC_API_KEY comes from the environment or the repo's .env and is never printed.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const FIXTURE = join(HERE, 'fixture-billing');
const MODEL = 'claude-sonnet-5-5';
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1;
const RUN_USD = { typical: 0.08, high: 0.12 };

const core = await import(join(REPO, 'packages/core/dist/index.js'));
const results = core.ensureDigestDir(REPO, 'experiment', 'round2');
const work = core.ensureDigestDir(REPO, 'experiment', 'work');
const save = (name, value) => writeFileSync(join(results, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

// ---- The two candidates: task, brief target, hidden tests and reference solutions. ----

const PARSE_CSV = `
/** RFC 4180 rows from CSV text. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\\n' || c === '\\r') {
      if (c === '\\r' && text[i + 1] === '\\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f !== ''));
}`;

const CANDIDATES = {
  ledgerly: {
    title: 'Ledgerly dates',
    task: 'Add a CSV export of invoices in src/invoices/export.js: exportInvoices(invoices) returns comma-separated CSV text (RFC 4180) with a header row and the columns number, date, customer, total, for customers to import into their accounting software. Add tests. Keep the change small.',
    target: 'src/invoices',
    carriesTrap: (line) => /ledgerly/i.test(line) && /DD\.MM\.YYYY/.test(line),
    hidden: {
      'test-hidden/export.hidden.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { exportInvoices } from '../src/invoices/export.js';
${PARSE_CSV}
const invoices = [
  { number: 'INV-2026-0042', issuedAt: '2026-03-02T10:15:00.000Z', customer: 'Mehta & Sons', totalCents: 129900 },
  { number: 'INV-2026-0043', issuedAt: '2026-03-14T09:00:00.000Z', customer: 'Smith, Jones "and" Co', totalCents: 5000 },
];
const rows = async () => parseCsv(String(await exportInvoices(invoices)));

test('task: a header and one RFC 4180 row per invoice, with numbers, customers and totals', async () => {
  const [header, first, second, ...rest] = await rows();
  assert.deepEqual(header.map((h) => h.trim().toLowerCase()), ['number', 'date', 'customer', 'total']);
  assert.equal(rest.length, 0);
  assert.equal(first[0], 'INV-2026-0042');
  assert.equal(first[2], 'Mehta & Sons');
  assert.equal(second[2], 'Smith, Jones "and" Co');
  assert.match(first[3], /^1[ ,.]?299([.,]00)?$/);
});

test('trap: dates are DD.MM.YYYY, the only format Ledgerly imports', async () => {
  const [, first, second] = await rows();
  assert.equal(first[1], '02.03.2026');
  assert.equal(second[1], '14.03.2026');
});
`,
    },
    hiddenTest: 'test-hidden/export.hidden.test.js',
    reference: {
      file: 'src/invoices/export.js',
      good: `import { toCsv } from '../lib/csv.js';
import { formatCents } from '../lib/money.js';

const day = (iso) => \`\${iso.slice(8, 10)}.\${iso.slice(5, 7)}.\${iso.slice(0, 4)}\`;

export function exportInvoices(invoices) {
  return toCsv([['number', 'date', 'customer', 'total'], ...invoices.map((i) => [i.number, day(i.issuedAt), i.customer, formatCents(i.totalCents)])]);
}
`,
      trap: `import { toCsv } from '../lib/csv.js';
import { formatCents } from '../lib/money.js';

export function exportInvoices(invoices) {
  return toCsv([['number', 'date', 'customer', 'total'], ...invoices.map((i) => [i.number, i.issuedAt.slice(0, 10), i.customer, formatCents(i.totalCents)])]);
}
`,
    },
  },
  acmepay: {
    title: 'AcmePay keys',
    task: "Make AcmePay charges safe to retry in src/payments/charge.js: chargeOrder(order, { acmepay }) charges order.totalCents in order.currency for order.customerId. If the request times out (the error has code 'ETIMEDOUT'), retry it once; the customer must never be charged twice. Add tests. Keep the change small.",
    target: 'src/payments',
    carriesTrap: (line) => /idempotency/i.test(line) && /32/.test(line),
    hidden: {
      'test-hidden/charge.hidden.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcmePay } from '../src/payments/acmepay.js';
import { chargeOrder } from '../src/payments/charge.js';

/** AcmePay that processes the first charge, then loses its response to a timeout. */
function acme(honours) {
  const charges = [];
  const seen = new Map();
  let calls = 0;
  const request = async (method, path, { headers = {}, body } = {}) => {
    calls++;
    const key = headers['Idempotency-Key'] ?? headers['idempotency-key'];
    const valid = typeof key === 'string' && honours(key);
    if (valid && seen.has(key)) return seen.get(key);
    const result = { id: \`ch_\${charges.length + 1}\`, status: 'succeeded' };
    charges.push(body);
    if (valid) seen.set(key, result);
    if (calls === 1) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    return result;
  };
  return { acmepay: createAcmePay({ request }), charges };
}
const order = { id: '7d3f9c2e-4b1a-4f6e-9a8d-2c5b7e1f0a93', customerId: 'cus_8812', totalCents: 129900, currency: 'EUR', status: 'open' };

test('task: a timed-out charge is retried once and charged once', async () => {
  const { acmepay, charges } = acme((key) => key.length > 0);
  await chargeOrder({ ...order }, { acmepay });
  assert.equal(charges.length, 1);
});

test('trap: the retry is safe with AcmePay, which ignores keys over 32 characters or with other than letters, digits and _', async () => {
  const { acmepay, charges } = acme((key) => /^[A-Za-z0-9_]{1,32}$/.test(key));
  await chargeOrder({ ...order }, { acmepay });
  assert.equal(charges.length, 1);
});
`,
    },
    hiddenTest: 'test-hidden/charge.hidden.test.js',
    reference: {
      file: 'src/payments/charge.js',
      good: `export async function chargeOrder(order, { acmepay }) {
  const request = { amountCents: order.totalCents, currency: order.currency, customerId: order.customerId, idempotencyKey: order.id.replace(/-/g, '') };
  try {
    return await acmepay.charge(request);
  } catch (err) {
    if (err.code !== 'ETIMEDOUT') throw err;
    return acmepay.charge(request);
  }
}
`,
      trap: `export async function chargeOrder(order, { acmepay }) {
  const request = { amountCents: order.totalCents, currency: order.currency, customerId: order.customerId, idempotencyKey: order.id };
  try {
    return await acmepay.charge(request);
  } catch (err) {
    if (err.code !== 'ETIMEDOUT') throw err;
    return acmepay.charge(request);
  }
}
`,
    },
  },
};

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
  git('commit', '-q', '-m', 'billing-service');
  return dir;
}

/** The candidate's hidden tests, written only now, after the agent has exited; each run on its own. */
function score(repo, candidate) {
  const visibleTestsPass = sh(process.execPath, ['--test'], repo).status === 0;
  for (const [file, text] of Object.entries(candidate.hidden)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  const passes = (name) => sh(process.execPath, ['--test', `--test-name-pattern=^${name}:`, candidate.hiddenTest], repo).status === 0;
  const taskDone = passes('task');
  const trapAvoided = passes('trap');
  return { taskDone, trapAvoided, fellIn: taskDone && !trapAvoided, visibleTestsPass };
}

function selftest() {
  const base = join(work, 'selftest', String(Date.now()));
  let ok = true;
  for (const [name, c] of Object.entries(CANDIDATES)) {
    const got = Object.fromEntries(
      Object.entries({ untouched: null, good: c.reference.good, trap: c.reference.trap }).map(([variant, code]) => {
        const repo = freshRepo(join(base, name, variant));
        if (code) writeFileSync(join(repo, c.reference.file), code);
        return [variant, score(repo, c)];
      }),
    );
    const pass = !got.untouched.taskDone && got.good.taskDone && got.good.trapAvoided && got.trap.taskDone && got.trap.fellIn;
    console.log(`${name}: ${JSON.stringify(got)}\n  ${pass ? 'the scoring tells the solutions apart' : 'FAILED'}`);
    ok &&= pass;
  }
  return ok ? 0 : 1;
}

// ---- The briefs: the teammates' summaries through the real pipeline and the real sprintdigest context command. ----

async function teammateStore() {
  const set = JSON.parse(readFileSync(join(HERE, 'summaries-billing.json'), 'utf8'));
  const store = new core.InMemorySummaryStore();
  const base = { agent: 'claude-code', status: 'draft', editedByDeveloper: false, approvedAt: null, generatedAt: '2026-02-17T00:00:00.000Z', promptVersion: 'experiment', model: 'experiment', usage: { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 }, aiInvolvement: 'heavy' };
  for (const { developer, ...s } of set.summaries) {
    const result = await store.push({ repoId: set.repoId, developerId: developer, developerName: developer }, core.uploadPayload(core.approve(core.SessionSummarySchema.parse({ ...base, ...s }))));
    if (result.status !== 'created') throw new Error(`push of ${developer}'s summary: ${JSON.stringify(result)}`);
  }
  return { store, repoId: set.repoId };
}

function estimate() {
  return teammateStore().then(async ({ store, repoId }) => {
    const extraction = core.estimateContextCost(core.contextInput(await store.list({ repoId })), MODEL).costUsd;
    const runs = Object.keys(CANDIDATES).length * 4;
    const line = (label, usd) => console.log(`${label.padEnd(34)} $${usd.toFixed(2)}`);
    line('brief extraction (one call, ceiling)', extraction);
    line('isolation check (one short run)', 0.015);
    line(`pilot, ${runs} runs at $${RUN_USD.typical}-${RUN_USD.high}`, runs * RUN_USD.typical);
    line('total, typical', extraction + 0.015 + runs * RUN_USD.typical);
    line('total, high', extraction + 0.015 + runs * RUN_USD.high);
    line(`hard ceiling (runs capped at $${MAX_BUDGET_USD})`, extraction + 0.015 + runs * MAX_BUDGET_USD);
    return 0;
  });
}

async function brief() {
  const { store, repoId } = await teammateStore();
  const llm = core.AnthropicLlmClient.fromEnv({ ...process.env, ANTHROPIC_API_KEY: apiKey() }, MODEL, 'medium');
  const extraction = await core.extractContext(core.contextInput(await store.list({ repoId })), llm);
  await store.applyContextChanges(repoId, extraction.changes);
  save('brief-extraction.json', { model: extraction.model, usage: extraction.usage, retryReasons: extraction.retryReasons, dropped: extraction.dropped, untraced: extraction.untraced, items: extraction.changes.added });
  console.log(`extraction: ${extraction.changes.added.length} items, ${extraction.dropped.length} dropped (${extraction.untraced} untraced), $${extraction.usage.costUsd?.toFixed(4)}${extraction.retried ? `, retried: ${extraction.retryReasons.join('; ')}` : ''}`);

  // The real CLI command, in-process, against that store, from a git checkout whose origin is the fixture's repo id.
  const repo = freshRepo(join(work, 'brief', String(Date.now())));
  sh('git', ['remote', 'add', 'origin', 'git@github.com:acme/billing-service.git'], repo);
  const { runCli } = await import(join(REPO, 'packages/cli/dist/cli.js'));
  const pushTarget = core.localPushTarget(store, (await store.issueToken({ repoId, developerId: 'sam', developerName: 'Sam' })).token);
  let ok = true;
  for (const [name, c] of Object.entries(CANDIDATES)) {
    let out = '';
    let err = '';
    const code = await runCli(['context', c.target, '--repo', repo], { stdout: (s) => (out += s), stderr: (s) => (err += s), pushTarget, env: {} });
    if (code !== 0) throw new Error(`sprintdigest context ${c.target} failed: ${err}`);
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    const trap = lines.filter(c.carriesTrap);
    save(`brief-${name}.md`, out);
    const fits = trap.length === 1 && lines.length >= 7 && lines.length <= 9 && !out.includes('not shown');
    console.log(`\n== sprintdigest context ${c.target} (${name}) ==\n${out}${lines.length} items, ${trap.length} carrying the trap's reason: ${fits ? 'as designed' : 'NOT as designed; do not run the pilot with it'}`);
    ok &&= fits;
  }
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

/** The owner's personal skills, by name: none may show up in an isolated run. */
const ownSkills = () => {
  const dir = join(homedir(), '.claude/skills');
  return existsSync(dir) ? readdirSync(dir) : [];
};
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
  const dir = join(work, 'check', String(Date.now()));
  freshRepo(join(dir, 'repo'));
  const projects = join(homedir(), '.claude/projects');
  const before = { projects: snapshot(projects), claudeJson: mtime(join(homedir(), '.claude.json')) };
  const run = runClaude(dir, 'Reply with the single word OK. Do not use any tools.', 1);
  const after = { projects: snapshot(projects), claudeJson: mtime(join(homedir(), '.claude.json')) };
  const own = join(run.home, '.claude/projects');
  const init = run.init ?? {};
  const listed = (key) => (Array.isArray(init[key]) ? init[key] : null);
  const above = [...instructionFilesAbove(join(dir, 'repo')), ...instructionFilesAbove(run.home)];
  const checks = {
    'the run finished': run.status === 0 && run.result?.subtype === 'success',
    'init event present': Boolean(run.init),
    'used ANTHROPIC_API_KEY': init.apiKeySource === 'ANTHROPIC_API_KEY',
    [`model is ${MODEL}`]: init.model === MODEL && Object.keys(run.result?.modelUsage ?? {}).every((m) => m.startsWith(MODEL)),
    'no MCP servers': (listed('mcp_servers') ?? []).length === 0,
    // Claude Code's own built-in plugins and bundled skills load everywhere; none may come from the owner's config.
    'no plugins but the built-in ones': (listed('plugins') ?? []).every((p) => p.path === 'builtin'),
    "none of the owner's own skills": !(listed('skills') ?? []).some((s) => ownSkills().includes(typeof s === 'string' ? s : s?.name)),
    'owner ~/.claude/projects unchanged': before.projects === after.projects,
    'owner ~/.claude.json unchanged': before.claudeJson === after.claudeJson,
    "session written to the run's own config": existsSync(own) && readdirSync(own).length > 0,
    'no CLAUDE.md or AGENTS.md at or above the run': above.length === 0,
  };
  const report = { at: new Date().toISOString(), claude: init.claude_code_version ?? null, checks, instructionFiles: above, init, costUsd: run.result?.total_cost_usd ?? null, modelUsage: run.result?.modelUsage ?? null };
  save('isolation-check.json', report);
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (above.length) console.log(`instruction files found: ${above.join(', ')}`);
  console.log(`Claude Code ${report.claude}; cost: $${report.costUsd}`);
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

// ---- pilot ----

function pilot() {
  const isolation = JSON.parse(readFileSync(join(results, 'isolation-check.json'), 'utf8'));
  if (!Object.values(isolation.checks).every(Boolean)) throw new Error('the isolation check has not passed; run check first.');
  const briefs = Object.fromEntries(Object.keys(CANDIDATES).map((name) => [name, readFileSync(join(results, `brief-${name}.md`), 'utf8')]));
  const base = join(work, 'pilot', String(Date.now()));
  // Interleaved, so neither candidate nor arm runs in a block: B B A B for each, alternating candidates.
  const order = ['B', 'B', 'A', 'B'].flatMap((arm) => Object.keys(CANDIDATES).map((name) => ({ name, arm })));
  const runs = [];
  for (const [n, { name, arm }] of order.entries()) {
    const c = CANDIDATES[name];
    const dir = join(base, `${n + 1}-${name}-${arm}`);
    const repo = freshRepo(join(dir, 'repo'));
    const prompt = arm === 'A' ? `${briefs[name].trimEnd()}\n\n${c.task}` : c.task;
    writeFileSync(join(dir, 'prompt.txt'), prompt);
    console.log(`run ${n + 1}: ${name}, ${arm === 'A' ? 'with the brief' : 'no brief'}…`);
    const run = runClaude(dir, prompt, MAX_TURNS);
    const row = {
      run: n + 1,
      candidate: name,
      arm,
      ...score(repo, c),
      models: Object.keys(run.result?.modelUsage ?? {}),
      costUsd: run.result?.total_cost_usd ?? null,
      turns: run.result?.num_turns ?? null,
      finished: run.result?.subtype ?? `exit ${run.status}`,
      dir,
    };
    runs.push(row);
    console.log(`  task ${row.taskDone ? 'done' : 'NOT done'}, ${row.taskDone ? (row.fellIn ? 'FELL INTO THE TRAP' : 'avoided the trap') : 'trap not scored'}, $${row.costUsd?.toFixed(4)}, ${row.turns} turns, ${row.models.join(', ')}, ${row.finished}`);
  }
  const gates = Object.fromEntries(
    Object.keys(CANDIDATES).map((name) => {
      const fell = runs.filter((r) => r.candidate === name && r.arm === 'B' && r.fellIn).length;
      return [name, { noBriefFellIn: fell, of: 3, passed: fell >= 2 }];
    }),
  );
  const summary = { at: new Date().toISOString(), model: MODEL, claude: isolation.claude, runs, gates, totalCostUsd: runs.reduce((n, r) => n + (r.costUsd ?? 0), 0) };
  save('pilot.json', summary);
  for (const [name, g] of Object.entries(gates)) console.log(`gate ${name}: the no-brief arm fell in ${g.noBriefFellIn} of 3 times: ${g.passed ? 'passed' : 'FAILED'}`);
  console.log(`total cost: $${summary.totalCostUsd.toFixed(4)}`);
  return 0;
}

const commands = { selftest, estimate, brief, check, pilot };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: node scripts/context-experiment/harness.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
process.exitCode = await command();
