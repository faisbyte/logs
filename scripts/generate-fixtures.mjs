// Generates the anonymised session fixtures in fixtures/.
// Every line is invented. Structure mirrors the real formats recorded in docs/formats.md.
// Run: node scripts/generate-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
const REPO = '/work/acme-webapp';

function writeJsonl(rel, events) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function writeJson(rel, obj) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function clock(startIso) {
  let t = Date.parse(startIso);
  return (seconds = 3) => {
    t += seconds * 1000;
    return new Date(t).toISOString();
  };
}

const filler = (label, lines) =>
  Array.from({ length: lines }, (_, i) => `${label} line ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit`).join('\n');

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function claudeSession({ sessionId, cwd, gitBranch, version, start, isSidechain = false, agentId }) {
  const ctx = { cwd, gitBranch, version };
  const tick = clock(start);
  const events = [];
  let seq = 0;
  let parent = null;
  let msgSeq = 0;
  let toolSeq = 0;
  const idTail = (agentId ?? sessionId).slice(-4);
  const uuidPrefix = agentId ? `5ub${agentId.slice(-5)}` : sessionId.slice(0, 8);
  const uuid = () => `${uuidPrefix}-aaaa-4aaa-8aaa-${String(++seq).padStart(12, '0')}`;

  const envelope = (type, extra) => {
    const id = uuid();
    const e = {
      parentUuid: parent,
      isSidechain,
      ...(agentId ? { agentId } : {}),
      type,
      ...extra,
      uuid: id,
      timestamp: tick(),
      userType: 'external',
      entrypoint: 'claude-vscode',
      cwd: ctx.cwd,
      sessionId,
      version: ctx.version,
      gitBranch: ctx.gitBranch,
    };
    parent = id;
    events.push(e);
    return e;
  };

  const api = {
    events,
    set(changes) {
      Object.assign(ctx, changes);
    },
    raw(e) {
      events.push({ ...e, sessionId });
    },
    queued(content) {
      events.push({ type: 'queue-operation', operation: 'enqueue', timestamp: tick(0), sessionId, content });
      events.push({ type: 'queue-operation', operation: 'dequeue', timestamp: tick(0), sessionId });
    },
    prompt(content, extra = {}) {
      return envelope('user', {
        promptId: `prompt-${idTail}-${seq}`,
        message: { role: 'user', content },
        permissionMode: 'default',
        origin: { kind: 'human' },
        promptSource: 'sdk',
        ...extra,
      });
    },
    meta(content) {
      return envelope('user', { message: { role: 'user', content }, isMeta: true });
    },
    injected(content, extra = {}) {
      return envelope('user', { message: { role: 'user', content }, ...extra });
    },
    attachment(attachment) {
      return envelope('attachment', { attachment });
    },
    system(subtype, extra = {}) {
      return envelope('system', { subtype, level: 'info', ...extra });
    },
    // One API response: each block is its own line sharing message.id (streaming split).
    respond(blocks, { model = 'claude-opus-5-5', stopReason = 'tool_use' } = {}) {
      const id = `msg_fx${idTail}${String(++msgSeq).padStart(4, '0')}`;
      const toolUses = [];
      blocks.forEach((b, i) => {
        let block;
        if (b.thinking !== undefined) block = { type: 'thinking', thinking: b.thinking, signature: 'ZmFrZS1zaWduYXR1cmU=' };
        else if (b.text !== undefined) block = { type: 'text', text: b.text };
        else {
          block = { type: 'tool_use', id: `toolu_fx${idTail}${String(++toolSeq).padStart(4, '0')}`, name: b.tool, input: b.input, caller: { type: 'direct' } };
          toolUses.push(block);
        }
        envelope('assistant', {
          message: {
            model,
            id,
            type: 'message',
            role: 'assistant',
            content: [block],
            stop_reason: i === blocks.length - 1 ? stopReason : null,
            stop_sequence: null,
            usage: { input_tokens: 12, cache_read_input_tokens: 4096, output_tokens: 180, service_tier: 'standard' },
          },
          requestId: `req_fx${idTail}${msgSeq}`,
          effort: 'high',
        });
      });
      return toolUses;
    },
    result(toolUse, content, toolUseResult, { isError = false } = {}) {
      return envelope('user', {
        message: { role: 'user', content: [{ tool_use_id: toolUse.id, type: 'tool_result', content, ...(isError ? { is_error: true } : { is_error: false }) }] },
        toolUseResult,
        sourceToolAssistantUUID: parent,
      });
    },
    title(aiTitle) {
      events.push({ type: 'ai-title', aiTitle, sessionId });
    },
  };
  return api;
}

