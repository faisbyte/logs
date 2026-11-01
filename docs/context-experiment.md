# Context A/B experiment: does the brief stop a new session repeating a teammate's mistake?

Phase 8's "Done when": *a new session given the digest context output avoids a mistake or rejected approach recorded earlier by a teammate.* This is the scripted test for it (DECISIONS.md D80, D84). The harness is in `scripts/context-experiment/`. Status: the pilot is approved; the full 20 runs wait for the owner's go.

## The trap

A small fixture repo, `login-service` (plain JavaScript ESM, tests with `node --test`, no dependencies to install). It is copied fresh for each run. Nothing real goes into it.

- `src/lib/cache.js`: an in-process cache with a neat `get/set/increment(key, ttlMs, now)` API and a `clear()`. `src/users/profile.js` already uses it for read caching, so it is the obvious choice.
- `src/lib/kv.js`: a client for the shared key-value store. It is async, has only `get/set/delete`, and takes its TTL in seconds. That makes it the clunkier choice.
- `src/auth/login.js`: login without any lockout. It already gets `kv` and a `clock` injected, and uses `kv` for sessions.
- The non-obvious fact: production runs three instances behind a load balancer and redeploys several times a day. Nothing in the code or README says so.

**Task prompt (both arms):** "Add an account lockout to src/auth/login.js: after 5 failed logins for an account, lock it for 15 minutes. A locked account gets { ok: false, reason: 'locked' }, even with the right password. Add tests. Keep the change small."

**The trap:** counting failures in `cache.js`. Every instance keeps its own count and a deploy wipes it.

## The brief: real output, among unrelated notes

- **The summary set:** hand-written approved summaries from four developer identities are pushed to an in-memory shared store.
  - **`bob`:** a paused attempt at the same lockout ticket. Its rejected approach is counting failed logins in `src/lib/cache.js`, with the reason: three instances, and resets on deploy.
  - **`alice`, `chen` and `dana`:** 6 to 8 unrelated but plausible items on other files under `src/auth` and on `src` as a whole. They cover session tokens, a JWT approach that was dropped, password hashing, a native bcrypt module that was dropped, `{ ok, reason }` results, lower-cased emails, and no emails in logs. Two of them are pitfalls, so bob's isn't alone at the top.
- **Extraction:** it runs once with the real pipeline (`extractContext`, Sonnet 5.5).
- **The brief:** the output of the real CLI command, `sprintdigest context src/auth`, run in-process against that store. The harness checks that bob's item is in it, among 6 to 8 others, and the brief is saved. Every run of arm A gets the same saved brief.

## Brief delivery: pasted before the task

A developer runs `sprintdigest context src/auth` before starting and pastes the output above the task. Arm A's prompt is that brief, a blank line, then the task.

Why this way, rather than the brief in `AGENTS.md`:
- Phase 8's "Done when" is about *the digest context output*. That's this command, with its path filter.
- `AGENTS.md` would test `context propose`'s section instead: every note, unfiltered, and read only if the agent loads instruction files. That's a different artifact, and worth its own run later.

## Arms

| Arm | Prompt |
|---|---|
| A, with brief | The saved brief, a blank line, then the task prompt |
| B, without | The task prompt only |

Everything else is the same: the model, the fixture, the tools, the limits.

## Running and isolation

- **A fresh copy each time:** each run copies the fixture into its own directory under the session scratchpad (outside any repo) and does a `git init` with one commit.
- **A clean config:** each run gets its own empty `HOME` and `CLAUDE_CONFIG_DIR`, so there's no global `CLAUDE.md`, user skills, plugins, MCP servers, settings or memory. Sessions are written to the run's own config directory, never to the owner's `~/.claude/projects`.
  - Auth is `ANTHROPIC_API_KEY` from the repo's `.env`, so the runs are billed to that API key.
  - The flags are `--strict-mcp-config` and `--setting-sources project`, and the fixture has no project settings.
- **The command:** `claude -p "<prompt>" --model claude-sonnet-5-5 --output-format stream-json --verbose --max-turns 30 --max-budget-usd 1 --permission-mode dontAsk`, with only `Read, Edit, Write, Glob, Grep` and `Bash` for `npm test` and `node --test` allowed. There is no web access.
- **The binary:** the Claude Code that ships with the VS Code extension. The version it reports (2.1.314 at the isolation check) is recorded with the results.
- **Model:** pinned to `claude-sonnet-5-5`. The model each run actually used comes from its result event and is recorded.
- **Isolation check, before the pilot:** one short run with the same setup has to prove all of this:
  - its init event lists no MCP servers, no plugins but Claude Code's built-in ones, and none of the owner's own skills;
  - it used `ANTHROPIC_API_KEY` and the pinned model;
  - the owner's `~/.claude/projects` and `~/.claude.json` are unchanged;
  - its session landed in the run's own config directory;
  - no `CLAUDE.md` or `AGENTS.md` exists in the run directory or any directory above it.
- **The hidden tests aren't on disk during a run.** The harness keeps them in its own code and writes them into the run's copy only after the agent has exited.

## Scoring: deterministic, no model judge

After each run the harness writes the hidden tests into the copy and runs each one separately:

1. **Task done:** with a shared fake `kv` and a fake clock, 5 failures lock the account, the right password then gets `reason: 'locked'`, and after 15 minutes login works again.
2. **Trap avoided:** 3 failures on one instance. Then `cache.clear()` is called and the login module is loaded again under a fresh module URL, which is what a second instance or a restart would see. 2 more failures, and the right password must get `reason: 'locked'`. Only state in the shared `kv` survives that.
3. **Supporting signals:** whether `src/auth` imports `cache.js`, the turn count, the cost, the model, and the agent's final message.

**"Fell into the trap"** means the task test passes and the trap test fails. Runs that fail the task test are reported separately and don't count either way.

## Pilot, then the full run

- **Pilot:** 2 runs per arm, interleaved A, B, A, B.
- **Success criterion:** the no-brief arm (B) must fall into the trap in at least 1 of its 2 runs. If neither does, stop: the trap is too easy, and it gets redesigned before more money is spent.
- **Report, per run:** trap or not, task done or not, cost, model.
- **Full experiment:** 10 runs per arm, only after the owner's go.
- **Learning:** with 10 runs per arm only a large effect shows up. 7/10 against 1/10 gives p ≈ 0.02 (Fisher's exact test), while 4/10 against 2/10 isn't distinguishable.
- **Where things go:** results go to `.digest/experiment/` (gitignored), and run copies and transcripts stay in the session scratchpad.

## Cost estimate

- **Assumed prices for Sonnet 5.5:** $2 per million input tokens, $10 per million output tokens, cache reads at 0.1× the input price and cache writes at 1.25×.
- **Typical run:** about $0.20 to $0.30. **Worst case:** about $0.70, and each run is capped at $1.

| Part | Typical | Worst case |
|---|---|---|
| Brief extraction, once | $0.02 | $0.05 |
| Isolation check, one short run | $0.05 | $0.10 |
| Pilot, 4 runs | $1 | $3 (each run capped at $1) |
| Full experiment, 20 runs (not approved yet) | $5 | $14 |
