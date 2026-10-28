# Decisions

Architectural decisions, oldest first. Each entry: date, decision, alternatives considered, why.

## D1. TypeScript monorepo, pnpm workspaces, core + cli only

- **Date:** 2026-10-28
- **Decision:** TypeScript monorepo with pnpm workspaces. `packages/core` (schemas, parsers) and `packages/cli` (binary `digest`). `apps/server` and `apps/web` are deferred to their phases.
- **Alternatives:** Python (Typer + FastAPI + Pydantic), as allowed by the plan.
- **Why:** The plan's default. CLI and future server share zod schemas and types directly.

## D2. Plain `tsc -b` with ESM and NodeNext, no bundler

- **Date:** 2026-10-28
- **Decision:** Each package compiles with `tsc -b` (project references) to `dist/`, as native ESM with `NodeNext` resolution.
- **Alternatives:** tsup or esbuild to bundle the CLI into one file.
- **Why:** No extra tooling. Node 22 runs the output directly. Bundling can be added if and when the CLI is published.

## D3. pnpm 10 pinned through corepack

- **Date:** 2026-10-28
- **Decision:** `packageManager: pnpm@10.34.9`, installed with `corepack install -g`.
- **Alternatives:** pnpm 12 (latest); `npm install -g pnpm`.
- **Why:** The corepack bundled with Node 22 (0.34) can't launch pnpm 12, whose package layout changed. Pinning keeps installs reproducible on a stock Node 22 setup.

## D4. One root vitest config, tests run against core source

- **Date:** 2026-10-28
- **Decision:** A single `vitest.config.ts` at the root collects `packages/*/test/**/*.test.ts`, and aliases `@digest/core` to `packages/core/src`.
- **Alternatives:** Per-package vitest configs; tests resolving `@digest/core` through its built `dist/`.
- **Why:** One `pnpm test` command, and unit tests don't need a build. The CLI binary smoke test still runs the built output, so packaging errors are caught.

## D5. commander for the CLI

- **Date:** 2026-10-28
- **Decision:** Use commander.
- **Alternatives:** yargs.
- **Why:** Smaller API surface, first-class TypeScript types, and output and exit hooks that make the CLI testable in-process. The plan lists both.

## D6. Commit SHAs come from a git time window

- **Date:** 2026-10-28
- **Decision:** A session's commit SHAs are the commits whose commit time falls between the session's first and last event, found by running `git log` in the repo, on any branch the session recorded.
- **Alternatives:** Parse commit output from the agent's own tool calls (`[branch sha] msg`, or `git log --oneline` after `git commit`).
- **Why:** On real data, all 52 successful agent commits used `git commit -q`, which prints no SHA, so transcript parsing would find almost nothing. The git window works the same for both agents. Known cost: it can include hand-made commits or commits from a parallel session in the same window. Narrowing by files-touched overlap is a possible later refinement. (Chosen by the project owner.)

## D7. A session belongs to a repo by its launch cwd

- **Date:** 2026-10-28
- **Decision:** A session belongs to the current repo when its first recorded cwd is the repo root or inside it.
- **Alternatives:** Include the session if any cwd it recorded is inside the repo.
- **Why:** Precise. Real sessions change cwd mid-session, and about half of those changes go to unrelated paths, so "any cwd" would misattribute sessions. Known cost: a session launched from a parent folder that later moves into the repo is missed. (Chosen by the project owner.)

## D8. Claude Code subagents are folded into the parent session

- **Date:** 2026-10-28
- **Decision:** `<session>/subagents/agent-*.jsonl` files aren't listed as separate sessions. Their tool calls and files touched are merged into the parent session's metadata and counts. Their prompts and messages aren't.
- **Alternatives:** Ignore subagent files and use the parent transcript only.
- **Why:** Subagents (some running in worktrees) edit files, and leaving them out would under-report `filesTouched`. Their conversation stays out so the parent narrative stays readable. (Chosen by the project owner.)

## D9. State file records processed sessions only, and `digest list` is read-only

- **Date:** 2026-10-28
- **Decision:** `.digest/state.json` records sessions marked processed, each with a fingerprint, so a session that grows after processing shows as "changed". `digest list` only reads it and shows new / changed / processed.
- **Alternatives:** `digest list` records every session it sees and flags what's new since the last run.
- **Why:** Keeps "processed" meaning one thing, and avoids a list command with side effects. Until summarisation lands (Phase 3), every session shows as "new". (Chosen by the project owner.)

## D10. Tool-output truncation is a separate step with head-and-tail limits

- **Date:** 2026-10-28
- **Decision:** Parsers keep full tool output. `truncateToolOutputs()` runs before anything consumes content (redaction, summarisation). It drops `Read` output (file dumps) entirely, keeps the first and last 1,000 of any output over 2,000 chars with a "[… N chars truncated …]" marker, and caps tool input summaries at 500 chars. Prompts, assistant text, reasoning, tool names and file paths are never truncated.
- **Alternatives:** Truncate inside the parsers; keep the head only.
- **Why:** Keeping parsing and condensing apart lets later phases tune the limits without re-parsing. The tail of command output usually holds the error or test summary, and real outputs reach 525 KB.

## D11. Session directories follow the agents' own overrides

- **Date:** 2026-10-28
- **Decision:** Claude Code sessions are read from `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), and Codex sessions from `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
- **Alternatives:** Hard-coded home paths; digest-specific `--claude-dir` and `--codex-dir` flags.
- **Why:** These are the variables the agents themselves use to relocate their data, so digest finds sessions wherever the agent wrote them. Tests use the same mechanism to point at fixtures.

## D12. `.env`-style detection only redacts secret-named keys

- **Date:** 2026-10-28
- **Decision:** `KEY=value`, `"key": "value"`, `key: value` (at line start or inside a quoted header) and `Authorization: Bearer …` are redacted only when the key name contains `secret`, `token`, `password`/`passwd`/`pwd`, `api_key`, `access_key`, `private_key`, `auth`, `credential`, `session_key`, `signing_key`, `encryption_key` or `dsn`. Values that are numbers, booleans, type names, variable references (`$X`, `${X}`, `process.env.X`) or placeholders (`<…>`, `***`) are kept. Unquoted `key: value` in the middle of prose isn't matched.
- **Alternatives:** Redact every `KEY=value`.
- **Why:** The convention used by gitleaks and detect-secrets. Redacting every assignment would wipe `NODE_ENV=production`, `TZ=UTC`, `PORT=3000` and similar from commands that summaries need. Unnamed secrets are still caught by the provider patterns and the entropy detector. Known cost: some code false positives, for example `token: getToken()` at line start.