const bashResult = (stdout, stderr = '') => ({ stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false });
const readResult = (filePath, content) => ({
  type: 'text',
  file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length },
});
const writeResult = (filePath, content) => ({ type: 'create', filePath, content, structuredPatch: [], originalFile: null });
const editResult = (filePath, oldString, newString, originalFile) => ({
  filePath,
  oldString,
  newString,
  originalFile,
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [`-${oldString}`, `+${newString}`] }],
  userModified: false,
  replaceAll: false,
});
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// --- Claude basic: short, clean session in the repo root -------------------
{
  const s = claudeSession({
    sessionId: 'c1a5e001-0000-4000-8000-000000000001',
    cwd: REPO,
    gitBranch: 'feature/PROJ-142-rate-limit',
    version: '2.1.300',
    start: '2026-03-02T09:00:00.000Z',
  });
  s.queued('Add rate limiting to the login endpoint');
  s.raw({ type: 'mode', mode: 'normal' });
  s.prompt('Add rate limiting to the login endpoint: max 5 attempts per minute per IP.');
  s.attachment({ type: 'environment', content: 'Platform: linux' });
  s.raw({ type: 'api-request-blob', hash: 'fakehash01', message: { role: 'user', content: 'raw request copy, must be ignored' } });
  let [read] = s.respond([{ thinking: '' }, { text: "I'll look at the login route first." }, { tool: 'Read', input: { file_path: `${REPO}/src/routes/login.ts` } }]);
  const loginSrc = "import { Router } from 'express';\nexport const login = Router();\nlogin.post('/login', handler);";
  s.result(read, loginSrc, readResult(`${REPO}/src/routes/login.ts`, loginSrc));
  let [grep] = s.respond([{ tool: 'Bash', input: { command: 'grep -n "rate" package.json', description: 'Check for existing rate limit deps' } }]);
  s.result(grep, '', bashResult(''));
  const mw = 'export function rateLimit(limit: number, windowMs: number) {\n  // sliding window per IP\n}';
  let [write] = s.respond([
    { text: 'No existing dependency. I will write a small in-memory sliding-window limiter rather than add a package, since there is a single API instance.' },
    { tool: 'Write', input: { file_path: `${REPO}/src/middleware/rateLimit.ts`, content: mw } },
  ]);
  s.result(write, `File created successfully at: ${REPO}/src/middleware/rateLimit.ts`, writeResult(`${REPO}/src/middleware/rateLimit.ts`, mw));
  let [edit] = s.respond([
    {
      tool: 'Edit',
      input: {
        file_path: `${REPO}/src/routes/login.ts`,
        old_string: "login.post('/login', handler);",
        new_string: "login.post('/login', rateLimit(5, 60_000), handler);",
        replace_all: false,
      },
    },
  ]);
  s.result(
    edit,
    `The file ${REPO}/src/routes/login.ts has been updated successfully.`,
    editResult(`${REPO}/src/routes/login.ts`, "login.post('/login', handler);", "login.post('/login', rateLimit(5, 60_000), handler);", loginSrc),
  );
  let [test] = s.respond([{ tool: 'Bash', input: { command: 'pnpm test', description: 'Run tests' } }]);
  s.result(test, ' ✓ test/login.test.ts (4 tests)\n Test Files  1 passed (1)', bashResult(' ✓ test/login.test.ts (4 tests)\n Test Files  1 passed (1)'));
  let [commit] = s.respond([
    { tool: 'Bash', input: { command: 'git add -A && git commit -q -m "PROJ-142: rate limit login endpoint"', description: 'Commit changes' } },
  ]);
  s.result(commit, '', bashResult(''));
  s.respond([{ text: 'Done. Login is limited to 5 attempts per minute per IP using an in-memory sliding window. This will not hold across multiple instances.' }], {
    stopReason: 'end_turn',
  });
  s.title('Add login rate limiting');
  s.title('Rate limit login endpoint');
  s.raw({ type: 'last-prompt', lastPrompt: 'Add rate limiting to the login endpoint', leafUuid: 'x' });
  s.raw({ type: 'cost-state', totalCostUSD: 0.42, totalLinesAdded: 4, totalLinesRemoved: 1, totalDuration: 750000, modelUsage: {} });
  writeJsonl('claude-code/projects/-work-acme-webapp/c1a5e001-0000-4000-8000-000000000001.jsonl', s.events);
}

