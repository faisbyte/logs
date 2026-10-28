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
- **Update (2026-10-28):** Values that are clearly not secrets are now also kept:
  - function calls (`getToken()`, `os.getenv("X")`)
  - dotted references (`config.apiKey`)
  - `yes`/`no`/`on`/`off`/`enabled`/`disabled`
  - `${{ secrets.X }}`, `$(cmd)` and `process.env["X"]`

  The check looks at the text right after the value, because the value pattern stops at `(`. Bare words and identifiers (`letmein`, `hunter_two`) are still redacted, because they could be weak passwords and over-redaction is preferred when unsure.

## D13. Entropy detection scores structure, not just entropy

- **Date:** 2026-10-28
- **Decision:**
  - **Candidates:** runs of `[A-Za-z0-9+/_-]` of 20+ chars. Absolute paths are judged one segment at a time.
  - **Blanked out first:** UUIDs, SRI hashes, API object IDs (`toolu_`, `msg_`, `req_`, `call_`, …), public PEM blocks, SSH public keys, compact ISO timestamps (`20261024T130212Z`) and alphabet constants.
  - **Flagged when** the candidate has upper, lower and digit; isn't pure hex; has wordiness below 0.62; and its Shannon entropy is within `0.5 + 0.01·min(n, 64)` bits of `log2(min(n, 64))`. Wordiness is the share of alphanumerics in `[A-Z]?[a-z]{3,}` or `[A-Z]{4,}` runs.
- **Alternatives:** A fixed entropy threshold (detect-secrets style, 4.5 bits for base64).
- **Why:**
  - At 20–30 chars, entropy alone overlaps: `getUserById2FactorAuthTokenV3` scores 4.39 bits, above the 1st percentile of random 28-char tokens (4.04). Wordiness separates them.
  - On 20,000 random tokens per length, the 0.62 cut misses about 2–3% at 20 chars and under 1% at 32+. Identifiers and names score 0.63–0.94. The entropy band sits at the random 99.5th percentile by length.
  - Calibrated on the developer's 15 real sessions: false-positive tests for every shape found came first, and hits dropped from 121 to about 21, most of which look like real tokens.
  - **Known costs:** pure-hex secrets and all-lowercase random tokens are never flagged by entropy, though they're still caught when assigned to a secret-named key (D12). A few separator-joined names with 3-letter words are still flagged.

## D14. PII redaction (emails and phone numbers) is on by default

- **Date:** 2026-10-28
- **Decision:** Emails and phone numbers are redacted unless turned off with `.digest/config.json` → `redaction.pii.email` / `redaction.pii.phone` set to `false`.
  - **Phones:** formatted numbers only: `+international`, `(area) code`, national numbers with a leading `0`, and US `NNN-NNN-NNNN`, with 8–15 digits.
  - **Emails:** SSH remotes (`git@github.com:org/repo`) and URL user info (`ssh://git@host`, `https://user:token@host`) aren't treated as emails.
- **Alternatives:** Off by default (opt in), as the plan's "optional" wording allows.
- **Why:** Summaries go to managers, and the narrative never needs a colleague's or customer's address, so redacting costs little and fails safe. On the developer's 15 real sessions, 84 of 91 email hits were `noreply`/`example.*` addresses (commit trailers, test data). Phone detection fired once, on what looks like a real number, and never on dates, versions, IPs or IDs. Opt-out keeps it available for teams that want names and contacts in digests.

## D15. Allow and deny lists: literals as strings, regexes as objects, deny wins

- **Date:** 2026-10-28
- **Decision:** `.digest/config.json` → `redaction.allow` and `redaction.deny` take plain strings (literals) or `{ "regex": "…", "flags": "i" }`.
  - **Deny** redacts every case-sensitive literal occurrence and every regex match as `[REDACTED:deny_list]`.
  - **Allow** keeps a detected value only when it equals a literal or matches a regex. A value that merely *contains* an allowed literal is still redacted.
  - **Deny always beats allow.**
  - **Validation:** the `redaction` section is strict (unknown keys are an error), and regexes are compile-checked when the file loads.
- **Alternatives:** Treat `/…/` strings as regexes; make allow override deny.
- **Why:** Deny entries are often paths (a home directory), which would collide with a `/…/` convention. Strictness and deny-wins both fail closed: a typo or a conflicting entry never redacts less. Known cost: a pathological regex in the config can be slow, because JavaScript regexes can't be time-limited. The config is the developer's own and stays local.