// --- Claude messy: abandoned approaches, interruptions, injected noise, subagent ---
{
  const sessionId = 'c1a5e002-0000-4000-8000-000000000002';
  const s = claudeSession({ sessionId, cwd: REPO, gitBranch: 'feature/PROJ-150-search', version: '2.1.306', start: '2026-03-03T13:00:00.000Z' });
  s.raw({ type: 'bridge-session', bridgeSessionId: 'bridge-fx', lastSequenceNum: 0 });
  s.prompt([
    { type: 'text', text: `<ide_opened_file>The user opened the file ${REPO}/src/search/index.ts in the IDE.</ide_opened_file>` },
    { type: 'text', text: 'Search is slow. Put a Redis cache in front of the search query.' },
  ]);
  const cacheSrc = "import { createClient } from 'redis';\nexport const cache = createClient();";
  let [w] = s.respond([{ thinking: 'The query runs on every keystroke; a cache keyed by query string should help.' }, { tool: 'Write', input: { file_path: `${REPO}/src/search/cache.ts`, content: cacheSrc } }]);
  s.result(w, `File created successfully at: ${REPO}/src/search/cache.ts`, writeResult(`${REPO}/src/search/cache.ts`, cacheSrc));
  let [add] = s.respond([{ tool: 'Bash', input: { command: 'pnpm add redis', description: 'Install redis client' } }]);
  s.result(add, REJECTED, 'User rejected tool use', { isError: true });
  s.prompt([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
  s.prompt("No Redis. Ops won't run another service. Try a Postgres trigram index instead.");
  s.injected('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>');
  s.injected('<local-command-stdout>Set model to claude-opus-5-5</local-command-stdout>');
  s.meta('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>');
  let [rm, mig] = s.respond([
    { text: 'Understood, dropping the Redis cache. I will remove it and add a trigram index migration.' },
    { tool: 'Bash', input: { command: 'rm src/search/cache.ts', description: 'Remove abandoned cache' } },
    { tool: 'Write', input: { file_path: `${REPO}/db/migrations/0042_search_trgm.sql`, content: 'CREATE EXTENSION IF NOT EXISTS pg_trgm;' } },
  ]);
  s.result(rm, '', bashResult(''));
  s.result(mig, `File created successfully at: ${REPO}/db/migrations/0042_search_trgm.sql`, writeResult(`${REPO}/db/migrations/0042_search_trgm.sql`, 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'));
  let [agent] = s.respond([
    {
      tool: 'Agent',
      input: { description: 'Rewrite search query for trigram index', prompt: 'Rewrite src/search/query.ts to use similarity() with the pg_trgm index.', subagent_type: 'general-purpose' },
    },
  ]);
  s.result(agent, [{ type: 'text', text: 'Rewrote the query to use similarity() ordering with a 0.3 threshold.' }], {
    status: 'completed',
    agentId: 'a5ub0000000000001',
    totalToolUseCount: 2,
  });
  s.injected('<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system' });
  s.set({ cwd: '/tmp' });
  let [t1] = s.respond([{ tool: 'Bash', input: { command: 'cd /tmp && pnpm --dir /work/acme-webapp test', description: 'Run tests' } }]);
  s.result(t1, 'Exit code 1\nFAIL test/search.test.ts > ranks exact matches first', 'Error: Exit code 1', { isError: true });
  s.set({ cwd: REPO });
  s.prompt([{ type: 'text', text: '[Request interrupted by user]' }]);
  s.prompt("Actually leave the migration for now. Add a TODO and we'll pair on it tomorrow.");
  s.system('api_error', { level: 'error', content: 'API Error: 529 overloaded' });
  let [todo] = s.respond([
    {
      tool: 'Edit',
      input: { file_path: `${REPO}/src/search/query.ts`, old_string: 'export function search(', new_string: '// TODO(PROJ-150): finish trigram migration\nexport function search(', replace_all: false },
    },
  ]);
  s.result(todo, `The file ${REPO}/src/search/query.ts has been updated successfully.`, editResult(`${REPO}/src/search/query.ts`, 'export function search(', '// TODO\nexport function search(', 'export function search(q) {}'));
  s.respond([{ text: 'Added the TODO. The Redis approach was dropped; the trigram migration is written but tests still fail on ranking.' }], { stopReason: 'end_turn' });
  s.title('Speed up search');
  writeJsonl(`claude-code/projects/-work-acme-webapp/${sessionId}.jsonl`, s.events);

  // Subagent transcript for the Agent call above.
  const sub = claudeSession({ sessionId, cwd: REPO, gitBranch: 'feature/PROJ-150-search', version: '2.1.306', start: '2026-03-03T13:20:00.000Z', isSidechain: true, agentId: 'a5ub0000000000001' });
  sub.prompt('Rewrite src/search/query.ts to use similarity() with the pg_trgm index.');
  let [sr] = sub.respond([{ tool: 'Read', input: { file_path: `${REPO}/src/search/query.ts` } }], { model: 'claude-sonnet-5-5' });
  sub.result(sr, 'export function search(q) {}', readResult(`${REPO}/src/search/query.ts`, 'export function search(q) {}'));
  let [se] = sub.respond(
    [{ tool: 'Edit', input: { file_path: `${REPO}/src/search/query.ts`, old_string: 'export function search(q) {}', new_string: 'export function search(q) { /* similarity */ }', replace_all: false } }],
    { model: 'claude-sonnet-5-5' },
  );
  sub.result(se, `The file ${REPO}/src/search/query.ts has been updated successfully.`, editResult(`${REPO}/src/search/query.ts`, 'a', 'b', 'a'));
  let [sw] = sub.respond([{ tool: 'Write', input: { file_path: `${REPO}/src/search/ranking.ts`, content: 'export const THRESHOLD = 0.3;' } }], { model: 'claude-sonnet-5-5' });
  sub.result(sw, `File created successfully at: ${REPO}/src/search/ranking.ts`, writeResult(`${REPO}/src/search/ranking.ts`, 'export const THRESHOLD = 0.3;'));
  sub.respond([{ text: 'Rewrote the query to use similarity() ordering with a 0.3 threshold.' }], { model: 'claude-sonnet-5-5', stopReason: 'end_turn' });
  writeJsonl(`claude-code/projects/-work-acme-webapp/${sessionId}/subagents/agent-a5ub0000000000001.jsonl`, sub.events);
  writeJson(`claude-code/projects/-work-acme-webapp/${sessionId}/subagents/agent-a5ub0000000000001.meta.json`, {
    agentType: 'general-purpose',
    description: 'Rewrite search query for trigram index',
    toolUseId: agent.id,
    spawnDepth: 1,
    finished: true,
    isBuiltIn: true,
    launchedWithDefaults: true,
    requestNonInteractive: false,
    requestShape: 'default',
  });
  fs.mkdirSync(path.join(OUT, `claude-code/projects/-work-acme-webapp/${sessionId}/tool-results`), { recursive: true });
  fs.writeFileSync(path.join(OUT, `claude-code/projects/-work-acme-webapp/${sessionId}/tool-results/toolu_fx00020001.txt`), 'spilled tool output (ignored)\n');
}

// --- Claude long: launched in a repo subdirectory, many turns, huge outputs, compaction ---
{
  const sessionId = 'c1a5e003-0000-4000-8000-000000000003';
  const s = claudeSession({ sessionId, cwd: `${REPO}/packages/api`, gitBranch: 'main', version: '2.1.296', start: '2026-03-04T08:00:00.000Z' });
  s.queued('Add an audit log for admin actions');
  const areas = ['users', 'roles', 'billing', 'settings', 'exports', 'invites', 'sessions', 'webhooks', 'teams', 'reports'];
  for (let i = 1; i <= 60; i++) {
    const area = areas[i % areas.length];
    if (i === 20) s.set({ gitBranch: 'feature/PROJ-160-audit-log' });
    if (i === 25) s.set({ cwd: REPO });
    if (i === 30) s.set({ version: '2.1.300' });
    if (i === 40) {
      s.system('compact_boundary', { content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 12000 } });
      s.injected('This session is being continued from a previous conversation that ran out of context. Summary: audit log work in progress.', { isCompactSummary: true });
    }
    s.prompt(i === 1 ? 'Add an audit log for admin actions. Start with the users area.' : `Next, add audit logging to the ${area} admin endpoints (step ${i}).`);
    const file = `${REPO}/packages/api/src/admin/${area}.ts`;
    const big = i === 10 || i === 33;
    const content = big ? filler(`${area}.ts`, 400) : `export const ${area} = {};`;
    let [read, grep] = s.respond([
      { thinking: i % 7 === 0 ? `Considering whether ${area} needs per-field diffs in the audit entry.` : '' },
      { text: `Looking at the ${area} handlers.` },
      { tool: 'Read', input: { file_path: file } },
      { tool: 'Bash', input: { command: `grep -rn "admin" packages/api/src/admin/${area}.ts`, description: 'Find admin handlers' } },
    ]);
    s.result(read, content, readResult(file, content));
    const grepOut = i === 15 ? filler('grep', 1200) : `${area}.ts:3: router.post('/admin/${area}')`;
    s.result(grep, grepOut, bashResult(grepOut));
    const editInput =
      i === 45
        ? { tool: 'MultiEdit', input: { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } }
        : { tool: 'Edit', input: { file_path: file, old_string: `export const ${area}`, new_string: `export const ${area} = withAudit(`, replace_all: false } };
    let [ed] = s.respond([editInput]);
    s.result(ed, `The file ${file} has been updated successfully.`, editResult(file, 'a', 'b', content));
    if (i % 5 === 0) {
      let [w] = s.respond([{ tool: 'Write', input: { file_path: `${REPO}/packages/api/test/audit-${area}.test.ts`, content: 'test("audits", () => {});' } }]);
      s.result(w, 'File created successfully', writeResult(`${REPO}/packages/api/test/audit-${area}.test.ts`, 'x'));
    }
    if (i % 10 === 0) {
      let [c] = s.respond([{ tool: 'Bash', input: { command: `git commit -qam "PROJ-160: audit ${area}"`, description: 'Commit' } }]);
      s.result(c, '', bashResult(''));
    }
    s.respond([{ text: `Audit logging added for ${area}.` }], { stopReason: 'end_turn' });
  }
  let [nb] = s.respond([{ tool: 'NotebookEdit', input: { notebook_path: `${REPO}/notebooks/audit-volume.ipynb`, new_source: 'df.describe()' } }]);
  s.result(nb, 'Updated notebook', { type: 'update' });
  s.respond([{ text: 'All admin areas now write audit entries.' }], { stopReason: 'end_turn' });
  s.title('Audit log for admin actions');
  writeJsonl(`claude-code/projects/-work-acme-webapp-packages-api/${sessionId}.jsonl`, s.events);
}

// --- Claude other repo: sibling dir with a shared name prefix, later cd's into the repo ---
{
  const sessionId = 'c1a5e004-0000-4000-8000-000000000004';
  const s = claudeSession({ sessionId, cwd: '/work/acme-webapp-legacy', gitBranch: 'master', version: '2.1.310', start: '2026-03-05T10:00:00.000Z' });
  s.queued('Port the date helpers');
  s.prompt('Copy the date helpers from the new webapp into this legacy app.');
  s.set({ cwd: REPO });
  let [r] = s.respond([{ tool: 'Read', input: { file_path: `${REPO}/src/lib/dates.ts` } }]);
  s.result(r, 'export const fmt = () => {};', readResult(`${REPO}/src/lib/dates.ts`, 'export const fmt = () => {};'));
  s.set({ cwd: '/work/acme-webapp-legacy' });
  let [w] = s.respond([{ tool: 'Write', input: { file_path: '/work/acme-webapp-legacy/lib/dates.js', content: 'exports.fmt = () => {};' } }]);
  s.result(w, 'File created successfully', writeResult('/work/acme-webapp-legacy/lib/dates.js', 'x'));
  s.respond([{ text: 'Copied.' }], { stopReason: 'end_turn' });
  writeJsonl(`claude-code/projects/-work-acme-webapp-legacy/${sessionId}.jsonl`, s.events);
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

function codexSession({ id, start, cwd, branch, cliVersion, source = 'vscode', model, withInstructions }) {
  const tick = clock(start);
  const events = [];
  let call = 0;
  const line = (type, payload, seconds = 2) => events.push({ timestamp: tick(seconds), type, payload });
  const isNew = cliVersion.startsWith('0.81');
  line(
    'session_meta',
    {
      id,
      timestamp: start,
      cwd,
      originator: 'codex_vscode',
      cli_version: cliVersion,
      instructions: withInstructions ? 'You are Codex, a coding agent.' : null,
      source,
      ...(isNew ? { model_provider: 'openai' } : {}),
      git: { commit_hash: '0123456789abcdef0123456789abcdef01234567', branch, repository_url: 'git@git.example.com:acme/webapp.git' },
    },
    0,
  );
  const turnContext = () =>
    line('turn_context', {
      cwd,
      approval_policy: 'on-request',
      sandbox_policy: isNew
        ? { type: 'workspace-write', writable_roots: [cwd], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false }
        : { mode: 'workspace-write', network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
      model,
      ...(isNew ? { effort: 'medium', user_instructions: 'Follow AGENTS.md.', truncation_policy: { mode: 'bytes', limit: 10000 } } : {}),
      summary: 'auto',
    });
  const api = {
    events,
    injectContext() {
      if (isNew) line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>sandboxed</permissions instructions>' }] });
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>` }] });
      const env = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n</environment_context>`;
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: env }] });
      if (!isNew) line('event_msg', { type: 'user_message', message: env, kind: 'environment_context' });
    },
    prompt(text, { ide = true } = {}) {
      turnContext();
      const message = ide ? `# Context from my IDE setup:\n\n## Open tabs:\n- index.ts: src/index.ts\n\n## My request for Codex:\n${text}\n` : text;
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] });
      line('event_msg', isNew ? { type: 'user_message', message, images: [] } : { type: 'user_message', message, kind: 'plain' });
    },
    reason(text) {
      line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text }], content: null, encrypted_content: 'gAAAAABfakeEncryptedReasoning==' });
      line('event_msg', { type: 'agent_reasoning', text });
    },
    shell(script, output, { exitCode = 0 } = {}) {
      const call_id = `call_fx${id.slice(-4)}${++call}`;
      line('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', script], workdir: cwd }), call_id });
      line('response_item', { type: 'function_call_output', call_id, output: JSON.stringify({ output, metadata: { exit_code: exitCode, duration_seconds: 0.4 } }) });
    },
    patch(patchBody, output) {
      const call_id = `call_fx${id.slice(-4)}${++call}`;
      line('response_item', { type: 'custom_tool_call', status: 'completed', call_id, name: 'apply_patch', input: patchBody });
      line('response_item', { type: 'custom_tool_call_output', call_id, output: JSON.stringify({ output, metadata: { exit_code: 0, duration_seconds: 0 } }) });
    },
    plan(steps) {
      const call_id = `call_fx${id.slice(-4)}${++call}`;
      line('response_item', { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: steps }), call_id });
      line('response_item', { type: 'function_call_output', call_id, output: 'Plan updated' });
    },
    say(text) {
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      line('event_msg', { type: 'agent_message', message: text });
    },
    tokens() {
      line('event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 5300 },
          last_token_usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 30, reasoning_output_tokens: 12, total_tokens: 530 },
          model_context_window: 272000,
        },
        rate_limits: { primary: { used_percent: 3, window_minutes: 300, resets_in_seconds: 1000 }, secondary: { used_percent: 1, window_minutes: 10080, resets_in_seconds: 90000 } },
      }, 1);
    },
    abort() {
      line('event_msg', { type: 'turn_aborted', reason: 'interrupted' });
    },
  };
  return api;
}

const shellPatch = (body) => `apply_patch <<'PATCH'\n${body}\nPATCH`;

// --- Codex basic (0.81 style): one prompt, reads, adds a test via apply_patch tool, runs it ---
{
  const id = '019c0001-0000-7000-8000-000000000001';
  const c = codexSession({ id, start: '2026-03-02T10:00:00.000Z', cwd: REPO, branch: 'feature/PROJ-142-rate-limit', cliVersion: '0.81.0-alpha.8', model: 'gpt-5.2-codex', withInstructions: true });
  c.injectContext();
  c.prompt('Add a unit test for the login rate limiter.');
  c.reason('**Planning limiter test**\n\nRead the middleware, then add a vitest file.');
  c.shell('sed -n 1,80p src/middleware/rateLimit.ts', 'export function rateLimit(limit: number, windowMs: number) {}');
  c.patch('*** Begin Patch\n*** Add File: test/rateLimit.test.ts\n+import { rateLimit } from "../src/middleware/rateLimit";\n*** End Patch', 'Success. Updated the following files:\nA test/rateLimit.test.ts\n');
  c.shell('pnpm vitest run test/rateLimit.test.ts', ' ✓ test/rateLimit.test.ts (3 tests)');
  c.tokens();
  c.say('Added test/rateLimit.test.ts covering the limit, the window reset, and per-IP isolation. All 3 tests pass.');
  writeJsonl(`codex/sessions/2026/03/02/rollout-2026-03-02T21-00-00-${id}.jsonl`, c.events);
}