## D16. Redaction can't be skipped: a branded, frozen RedactedSession

- **Date:** 2026-10-28
- **Decision:** `redactSession()` is the only way to get a `RedactedSession`. It's a class with a private `#brand` field, and its module exports the class as a **type only**, so other code can't construct one. Its `session` is `DeepReadonly` and deep-frozen at runtime, and `isRedactedSession()` checks the brand at runtime. **Rule for Phases 3 and 5:** every function that sends session-derived data off the machine (LLM calls, uploads) takes a `RedactedSession`, never a `ParsedSession`.
- **Alternatives:** A phantom brand type (`ParsedSession & { [brand]: true }`); a runtime-only check.
- **Why:**
  - A phantom brand survives `{...redacted, title: raw}`, which would let unredacted text back in. A `#private` field doesn't survive spreading, and TypeScript treats classes with private fields nominally.
  - Freezing stops redacted text being swapped back in place.
  - `packages/core/test/redact/types.test.ts` compiles snippets with the real `tsc` and pins the exact error for each misuse: a raw session, a look-alike, a spread copy, mutation, and direct construction. A mutation check confirmed it fails when the brand is removed.
  - **Known limit:** an `as unknown as RedactedSession` cast still compiles. `isRedactedSession()` catches it at runtime, so egress code should call it too.

## D17. Redaction fails closed and stays linear-time

- **Date:** 2026-10-28
- **Decision:**
  - If any detector throws on a string, the whole string becomes `[REDACTED:unscannable]`, and a cyclic object in a session is replaced the same way. `redactText` and `redactSession` never throw.
  - Every regex quantifier next to a fixed core is bounded (`{0,64}` key-name prefixes, JWT segments ≤ 8 KB). The JWT scan only runs when `.eyJ` appears. Public PEM blocks are found by a linear scanner, not a lazy regex.
  - `robustness.test.ts` holds pathological inputs (200 KB to 1 MB) with a 1.5 s budget each.
- **Alternatives:** Throw on detector errors; run redaction in a worker with a timeout.
- **Why:** Throwing would push every caller to catch-and-continue, which is how unredacted text leaks. A timeout worker adds a process boundary and still has to decide what to do on timeout (it would have to be fail closed anyway). Two real patterns were catastrophic before bounding: a repeated `secret` word and dash-joined `eyJ-` both took more than 10 s on 200 KB. They now finish in under 15 ms. Known limit: user-supplied deny regexes can't be bounded this way (D15).

## D18. Empty sessions are hidden by default (Codex exec twins)

- **Date:** 2026-10-28
- **Decision:** A session with no assistant text, reasoning or tool calls (including subagent calls) is empty. `digest list` hides empty sessions unless `--all` is passed and says how many were hidden. Later phases never summarise them.
- **Alternatives:** Collapse each Codex `exec` rollout into the `vscode` rollout started in the same second with the same cwd.
- **Why:** Chosen by the project owner. Simple, with no reliance on undocumented extension behaviour, and it also covers sessions abandoned at the first prompt in either agent. Known cost: a prompt that got no answer (an API error, say) is hidden too, and `--all` is the escape hatch.

## D19. The home directory becomes `~` and the username is redacted, by default

- **Date:** 2026-10-28
- **Decision:** Before the detectors run, every string has the following replaced:
  - the home path (`/Users/<you>`, on path boundaries) → `~`
  - its encoded form in Claude project directory names (`-Users-<you>`) → `~`
  - the bare username, bounded by non-alphanumerics → `[REDACTED:username]`

  Generic usernames (`root`, `runner`, `ubuntu`, `dev`, …) aren't replaced as bare words. The defaults come from `os.homedir()` and `os.userInfo()`, and `redaction.home: false` in `.digest/config.json` turns all of this off.
- **Alternatives:** Replace only the literal home path; leave the username to the deny list.
- **Why:** The owner asked that usernames never leave the machine. The home path alone isn't enough, because the username also appears in encoded project directories (`sourcePath`), hostnames (`<you>-MacBook-Pro`), `ls -l` owner columns and hyphen-joined names. On the developer's 15 real sessions, 3,148 home and 305 username replacements left zero occurrences in any case. Generic names identify nobody, and replacing them would mangle words like "runner".