// --- Codex long (0.45 style): many prompts and shell calls, large outputs, shell apply_patch ---
{
  const id = '019c0002-0000-7000-8000-000000000002';
  const c = codexSession({ id, start: '2026-03-06T00:30:00.000Z', cwd: REPO, branch: 'feature/PROJ-160-audit-log', cliVersion: '0.45.0-alpha.5', model: 'gpt-5-codex', withInstructions: false });
  c.injectContext();
  const areas = ['users', 'roles', 'billing', 'settings', 'exports', 'invites', 'sessions', 'webhooks'];
  for (let i = 1; i <= 25; i++) {
    const area = areas[i % areas.length];
    c.prompt(`Review the audit log entries for ${area} and fix anything missing (pass ${i}).`);
    c.reason(`**Reviewing ${area}**`);
    if (i === 1) c.plan([{ step: 'Read audit module', status: 'in_progress' }, { step: 'Patch gaps', status: 'pending' }]);
    c.shell(`ls packages/api/src/admin`, areas.map((a) => `${a}.ts`).join('\n'));
    c.shell(`cat packages/api/src/admin/${area}.ts`, i === 7 ? filler(`${area}.ts`, 400) : `export const ${area} = withAudit({});`);
    c.shell(`nl -ba packages/api/src/audit/log.ts | sed -n 1,40p`, '     1\texport function audit() {}');
    if (i % 3 === 0) {
      c.shell(
        shellPatch(`*** Begin Patch\n*** Update File: packages/api/src/admin/${area}.ts\n@@\n-export const ${area} = {};\n+export const ${area} = withAudit({});\n*** End Patch`),
        `Success. Updated the following files:\nM packages/api/src/admin/${area}.ts\n`,
      );
    }
    c.tokens();
    c.say(`Checked ${area}; ${i % 3 === 0 ? 'patched one missing audit call' : 'no gaps found'}.`);
  }
  c.plan([{ step: 'Read audit module', status: 'completed' }, { step: 'Patch gaps', status: 'completed' }]);
  writeJsonl(`codex/sessions/2026/03/06/rollout-2026-03-06T11-30-00-${id}.jsonl`, c.events);
}

// --- Codex messy: abandoned websocket approach, failing command, interrupted turn ---
{
  const id = '019c0003-0000-7000-8000-000000000003';
  const c = codexSession({ id, start: '2026-03-06T23:00:00.000Z', cwd: REPO, branch: 'feature/PROJ-171-live-updates', cliVersion: '0.81.0-alpha.8', model: 'gpt-5.2-codex', withInstructions: true });
  c.injectContext();
  c.prompt('Add live updates to the dashboard using websockets.');
  c.reason('**Choosing transport**\n\nWebsockets via ws package.');
  c.patch('*** Begin Patch\n*** Add File: src/live/socket.ts\n+import { WebSocketServer } from "ws";\n*** End Patch', 'Success. Updated the following files:\nA src/live/socket.ts\n');
  c.shell('pnpm add ws', 'ERR_PNPM_FETCH_403 GET https://registry.example.com/ws: Forbidden - 403', { exitCode: 1 });
  c.abort();
  c.prompt("Stop. Don't use websockets, the proxy blocks them. Plain polling every 10s is fine.", { ide: false });
  c.reason('**Switching to polling**');
  c.patch(
    '*** Begin Patch\n*** Delete File: src/live/socket.ts\n*** Add File: src/live/poll.ts\n+export const POLL_MS = 10_000;\n*** Update File: src/dashboard/index.ts\n@@\n+startPolling();\n*** End Patch',
    'Success. Updated the following files:\nD src/live/socket.ts\nA src/live/poll.ts\nM src/dashboard/index.ts\n',
  );
  c.shell('pnpm test', 'FAIL test/dashboard.test.ts', { exitCode: 1 });
  c.say('Switched to 10s polling and removed the websocket module. One dashboard test still fails; it expects a socket connection.');
  writeJsonl(`codex/sessions/2026/03/07/rollout-2026-03-07T10-00-00-${id}.jsonl`, c.events);
}

// --- Codex empty: exec-source twin with a prompt and no response ---
{
  const id = '019c0004-0000-7000-8000-000000000004';
  const c = codexSession({ id, start: '2026-03-07T00:00:05.000Z', cwd: REPO, branch: 'feature/PROJ-171-live-updates', cliVersion: '0.81.0-alpha.8', source: 'exec', model: 'gpt-5.1-codex-mini', withInstructions: true });
  c.prompt('Summarise the open tabs.', { ide: false });
  writeJsonl(`codex/sessions/2026/03/07/rollout-2026-03-07T11-00-05-${id}.jsonl`, c.events);
}

// --- Codex other repo: excluded by the repo filter ---
{
  const id = '019c0005-0000-7000-8000-000000000005';
  const c = codexSession({ id, start: '2026-03-08T02:00:00.000Z', cwd: '/work/other-project', branch: 'main', cliVersion: '0.81.0-alpha.8', model: 'gpt-5.2-codex', withInstructions: true });
  c.injectContext();
  c.prompt('Fix the flaky date test.');
  c.shell('pnpm test dates', ' ✓ dates (2 tests)');
  c.say('It was a timezone assumption; pinned TZ=UTC in the test.');
  writeJsonl(`codex/sessions/2026/03/08/rollout-2026-03-08T13-00-00-${id}.jsonl`, c.events);
}

console.log('fixtures written to', OUT);
