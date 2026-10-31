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

## D20. Allow and deny entries are literal strings only (supersedes the regex part of D15)

- **Date:** 2026-10-28
- **Options considered:**
  - **A. Validate regexes at config load.** Reject patterns that fail a conservative static check (nested quantifiers, quantified groups containing alternation, backreferences, overlong patterns). This keeps simple patterns like `ACME-\d{4}`, but the check is heuristic: even group-free patterns such as `\d*\d*\d*x` backtrack polynomially, so it can't guarantee linear time.
  - **B. Literal strings only.** Matching is `indexOf` and `Set.has`, linear by construction. Regex entries (`{ "regex": … }`) are rejected at load with a message pointing here.
- **Decision:** B, for both `deny` and `allow`. It's clear-cut: B removes the risk entirely, while A only reduces it.
- **Why also `allow`:** Allow regexes are tested against detected values, which can be megabytes long (private key blocks, entropy tokens), so they have the same backtracking exposure. A broad allow pattern (`"."`) would also silently keep every detected secret, which is a fail-open risk that literals can't create.
- **Known cost:** No pattern matching. A family of values (every `ACME-1234` ticket id, every `@example.com` address) has to be listed one by one. If that proves painful, a linear-time engine such as RE2 would be the way back, not hand-validated JavaScript regexes.

## D21. Summariser model: Claude Haiku 5.5, low effort, 60K-token chunks

- **Date:** 2026-10-28
- **Decision:** The default model is `claude-haiku-5-5`, run at effort `low`, with input split into chunks of about 60K tokens. All three are overridable in `.digest/config.json` → `summarize` (`model`, `effort`, `chunkTokens`). Cost estimates use a pricing table checked against Anthropic's live models and pricing pages on 2026-10-28.
- **Alternatives:** `claude-sonnet-5-5` ($2 / $10 per MTok) by default; no chunking, relying on the 1M context window.
- **Why:** The plan asks for a fast model for per-session summaries. Haiku 5.5 is Anthropic's fastest, cheapest current model: $0.10 / $0.50 per MTok, but $0.50 / $2.50 once a single prompt passes 100K tokens. Chunks of about 60K estimated tokens (2.5 chars per token; see the D22 correction) keep every request on the cheaper rate card and keep each summary focused. *Chunk size superseded by D31 (15K).* Haiku 5.5 has adaptive thinking on by default, so effort is the cost lever. It doesn't accept `temperature` or prefill, so JSON comes from structured outputs.

## D22. What the summariser sees: a condensed transcript, chunked by turns

- **Date:** 2026-10-28
- **Decision:** `condenseSession(RedactedSession)` produces two parts:
  - **Metadata header**, sent with every chunk: agent, branch, dates, counts, and files changed relative to the cwd. Subagents appear here, condensed harder: type, description, a final report capped at 300 chars, and files.
  - **Turns:** `USER:` prompts (capped at 4,000 chars), `ASSISTANT:` text (capped at 2,000 chars), and `TOOL <name> <paths>` lines, all with head-and-tail truncation. Rejected and failed tools and interruptions are marked, and consecutive identical tool lines collapse to `×N`. Reasoning and tool outputs are left out.

  Chunks pack whole turns up to the token budget, estimated at 2.5 chars per token. A turn is split by line only if it alone exceeds the budget.
- **Alternatives:** Send tool outputs truncated; include reasoning text; split at fixed character offsets.
- **Why:** This follows the owner's spec (prompts, assistant text, tool names, file paths). The rejected and failed markers carry the evidence for abandoned approaches at a few tokens each. Turn boundaries keep each prompt next to its consequences. The 2.5 chars-per-token figure comes from Anthropic's "1M tokens ≈ 2.5M characters" note for the current tokenizer. **Correction (2026-10-28):** it does *not* err high. On the real runs it under-counted input by up to 46%: worst on v2 transcripts, whose shell-command lines tokenize densely, and on small sessions, where the JSON schema dominates the prompt. A ×1.4 margin was still 4% short on one v2 session, so cost estimates now apply a ×1.6 input margin and assume 3,000 output tokens per call. Both are calibrated so every observed request came in at least 5% under its estimate, and a test records the observations. Chunk sizing still uses the unmargined figure; a 60K budget under-counted by 32% is still under the 100K price tier. Subagents get one line because their work is already reflected in the parent's tool calls and files.

## D23. The LLM sits behind an interface; every request carries its RedactedSession

- **Date:** 2026-10-28
- **Decision:** `LlmClient.complete(LlmRequest)` is the only way to call a model. Each request carries `source: RedactedSession`, and every implementation's first line is `guardRequest()`, which calls `assertRedactedSession()` and throws. There are two implementations:
  - `FakeLlmClient`, scripted, used by all unit tests and the fake-pipeline eval
  - `AnthropicLlmClient`, the real API, used only by the CLI and by opt-in tests behind environment variables
- **Alternatives:** A guard only at `summarizeSession()`; brand the prompt string instead of carrying the session.
- **Why:** The owner asked for a hard check at every LLM and network entry point. Carrying the session means the check runs inside the client, so a future caller that builds requests some other way still can't skip it. The fake keeps tests free, deterministic and offline.

## D24. Long sessions: sequential parts, decisions tracked by id, lists merged in code

- **Date:** 2026-10-28
- **Decision:** Chunks are summarised in order. Each part's prompt lists the still-open decisions from earlier parts as `D1`, `D2`, …, and a part reports a reversal by ID in `reversedDecisions` (with the reason). The lists are then merged deterministically:
  - reversed decisions move to `rejectedApproaches` with the reversal reason
  - other decisions, rejected approaches and follow-ups are concatenated and de-duplicated

  One final call, with its own strict schema, writes the whole-session narrative (goal, outcome, what was done, AI involvement) from the part summaries. A session that fits in one chunk makes exactly one call.
- **Alternatives:** Summarise chunks independently and let one LLM merge call reconcile everything; a rolling summary that rewrites itself each part.
- **Why:** The owner's test case, a decision made early and reversed later, has to end up as a rejected approach. Leaving that to a free-text merge can't be checked; tracking IDs makes it deterministic and testable with the fake model. Parts run sequentially, which costs latency, but they can't see later decisions otherwise.

## D25. Summary cache and drafts live in .digest/, keyed by what produced them

- **Date:** 2026-10-28
- **Decision:** The cache key is `sha256(sessionId, contentHash, promptVersion, model)`. `contentHash` hashes the condensed, redacted text plus the chunk size, so it changes when the session grows, when redaction settings change, or when chunking changes. Bumping `PROMPT_VERSION` or switching model also invalidates. Files:
  - cache entries: `.digest/cache/summaries/<key>.json`
  - latest draft per session: `.digest/summaries/<agent>-<id>.json`, status `draft`
  - usage log: each generated summary appends one line to `.digest/usage.jsonl` (input and output tokens, request count, estimated cost, plus each part's output, the merge's picks and the validation errors behind every retry, added 2026-10-29); cache hits don't
  - corrupt cache entries count as misses
- **Alternatives:** Key on the source file's hash (misses redaction-config changes); cache in the OS temp directory.
- **Why:** Keying on exactly what the model sees means a summary is reused only when an identical request would be sent. `.digest/` is already self-ignoring (D9), so drafts never reach git, and nothing is uploaded in Phase 3.

## D26. The API key comes from the environment or the digest checkout's own .env

- **Date:** 2026-10-28
- **Decision:** `ANTHROPIC_API_KEY` is read from the environment. If it isn't set there, the `digest` binary (and vitest, for the opt-in live tests) fills it from the `.env` file in the digest checkout's root. Variables already set in the shell win, empty values are skipped, and values are never printed. `.env` is gitignored; `.env.example` is committed.
- **Alternatives:** Read the target repo's `.env`; a dedicated `~/.config/digest` file; environment only.
- **Why:** The owner asked for a `.env` file to hold the key. A target repo's `.env` belongs to that project, and silently picking up its credentials would be surprising. Skipping empty values means the blank placeholder can't shadow other credential sources.

## D27. Merging parts distills by picking candidate ids (refines D24)

- **Date:** 2026-10-28
- **Decision:** For a multi-part session, the merge call receives each part's narrative plus numbered candidates: open decisions (`D…`), rejected approaches including reversed decisions (`R…`), and follow-ups (`F…`), with exact duplicates removed. It returns the whole-session goal, what was done and AI involvement, plus at most 6 ids per list, choosing one from each group of near-duplicates. Code then assembles the lists from the chosen candidates. More than 6 ids, or ids that weren't offered, fail validation and get the one retry. The outcome is taken from the last part (the session's end state). Both prompts tell the model to write about the work only, never about parts, the transcript, metadata, summarising or a team log.
- **Alternatives:** Let the merge rewrite the lists as free text; cap lists in code by position (first or last 6).
- **Why:** v1 concatenated every part's lists, so long sessions produced bloated summaries. Selecting by id keeps the model's judgement about what's durable and important, but it can't paraphrase a reversed decision back into "decisions" or invent items. A test checks that a merged summary stays within 1.5× the size of a single-part one.

## D28. Sessions split into work periods at 6-hour idle gaps

- **Date:** 2026-10-28
- **Decision:** An idle gap of 6+ hours between turns starts a new work period. Each period is summarised as its own part, even if the whole session fits in one chunk, and the distilling merge (D27) writes the whole-session goal and narrative across every part. The transcript marks the break as `[resumed after N hours]`. The metadata header now states the number of work periods and the commits made during the session. The prompt says to cover every task, weighted by how much work each took, and never to contradict the metadata.
- **Investigation:** In the two multi-day real sessions (`d94236d8`, `1e399842`), v1 described only the last task. The cause was neither compaction (neither has a `compact_boundary`) nor condensation (every turn from every day was sent, in one chunk, with the first day making up about 75% of the text). With one request, the model anchored on the final task, helped by the singular "goal" field and by nothing in the input marking the break between periods.
- **Alternatives:** Prompt changes only; split by calendar day.
- **Why:** A prompt-only fix leaves coverage to a low-effort model that had already ignored most of the input. Splitting into parts makes every period get its own summary, which the merge must cover. Idle gaps work regardless of time zone, unlike calendar days. The cost is one extra request per additional period plus the merge.

## D29. filesTouched is repo-relative, in-repo only, with a commit fallback

- **Date:** 2026-10-28
- **Decision:** Before redaction, `prepareSessionForRepo()` rewrites `filesTouched` (and each subagent's files):
  - paths inside the repo become relative to the **repo root**, not the session's cwd
  - `.claude/worktrees/<name>/…` maps back to the repo path it copies
  - paths outside the repo are dropped: temp and scratchpad dirs, `~/.claude/`, other repos, and the repo's own `.git/` and `.digest/`

  It also fills `commitShas` from git (D6). When the transcript yields no in-repo files but commits were made during the session, `filesTouched` falls back to the files those commits changed.
- **Alternatives:** Keep paths relative to the cwd; keep outside paths but mark them.
- **Why:** Stakeholders and teammates care about the project's files, not scratch files or agent memory. The real `thrift` session listed one file per worktree copy, and Bash-only sessions listed nothing at all; the commit fallback covers the second case (the Phase 1 gap).

## D30. Writes only go to a valid repo; nothing outside it is created

- **Date:** 2026-10-28
- **Decision:** Commands that write (`summarize`, and the Phase 4 review commands) require a repo path that exists, is inside a git repo, and whose root isn't the home directory. Otherwise they stop with `skipped: … drafts need a valid repo`. `ensureDigestDir()` refuses to create a missing repo root. Read-only commands (`list`, `redact`) still accept a non-git path, but also refuse the home directory.
- **Alternatives:** Fall back to the raw path, as before; allow the home directory with a warning.
- **Why:** The Phase 3 run recreated a deleted project folder (`~/Documents/GitHub/pretian-takehome`), because `mkdir -p` built the missing root, and wrote `~/.digest/` because the home directory is a git repo on this machine. A home-directory "repo" holds every project, so per-repo state there is meaningless. Both stray folders were deleted at the owner's request.

## D31. Default chunk size is 15K tokens (supersedes D21's 60K)

- **Date:** 2026-10-29
- **Decision:** `DEFAULT_CHUNK_TOKENS` is 15,000 estimated tokens. `.digest/config.json` → `summarize.chunkTokens` still overrides it.
- **Evidence:** In the v2 re-run, real session `1740fae9` had two work periods of about 27.9K and 23.7K tokens. At 60K each period was one part, and the v2 goal and all six picked decisions came from the second period only, which was worse than v1. Re-run at 15K (5 parts, 6 requests), the summary covered both periods evenly. Cost went from $0.0077 to $0.0106.
- **Alternatives:** Keep 60K and only balance the merge (the coverage half of this fix, which remains in place: D32).
- **Why:** The recency bias seen in multi-day sessions (D28) also happens inside a single large part, and only smaller parts prevent it. The extra requests cost fractions of a cent per long session.

## D32. The merge covers every part, or every work period (refines D27)

- **Date:** 2026-10-29
- **Decision:** The merge input labels each part with its work period ("Part 2 of 5 (work period 1 of 2)") and each candidate with the part it came from ("D3 (part 2): …"). The merge prompt says `goal` and `whatWasDone` must cover every work period, and each list must include at least one id from every part that offered candidates for it. Code then enforces that per list (`coverParts`): if a part that offered candidates has no pick, its first candidate is added. When that would exceed 6, it replaces the lowest-ranked pick of the part with the most picks. When more than 6 parts offered candidates, the guarantee is per work period instead. If even the periods outnumber the slots, the model's picks stand. Lists come out in session order. Exact duplicates keep their earliest occurrence. A reversed decision counts toward the part that reversed it. Prompt version `summarize-v3`.
- **Alternatives:** Prompt-only coverage; a validation error plus retry when a part is missing (a second miss would fail the whole session).
- **Why:** At 60K, `1740fae9`'s merge picked every decision from the last part (D31). Smaller chunks reduce that bias but don't rule it out. Enforcing coverage in code makes it deterministic and testable with the fake LLM. The model still chooses which items to keep, except for the one top-up per uncovered part.

## D33. Reversals must quote their part; follow-ups can be resolved; no follow-up top-up (refines D24, D32)

- **Date:** 2026-10-29
- **Decision:**
  - A part's `reversedDecisions` entry must include `evidence`, a phrase copied word for word from that part's transcript. Code accepts the reversal only if the quote appears in that part's chunk (ignoring case and spacing). Otherwise the decision stays a decision. The prompt says a decision a part merely doesn't mention or apply is not reversed.
  - Later parts receive earlier, still-open follow-ups by id, the same way they receive decisions. They can list ids in `resolvedFollowUps`, and resolved follow-ups are removed before the merge. A resolved follow-up that a later part raises again counts as new.
  - The coverage top-up from D32 now applies only to decisions and rejected approaches. Follow-ups are the merge's picks only, in session order.
  - Prompt version `summarize-v4`.
  - *Follow-up (v5, v6):* a decision repeated word for word in a later part keeps its first id, so the coverage top-up can't add a duplicate (v5, found in `ad86b19b`). Each part of a split session is told that it is one stretch of a longer session: it should list only work it started and left unfinished, and report `outcome` for its own work (v6, found by tracing `eval.early`, where part 3 called part 1's finished screens incomplete). *Reverted in v7:* with that note, part 1 of real session `d94236d8` described the pipeline it built as "existing code" in 2 of 3 samples and kept 1–4 pipeline decisions; without it, 9–11 decisions every time (7–9 about the pipeline) and never "existing". A variant written only for part 1 did no better. Stale follow-ups are handled at the merge instead (D36).
- **Alternatives:** Ignore reversals that come from a different work period; ask the merge to judge which follow-ups are stale.
- **Why:** In the v3 run, part 2 of `70aeaa9c` "reversed" part 1's light-theme decision because it didn't see the theme applied in its own part, so an adopted decision showed up as rejected. In the `eval.early` golden, the judge flagged follow-ups from early parts ("screens not yet translated") that later parts had finished. Coverage made this worse by guaranteeing every part a follow-up. A quote check is cheap and deterministic, and resolving by id mirrors the reversal mechanism that already works.

## D34. Approval is a brand: ApprovedSummary, and one upload gate

- **Date:** 2026-10-29
- **Decision:**
  - **States:** `draft → approved | rejected`. `reopen()` returns an approved or rejected summary to draft, unless it has been pushed (`pushedAt`). `approve()` and `reject()` accept drafts only.
  - **Brand:** `ApprovedSummary` is a class with a `#brand` field, exported as a type only, so the compiler rejects raw drafts, look-alike objects and spread copies. Its summary is deep-frozen, so it can't be edited after approval, at compile time or at runtime.
  - **Producers:**
    - `approve()` is the only function that approves. It records `approvedAt`, `approvedBy` (`developer` or `auto`) and `approvalHash`, a sha256 of the shared fields.
    - `verifyApproval()` re-checks an approval read back from disk. The status must be approved, every approval field must be set, and the hash must still match, so a hand-edited JSON file doesn't pass. It can't approve anything itself.
  - **Upload gate:** Phase 5 must build its request body with `uploadPayload(approved)`, which takes only an `ApprovedSummary`, re-asserts the brand and the hash at runtime, and returns only `SHARED_FIELDS` plus session id, agent and approval details.
  - **Shared fields:** `SHARED_FIELDS` is the single list used by both the review header and the upload payload.
- **Alternatives:** A `status === 'approved'` check at upload time only, which is easy to forget and easy to forge; a separate approvals file signed with a local key, which is heavier and protects against nothing extra, because the developer owns the machine.
- **Why:** The plan's "Done when" for Phase 4 is that nothing can be uploaded without an explicit approval. It follows the `RedactedSession` pattern (D16): the compiler blocks the accidental paths, and a runtime check blocks forced casts. The hash covers the case where a summary is changed after it was approved.

## D35. Summaries are edited as YAML in $EDITOR

- **Date:** 2026-10-29
- **Decision:**
  - **Format:** `edit` writes the editable fields as YAML under `.digest/edit/` and opens it in `$EDITOR`. A comment header names the session, what will be shared, the allowed values, and how to cancel.
  - **Editable:** every text field, `outcome`, `aiInvolvement` and `ticketRefs`. `filesTouched` entries can be deleted but not added.
  - **Validation:** a saved file is parsed with the `yaml` package and validated by a strict zod schema. Unknown keys, empty text and invalid values are errors.
  - **Errors:** the file reopens with each error as a `# ERROR:` comment at the top, and old error comments are dropped.
  - **Cancelling:** closing the editor without saving, or saving the file unchanged, changes nothing, even after errors.
  - **Redaction:** every edited string is redacted again with the repo's redaction settings, and the command reports what was redacted.
  - **Recording the edit:** a real change sets `editedByDeveloper: true`. The first time a summary is edited, the model's output is saved to `.digest/originals/`.
  - **Who can edit:** only drafts. An approved or rejected summary must be reopened first, so an approval always covers exactly what was approved.
- **Alternatives:** Structured markdown, with `## Decisions` sections and bullet lists, parsed by a custom parser. It's friendlier to write, but it needs its own grammar for nested items such as a decision's reason, and its error messages would be ours to invent.
- **Why:** YAML maps directly onto the summary's shape, so validation is just the schema. Long text folds onto readable lines, and the `yaml` package reports syntax errors with line numbers. The one cost is a small, widely used dependency.

## D36. Stale follow-ups are dropped by the merge, not by the parts

- **Date:** 2026-10-29
- **Decision:** The merge prompt tells the model to leave out any follow-up that a later part's "What was done" shows was finished. Parts get no extra instruction about other parts, apart from the decision and follow-up ids they already receive (D33).
- **Alternatives:** A note to each part saying it is one stretch of a longer session (v6, reverted: part 1 then called its own work "existing"); leave stale follow-ups for the developer to delete during review.
- **Why:** Only the merge sees every part's narrative, so it can tell that "ko onboarding still needs translating" from part 2 was done in part 3. This is prompt-only, so it isn't guaranteed. The review step (Phase 4) remains the backstop.

## D37. Review commands, what re-summarising leaves alone, and auto-approve

- **Date:** 2026-10-29
- **Decision:**
  - **Commands:**
    - `digest review` steps through drafts only: approve, edit, reject, skip or quit. Quitting leaves the current draft for next time.
    - `digest review --list` shows every summary with its status.
    - `digest approve <id>`, `digest reject <id>` and `digest reopen <id>` do the same transitions without a terminal.
    - Interactive review needs a terminal. Without one, the command points at the non-interactive commands.
    - The editor is `$VISUAL`, then `$EDITOR`, then `vi`. The edit file's path is passed to the shell as an argument, never interpolated.
  - **Re-summarising:**
    - Approved summaries and developer-edited ones are never re-summarised, not even by id. They are left out of the estimate and reported as `kept`. `writeSummary` refuses to overwrite them as a second line of defence.
    - Rejected summaries are skipped by `--all`. Naming one by id re-summarises it into a new draft, a deliberate step rather than an automatic one.
  - **Reopen:** works for rejected summaries as well as approved ones. A reopened summary is a draft again and still needs `approve()` before it can be uploaded.
  - **Auto-approve:** `.digest/config.json` → `review.autoApprove` (default off) approves each new draft right after `summarize`, with `approvedBy: "auto"`. The review list and display say "approved automatically".
- **Alternatives:** Never re-summarise a rejected summary, even by id; treat an edited draft as replaceable until it is approved.
- **Why:** The spec says rejected summaries are never re-summarised *automatically* and reviewed work is never overwritten. Asking by id is a manual choice. An edit is the developer's own work, so losing it to a prompt-version bump would be worse than keeping a stale draft.

## D38. Near-duplicate follow-ups are removed in code after the merge

- **Date:** 2026-10-29
- **Decision:** After the merge, follow-ups are compared using a Dice coefficient over their content words (lowercased, punctuation and filler words removed). Pairs scoring above 0.5 count as one item. Of each group, the longest text is kept, at the group's first position. This applies to sessions summarised in parts, and the prompt version is `summarize-v8`. Stale follow-ups (work that a later part finished) are left to the developer's review, with no further prompt rule.
- **Calibration:** On the v7 real-session run, the two near-duplicate pairs (a re-knit check worded twice, and a hook-gating fix worded twice) scored 0.57 and 0.59. The closest pair of distinct items scored 0.33.
- **Alternatives:** Ask the merge model to merge rewordings, which it already fails to do reliably; use embedding similarity, which needs a model call or a dependency for a short list.
- **Why:** It's deterministic, testable and cheap. Keeping the longer text keeps the more specific wording.

## D39. Shared store: server with Postgres, or JSON on an orphan git branch

- **Date:** 2026-10-29
- **Status:** Accepted 2026-10-29: Option A, a server with Postgres (built as D43). The storage-agnostic parts came first (D40).

### Option A: a small HTTP server backed by Postgres

- **Access control:** we control it. Developers get a push token per repo; stakeholders get read-only access to reports and the dashboard without any repo access. That covers Phase 10's roles (developer, stakeholder, admin) and "stakeholders never see raw content" directly.
- **Concurrent pushes:** each push is a single transaction with a unique key on (repo, agent, session id), so pushes from several developers never conflict, and a repeat push is a no-op.
- **Server-side checks:** the server validates every payload with the shared zod schema and runs the secret detectors before storing anything, a real second line of defence.
- **Self-hosting:** someone has to run it. It would be one Node process plus Postgres, with Docker Compose in Phase 10 (already planned). Locally, tests can use an in-process Postgres (PGlite) so CI needs no database service.
- **Phase 7 (digests, on-demand team report):** date-range and per-developer coverage queries are plain SQL. Scheduled sends (Slack, email) need a long-running process anyway, and the server is that process. Sent digests become a table.
- **Phase 9 (dashboard):** served by the same server behind the same auth.
- **Phase 10 (hardening):**
  - **Retraction and delete-my-data:** real deletes or tombstones.
  - **Audit log:** a table.
  - **Rate limits and cost caps:** server middleware.
  - **Retention:** a scheduled cleanup job.
- **Cost:** hosting and operations, plus more code (HTTP layer, migrations, token management).

### Option B: JSON files on an orphan branch (e.g. `digest/summaries`) in the project repo

- **Access control:** it inherits repo access. Stakeholders could only read reports with repo access, unless a CI job republishes them elsewhere, which makes that job the real server. Tokens are just git credentials, so we can't issue per-repo tokens or hash them.
- **Concurrent pushes:**
  - One file per summary avoids merge conflicts. But simultaneous pushes are rejected as non-fast-forward, so the client must fetch, rebase and retry.
  - Immutability is by convention only: anyone with write access can rewrite the branch.
- **Server-side checks:** none on github.com, which has no custom pre-receive hooks. A CI check only runs after the content is already in the remote.
- **Self-hosting:** nothing to run. It works offline and costs nothing, which is the strongest argument for this option.
- **Phase 7:** the client fetches the branch and scans every JSON file. That's fine for one team. Scheduled digests need CI cron, and delivery secrets live in CI.
- **Phase 9:** a static site built from the branch. For a private repo the site is either public or limited to repo members, which brings back the access problem.
- **Phase 10:** retraction leaves the content in git history unless the branch is force-rewritten. That conflicts with "delete my data" and with immutability. There's no audit log of reads.

### Recommendation

Option A. The requirement that stakeholders read reports without repo access, plus server-side validation and Phase 10's retraction and audit log, all point to a server. Option B suits a solo developer who never shares reports outside the repo, and it could come back later as a second `SummaryStore` implementation behind the same contract tests.

## D40. The storage-agnostic shared-store design

- **Date:** 2026-10-29
- **Decision:**
  - **Payload:** a push carries exactly what `uploadPayload()` returns, defined once as `UploadPayloadSchema` (strict, with length caps).
    - The receiving side runs `validatePush()`: the same schema, plus checks for transcript markers (role lines, condensed `TOOL` lines, JSONL event shapes) and the secret detectors.
    - PII, home paths and deny-list hits aren't checked, because they depend on the developer's own settings.
    - Errors name the field and the problem, never the value.
  - **Interfaces:** `SummaryStore` (push, list, teamReport) and `TokenStore` (issueToken, authenticate). The push rules and query semantics are shared code (`decidePush`, `matchesQuery`). A contract test suite pins them for every implementation. `InMemorySummaryStore` is the reference implementation and the test double.
  - **Identity:** a pushed summary is keyed by (repo, agent, session id).
    - The same content again returns `unchanged`. Different content, or the same session from another developer, returns `conflict`, because pushed summaries are immutable.
    - Every stored summary has `retractedAt` (always `null` for now), and queries skip retracted ones, which leaves room for author retraction in Phase 10.
  - **Repo identity:** the `origin` remote URL, normalised to lowercase `host/path` with no scheme, user, credentials, port or `.git`. The raw URL is never printed, since it may contain credentials.
  - **Auth:**
    - One token per developer per repo (`dgt_` plus 32 random bytes, base64url). Issuing a new one replaces the old.
    - Only a sha256 of each token is stored. The token is returned once and never logged.
    - The pusher's identity comes from the token, never from the payload.
  - **Queries:** `list` filters by repo plus optional branch, ticket, developer and date range. A session matches the range `[from, to)` if it overlaps it.
  - **Team report:** `teamReport` returns every developer's summaries for a date range, with `summaryCount` and `developerCount`. It deliberately has no per-developer counts: the Phase 7 per-developer breakdown is off by default (the "no judgement of individual developers" rule). Each summary still carries its author's name, so a combined list shows who did what.
- **Alternatives:** Trust the client's validation; key summaries by developer as well, which would let two developers push the same session; use last-write-wins on re-push.
- **Why:** These rules are the same whichever store D39 picks, so they're built and tested once. Idempotent, immutable pushes make `digest push` safe to re-run, and a retraction field from the start avoids a migration later.

## D41. `digest init` installs a print-only pre-push reminder

- **Date:** 2026-10-29
- **Decision:**
  - **The hook:** `digest init` writes a `pre-push` hook made of comments, one `echo` to stderr, and `exit 0`. It doesn't run node, digest or git, so it can't block, slow or fail a push, and it never starts summarising.
  - **Location:** the hooks directory comes from `git rev-parse --git-path hooks`, which respects `core.hooksPath` and worktrees. A missing hooks directory isn't created.
  - **Existing hooks:** a `pre-push` hook digest didn't write is left untouched, and the command prints the one line to add by hand. Running `init` again is a no-op. Deleting the file removes the reminder.
- **Alternatives:** Compute and print the number of unpushed summaries in the hook, which needs node on the PATH and costs time on every push; chain onto an existing hook automatically, which edits someone else's script.
- **Why:** The spec requires that the reminder never blocks or slows a push. A static message is the only form that guarantees it.

## D42. `digest sync` composes the existing commands and checks everything first

- **Date:** 2026-10-29
- **Decision:**
  - **Steps:** `digest sync` runs `summarize --all --estimate`, then `summarize --all`, then the interactive review, then `push`. Each step is the same code as the standalone command.
  - **Checks first:** before anything is summarised, it checks for a valid repo, a configured shared store, a hosted `origin` remote and a terminal. Any problem that would stop it later stops it before any money is spent.
  - **Cost:** the estimate is always printed. The usual confirmation applies before sending more than one session.
  - **Stopping:** it stops without pushing if summarising fails or is declined, or if the developer quits the review. Skipped and rejected drafts don't stop it, since they are simply not pushed.
- **Alternatives:** Push whatever was approved even after a quit; carry on after a failed session.
- **Why:** The spec says quitting the review stops the sync, and a quit means "not now". Reusing the commands keeps one implementation of each rule.

## D43. The digest server: node:http, Postgres, PGlite for local runs and tests

- **Date:** 2026-10-29
- **Decision:**
  - **Package:** `packages/server` uses `node:http` with no web framework.
  - **Endpoints:**
    - `POST /v1/summaries` takes `{repoId, payload}` and goes through `receivePush`. It answers 201 created, 200 unchanged, 409 conflict, 422 rejected, 401 or 403 for token problems, 400 for bad JSON and 413 for bodies over 256 KB.
    - `GET /v1/summaries` filters by branch, ticket, developer and date range.
    - `GET /v1/team-report?from&to` is the combined report across every developer.
    - `GET /healthz`.
  - **Auth:** every endpoint except `/healthz` needs `Authorization: Bearer <token>`, and a token can only push or read its own repo.
  - **Logs:** one line per request with method, path and status. Never headers, query strings or bodies.
  - **Storage:** `PostgresSummaryStore` passes the same contract tests as the in-memory store.
    - It uses real Postgres through `pg` when `DATABASE_URL` is set, otherwise PGlite (in-process Postgres) in a `--data` directory.
    - Tests and CI use PGlite, so they need no database service. An opt-in test runs the contract against real Postgres (`DIGEST_TEST_DATABASE_URL`).
    - Numbered migrations run on start, one transaction each.
    - Pushes use `insert … on conflict do nothing`, so two concurrent pushes of a session can't both win.
  - **Tokens:** `digest-server token --repo --developer --name` issues one. It prints the token once and stores only a sha256 of it; issuing again revokes the old one. Token issuing is a server-side admin command, not an HTTP endpoint.
  - **Client:**
    - `share.url` in `.digest/config.json` points at the server.
    - The token comes from `DIGEST_TOKEN` or `.digest/token`, both gitignored, and is never printed.
    - The client maps HTTP answers back to push outcomes.
- **Alternatives:** A web framework (Fastify or Hono) for four routes; an HTTP endpoint for issuing tokens, which adds an admin-auth surface Phase 5 doesn't need; SQLite.
- **Why:** Postgres was chosen in D39. PGlite gives the real Postgres dialect in tests and local runs with nothing to install. Keeping token issuing off the network means no admin endpoint exists to attack.
- **Verified (2026-10-29):** the opt-in real-Postgres test passed 14/14 contract tests against a throwaway `postgres:16` Docker container (mapped to port 5433, because 5432 was already taken). Steps are in [docs/development.md](docs/development.md).
- **Not yet:** read-only stakeholder tokens and roles (Phase 7 and Phase 10), retraction (the `retracted_at` column is already there), TLS (put the server behind a reverse proxy), and Docker Compose (Phase 10). With PGlite, one process holds the data directory, so stop the server before issuing tokens.

## D44. Ticket keys are found on the developer's machine, with where each came from

- **Date:** 2026-10-30
- **Decision:**
  - **Config:** `tickets.pattern` and `tickets.keys` in `.digest/config.json`.
    - The pattern defaults to keys like PROJ-142. A custom one must compile, be at most 100 characters and never match empty text, or the config is rejected with a clear error.
    - With `keys` set, a match counts only when the text before its first `-` is one of the keys.
  - **Sources:**
    - Branch names always count.
    - Commit messages of the session's commits count only when `keys` is set. Without the list they match UTF-8, SHA-256 and GPT-4.
    - Messages are read locally with `git show`, and only the keys found in them are kept. The text is never stored or sent.
  - **Recording the source:**
    - Each summary records `ticketSources` (`branch`, `commit` or `manual`) for the keys in `ticketRefs`.
    - Keys a developer adds while editing in review are `manual`.
    - `digest summarize` re-applies the config to every unreviewed draft, including cached ones.
  - **Upload:**
    - `ticketSources` travels in the upload payload, strictly typed: every key in it must be in `ticketRefs`.
    - It is outside the approval hash, so approvals made before Phase 6 stay valid.
    - Payloads without it, from older clients, still validate.
- **Alternatives:**
  - Extract keys on the server (it never sees commits).
  - Include `ticketSources` in the approval hash, which would void every earlier approval.
  - Count commit-message keys without a project list.
- **Why:**
  - The developer sees and approves the keys before anything is shared.
  - Commit text stays local, in line with D40's no-raw-content rule.

## D45. Ticket links, sprints and tracker data are separate server-side records

- **Date:** 2026-10-30
- **Decision:**
  - **Pushed summaries never change.** Three kinds of changeable records sit next to them, joined in only when grouping: manual ticket links, sprints, and tracker tickets.
  - **Manual links:**
    - Each link records who added it and when.
    - Only the developer who pushed the summary can add or remove its manual links.
    - Removing one deletes only that record. A key inside the summary can't be removed (409).
    - Adding a key the summary already has is a no-op.
    - Keys must be a single word of at most 100 characters and pass the secret detectors.
    - `POST`/`DELETE /v1/ticket-links` carry the session and ticket in the body, so the logged path never contains them.
    - Ticket queries (`list`) include manual links.
    - Command: `digest link` and `digest unlink`.
  - **Sprints:**
    - Named `[from, to)` ranges per repo, kept with `digest-server sprint` (an admin command, like `token`).
    - Dates are UTC days or ISO date-times.
    - Saving with an existing name replaces that sprint. Overlapping sprints are refused, so every date falls in at most one.
  - **Tracker tickets:** title and sprint name per key, replaced on each refresh (D47).
  - **Postgres:** migration 2 adds `ticket_links` (with a foreign key to `summaries`), `sprints` and `tracker_tickets`. The same `TicketStore` contract runs on the in-memory store, on PGlite and on the opt-in real Postgres.
  - **Atomic overlap check (2026-10-30):**
    - Migration 3 adds `exclude using gist (repo_id with =, name with <>, tstzrange(starts_at, ends_at) with &&)`, so two concurrent saves of overlapping sprints can't both win. The loser gets the usual "overlaps" answer.
    - It needs the `btree_gist` extension. That ships with Postgres and is allowed on the common managed services; PGlite loads it from `@electric-sql/pglite/contrib`.
    - The in-memory store was already atomic.
    - A contract test runs two overlapping saves at once on every store.
- **Alternatives:**
  - Bake sprint or title into the summary at push time; it goes stale.
  - Allow overlapping sprints and pick one.
  - Put the ticket in the URL path; it would land in the logs.
- **Why:**
  - Pushed summaries stay what the developer approved.
  - Sprint membership and titles change after the fact.
- **Verified (2026-10-30):** the opt-in real-Postgres test passed 23/23 contract tests (14 SummaryStore, 9 TicketStore) against a throwaway `postgres:16` Docker container on port 5433. After migration 3 it passed 25/25, with the 2 new sprint tests.
- **Not yet:** manual-link history isn't kept (Phase 10's audit log).

## D46. Grouping: tracker sprint first, then the sprint containing the session's start

- **Date:** 2026-10-30
- **Decision:**
  - **Sprint of a link:**
    - If the tracker knows the ticket, use the tracker's sprint. Its "no sprint" means No sprint.
    - Otherwise, use the dated sprint containing the session's start. A session crossing a boundary lands in exactly one sprint.
    - An unlinked summary goes by its start date.
  - **Summaries with several tickets** appear under each ticket, possibly in different sprints. Each entry carries its `TicketLink`: source, plus author and time for manual links.
  - **Summaries pushed before Phase 6** have no sources:
    - A key found in the branch name counts as `branch`; any other counts as `manual`.
    - Keys added during review are attributed to the pusher at the approval time.
  - **`GET /v1/tickets`** takes either `from` and `to`, or `sprint`.
    - A range selects summaries with the usual overlap rule (D40), then groups them. So a range inside Sprint 2 can show the boundary session under Sprint 1.
    - A sprint name returns only that sprint's group.
  - **Order:** dated sprints by start, then tracker-only sprints by name, then No sprint. Tickets are in natural key order.
  - **Each report** includes summary and developer counts.
  - **`digest tickets`** prints the same view.
- **Alternatives:**
  - The date rule always.
  - Assigning by end date, or by most of the session's time.
  - Selecting a date range by start date only.
- **Why:** chosen by the project owner. A ticket's sprint in the tracker is what a PO plans by, and dates are the fallback that works without a tracker.

## D47. Issue trackers behind an interface; a fake for now

- **Date:** 2026-10-30
- **Decision:**
  - **Interface:** `Tracker.lookup(keys)` returns the tickets a tracker knows (title, current sprint name), leaving unknown keys out.
  - **Refresh:** `refreshTracker` asks in batches of 100 about every key in the repo's summaries and manual links, and stores the answers as tracker tickets.
  - **Phase 6** ships the interface and `FakeTracker`, so every grouping rule is tested without network calls.
  - **Credentials** for real clients will live only in the server's environment.
- **Alternatives:**
  - Build the Jira and Linear clients now, against recorded responses.
  - Look tickets up at query time instead of storing them.
- **Why:**
  - There is no sandbox yet, so real clients come in a later phase.
  - The brief's placeholder for a sandbox key was left unfilled, so nothing reads one.
  - Stored records keep reports fast and working while a tracker is down.
- **Not yet:**
  - Real clients.
  - A `digest-server` command that runs `refreshTracker`.
  - Removing tickets a tracker no longer knows.
  - Tracker sprint dates; tracker-only sprints have none.

## D48. Digests use Claude Sonnet 5.5 by default

- **Date:** 2026-10-30
- **Decision:**
  - Digests and reports are written with `claude-sonnet-5-5` at `medium` effort.
  - Configuration:
    - Server: `DIGEST_MODEL` and `DIGEST_EFFORT`.
    - `digest report`: `report.model` and `report.effort` in `.digest/config.json`.
  - **Price** (confirmed against the live pricing page on 2026-10-30): $2 per million input tokens and $10 per million output tokens, flat across the 1M-token context. The price table already had this.
  - A digest is one call. The estimate errs high, using D22's margins: input × 1.6 and 3,000 output tokens.
- **Alternatives:** Haiku 5.5, like the summariser; Opus 5.5.
- **Why:**
  - A digest is one call per period, read by non-technical people, and its quality matters more than its cost: about $0.05–$0.10 per sprint.
  - Summaries stay on Haiku because there are many of them.

## D49. Digest input: the shared narrative, with its own provenance

- **Date:** 2026-10-30
- **Decision:**
  - **What it holds:** `digestInput(report)` turns a ticket report into a frozen, branded `DigestInput`. It keeps goal, outcome, what was done, decisions, rejected approaches, follow-ups and AI involvement, grouped by ticket with titles, plus the unlinked work.
  - **What it leaves out:** who did the work, session ids and file paths.
  - **AI involvement per ticket** is the most common level among its work, the higher one on a tie.
  - **Provenance:** LLM requests now accept a `RedactedSession` or a `DigestInput`, still hard-checked by every client (D16, D23). Nothing else can reach a model.
  - **Hash:** the input's sha256 is the summary-set part of the report cache key.
- **Why:**
  - "No judgement of individual developers" (plan section 6.2) is enforced by never sending names.
  - The provenance check keeps raw data from reaching a model through the new path.

## D50. Digest generation: structured output, rendered here, checked twice

- **Date:** 2026-10-30
- **Decision:**
  - **Prompt:** the 6.2 prompt verbatim (`digest-v1`) with a structured-output schema: overview, one section per ticket (achieved, AI involvement in plain words, key decisions), other work, and risks and open questions.
  - **Rendering:** this code renders the Markdown. Ticket titles and AI involvement levels come from the input, not the model.
  - **Coverage line:** "Based on N summaries that M developers chose to share."
    - It counts approved, pushed summaries only. The server never learns about unreviewed drafts; this is the coverage decision the plan asked for.
  - **Post-check:**
    - Exactly the input's tickets, one section each.
    - No other ticket key with one of the input's project prefixes, so "UTF-8" passes.
    - No code or code formatting.
    - No "other work" when there was none.
    - A failure gets one retry with the errors, then the digest is refused.
  - **Secret detectors:** they run on every field and on the final Markdown. A match blocks the digest outright, with no retry. Every store and every delivery runs the same check again.
  - **Empty periods:** an empty period writes itself without a model call.
- **Alternatives:** let the model write Markdown and check it afterwards; retry after a secret match.
- **Why:**
  - Rendering ourselves makes the checks exact and the format stable.
  - A secret in a digest is never worth a second try.

## D51. Reader tokens for stakeholders

- **Date:** 2026-10-30
- **Decision:**
  - `digest-server token --reader <id> --name` issues a read-only token. Tokens are unique per person, role and repo (migration 4), so a person can hold both kinds.
  - **Readers can:** request reports (`POST /v1/reports`), and list and read digests (`GET /v1/digests`, `/v1/digests/<id>`).
  - **Readers get 403 on:** every per-session endpoint (`/v1/summaries`, `/v1/team-report`, `/v1/tickets`), because those carry developer identity; pushes; and ticket links.
  - **Previews:** readers never see digests in developer preview.
- **Alternatives:** wait for Phase 10's full roles.
- **Why:** managers need reports now and must not see who did what. Phase 10 adds roles and audit on top.

## D52. Stored digests, report cache, spend and repo settings

- **Date:** 2026-10-30
- **Decision:**
  - **Contract:** a `DigestStore` contract with in-memory and Postgres implementations (migration 5). It covers:
    - `digests` (kind `report` or `scheduled`; status `ready`, `preview` or `sent`; deliveries per channel);
    - `llm_spend`;
    - `repo_settings`.
  - **Uniqueness:** partial unique indexes keep one cached report per (period, input hash, prompt version, model), and one scheduled digest per period.
  - **Repo settings:** schedule, weekday, developer preview hours, email recipients, the *name* of the environment variable holding the Slack webhook (the URL is a secret and stays out of the database), the monthly cap, and when the schedule started.
- **Why:**
  - Caching makes a repeated report free.
  - One digest per period makes send-due safe to repeat.

## D53. On-demand reports on the server, under a monthly cost cap

- **Date:** 2026-10-30
- **Decision:**
  - **Server path (primary):** `POST /v1/reports` takes a sprint or date range from a reader or developer token, and serves the cached report or writes one.
  - **Cost cap:**
    - Before any model call, the estimate plus this calendar month's spend (UTC) must fit under the repo's cap.
    - The cap is the repo's own, or the server's `DIGEST_MONTHLY_CAP_USD` (default $10).
    - If not, the server answers 429 with a clear message.
    - Every call's cost is recorded, including attempts that failed their checks.
  - **No API key:** the server serves cached reports only (503 for new ones).
  - **Local path:** `digest report` writes locally with the caller's own key.
    - It shows the estimate first and asks, or needs `--yes`.
    - It caches in `.digest/cache/reports`.
    - It writes to stdout or to `--out` inside the repo, never creating directories.
- **Alternatives:** CLI only (managers don't use it); no cap until Phase 10.
- **Why:** you chose the server path as primary, and a cap now keeps an open report endpoint from running up a bill.

## D54. Scheduled digests: `send-due` by cron, with an optional view-only preview

- **Date:** 2026-10-30
- **Decision:**
  - `digest-server digest send-due` is run by cron, for example `0 7 * * *`. It is idempotent.
  - **What's due:**
    - Weekly: the 7 days before the chosen weekday.
    - Sprint-end: each sprint that has ended.
    - Never a period that ended before the schedule was turned on (`--since` can backdate it).
  - **Per due period:**
    - Write the digest once, after the cost-cap check.
    - If the repo has a preview window (`--preview-hours`, off by default), hold the digest there. Developers can read it with `digest preview`; they can't edit or stop it.
    - Then deliver it, retrying only the channels that failed. It is marked sent once every channel has it.
  - **Exit code:** 1 when anything due wasn't sent, so cron can alert.
  - **Settings:** `digest-server repo` shows and changes the repo's digest settings.
- **Alternatives:** a timer inside the server process; a preview that can hold a digest back.
- **Why:**
  - Cron and an idempotent command are easy to test and can't miss a digest after a restart.
  - The view-only preview was chosen to keep the flow simple.

## D55. Delivery: Slack incoming webhook and SMTP

- **Date:** 2026-10-30
- **Decision:**
  - **Interface:** a `Delivery` interface with two implementations.
  - **Slack:**
    - Posts mrkdwn to an incoming webhook: headings and bold become `*bold*`, `&`, `<` and `>` are escaped, and text past 39,000 characters is cut short with a note.
    - The webhook URL comes from a server environment variable that the repo settings name.
  - **Email:**
    - Sent over SMTP (`SMTP_URL`, `DIGEST_EMAIL_FROM`), which works with Resend, Postmark or a self-hosted server.
    - Markdown is rendered to HTML with `marked` (raw HTML escaped), plus a plain-text part.
    - Tested locally against Mailpit (an opt-in test).
  - **Errors:** never include webhook URLs or SMTP credentials.
  - **New dependencies** (each at least two weeks old): `marked` 18.1.1 and `nodemailer` 10.1.1.
- **Alternatives:** provider APIs (Resend, Postmark) directly; Slack Block Kit.
- **Why:**
  - SMTP covers every provider and self-hosting with one code path.
  - Plain mrkdwn is enough for a text digest.

## D56. An opt-in judge eval for digest faithfulness

- **Date:** 2026-10-30
- **Decision:**
  - **Judge:** `judgeDigest` asks a model (Sonnet 5.5 by default, `DIGEST_JUDGE_MODEL`) to list every factual claim in a digest and say whether the input summaries support it.
  - **Golden fixture:** a synthetic sprint of four summaries (`packages/core/test/digest/golden-sprint.json`). Its digest has three planted unsupported claims (a production release, a pen test, "40% faster") and three supported ones.
  - **The eval** (`DIGEST_EVAL=1`):
    - It requires the judge to flag every planted claim and none of the supported ones.
    - It then writes a fresh digest from the fixture, judges it, and reports to `.digest/eval/`.
- **Why:**
  - The deterministic checks (D50) can't see invented outcomes; a reader can.
  - Keeping it opt-in keeps CI free of API calls and cost.

## D57. Phase 7's "Done when" is met with a single-developer dogfood sprint first

- **Date:** 2026-10-30
- **Decision:**
  - There is no team repo yet, so the first real test of the digest uses this repo (`logs`). There is one developer, and the sprint covers the days the project was built (Sprint 1, 2026-10-28 up to 2026-10-31).
  - The developer reviews, edits, tags and approves the summaries themselves before anything is pushed. The digest is then shown to a non-technical reader using `docs/po-feedback-checklist.md`.
- **Limits:**
  - A single developer can't show coverage across people.
  - The repo has only one Claude Code session (the long build session), so ticket sections draw on one summary.
- **Still outstanding:** a real test with several developers on a team repo, over a normal sprint. Until then, the "Done when" counts as met for one developer only.

## D58. `digest summarize --by-period`: one summary per work period, as a flag

- **Date:** 2026-10-30
- **Decision:**
  - **Splitting:** with `--by-period`, a session is cut into its work periods at the summariser's 6-hour gap (D28).
  - **Each period is summarised as a session of its own,** with:
    - the id `<session id>.p<n>` (shown as `fe5d7843.p2`), which ties it back to the session;
    - its own start and end (the first period keeps the session's start), turns, tool calls, files, and the commits made in its own time window;
    - the subagents its Task calls name;
    - its own draft, review, approval and push.
  - **Sprints:** a session that crosses a sprint boundary has each period counted in the sprint it happened in (tested).
  - **State:** `.digest/state.json` still tracks the whole session.
- **It's a flag, not the default.** Whether to make it the default will be decided after the developer's own review of the dogfood sprint (D57).
- **Alternatives:**
  - One summary tagged with every ticket, which repeats one story under each ticket.
  - One umbrella ticket.
- **Limits:**
  - `gitBranches` is the session's, not each period's.
  - A subagent with no matching Task call goes to the first period.
  - A session already summarised whole and then by period has both drafts. Reject the one you don't want.

## D59. The CLI is `sprintdigest`, the server `sprintdigest-server`

- **Date:** 2026-10-30
- **Decision:**
  - The binaries are renamed from `digest` and `digest-server` to `sprintdigest` and `sprintdigest-server`. This covers the `bin` entries, the CLI's name, every message that names a command, and the README and docs.
  - **What stays:**
    - the `.digest/` folder, so existing state, summaries and tokens keep working;
    - the `DIGEST_*` environment variables;
    - the internal `@digest/*` package names;
    - the server's `digest send-due` subcommand;
    - the pre-push hook's marker line, so `init` still recognises hooks installed earlier.
  - Earlier entries in this log keep the old names, as history.
- **Why:** `digest` collides with NSS's `digest` tool, which Homebrew's `nss` formula and conda install. It shadowed ours ("NSS_Init failed").
  - On 2026-10-30, `sprintdigest` was free everywhere checked:
    - `command -v` on this machine, including conda's paths;
    - npm, Homebrew formulae and casks, conda-forge, PyPI and crates.io;
    - Debian (no package, and no package shipping a `bin/sprintdigest`);
    - GitHub repo names.
  - These registry checks see package names, not every binary a package ships; that's exactly how `digest` slipped through.
- **Alternatives:** `agentdigest` (one GitHub repo uses it), `sprintlog` (31 repos; reads as plain logging).

## D60. Developers can retract their own pushed summaries (moved forward from Phase 10)

- **Date:** 2026-10-30
- **Decision:**
  - **Command:** `sprintdigest retract <id>` calls `POST /v1/retractions`.
    - Developer tokens only, and only the developer who pushed the summary: anyone else gets 403.
    - Retracting twice answers "already".
  - **On the server:**
    - The summary row is kept and marked `retracted_at`. A `retractions` table keeps the history: who, when, and the payload hash.
    - Retracted summaries leave every list, ticket view, team report and digest input, so readers never see them.
    - Stored digests record the summaries they were written from (`summary_keys`, migration 6). On retraction:
      - cached reports and unsent scheduled digests that included it are deleted, so the next request writes them again;
      - digests already sent are kept but marked `withdrawn`, which hides them from readers.
  - **Locally:** the summary goes back to draft (approval and `pushedAt` cleared), so it can be edited, re-summarised by id, approved and pushed again.
  - **Re-pushing:** a new push of a retracted session from the same developer replaces the stored summary. Another developer's push is still a conflict.
- **Why:** pushed summaries are immutable (D40), so a stale or wrong one needs a way out that its author controls. The first real review needed it.
- **Not yet:** deleting retracted content entirely (Phase 10's delete-my-data).

## D61. Review warnings: missing tickets, and sessions that look active

- **Date:** 2026-10-30
- **Decision:**
  - **Missing tickets:** approving a summary with no ticket keys asks "No tickets tagged. Approve anyway? [y/N]". This happens in `sprintdigest approve` and in the interactive review.
    - It asks only when the repo uses tickets: `.digest/config.json` has a tickets pattern or project keys, or the shared store has sprints (`GET /v1/sprints`, new). An unreachable store counts as no.
    - Without a terminal, `approve` needs `--yes`. Answering no in review stays on the summary, so it can be edited.
  - **Active sessions:** `sprintdigest summarize` warns for each session or period whose last activity is under `summarize.activeWarningHours` ago (default 2, 0 turns it off): "the session looks active and its follow-ups may go stale". It warns but doesn't block.
- **Why:** the first real review pushed three summaries without tickets, and one summarised mid-session with follow-ups that were already done.

## D62. Files touched: transcript edits plus the files the commits changed

- **Date:** 2026-10-30
- **Decision:**
  - A session's or period's `filesTouched` is now the union of two sources: the files its transcript shows edited, and the files changed by the commits made in its time window, kept to repo-relative paths (D29).
  - Before, commits were used only when the transcript showed no files at all.
- **Why:**
  - The parsers see only edit tools (Edit, Write, apply_patch), and much real editing happens through shell commands.
  - In `fe5d7843.p2`, which built Phases 4 and 5, only 3 files came from edit tools, while its 35 commits changed 85.
  - The period split didn't lose files; the transcript never had them. Whole-session summaries had the same gap.
- **Effect:** summaries made before this fix keep their old lists; re-summarise them to pick up the full one.

## D63. Slack digests use Block Kit, with a plain-text fallback

- **Date:** 2026-10-30
- **Decision:**
  - **Blocks:**
    - The title becomes a header block.
    - Each ticket and section becomes a divider, then a header.
    - Paragraphs and lists become mrkdwn sections, split under 3,000 characters.
    - The coverage line becomes a context block.
    - Headers are cut to 150 characters.
  - **Fallback:** the message's `text` (the title and the overview, escaped) is what notifications show.
  - **Limit:** past Slack's 50 blocks, the message falls back to D55's text-only mrkdwn.
- **Why:** in mrkdwn, section titles and bold lead-ins looked the same, and the sections ran together.

## D64. A large turn is summarised on its own; one period can be re-summarised by id

- **Date:** 2026-10-31
- **Finding:** `fe5d7843.p3`'s summary left out the whole Phase 7 build: digest writing, delivery, reader tokens, scheduling and the cost cap. The usage log shows where:
  - The merge and the 6-item cap weren't the cause. No part's output mentioned the work, so the merge had nothing to pick.
  - The work was in chunk 2. That 13K-token chunk joined the 7K-token Phase 7 turn (one request, 82 tool lines, 38 lines of assistant text) with three later, smaller requests: the judge eval, `--by-period` and a fix.
  - That part's output described only the later requests. This is the recency bias of D28 and D31, inside a single chunk.
- **Decision:**
  - **Chunking:** a turn of 40% or more of the chunk budget now gets a chunk of its own, so it becomes its own part. The merge's per-part pick (D32) then keeps it. `CHUNKING_VERSION` is in the content hash, so summaries made under the old rule are regenerated. On the real p3, the Phase 7 turn is now chunk 4 of 6, alone.
  - **One period:** `sprintdigest summarize <id>.p<n>` summarises just that work period.
  - **`--discard-edits`:** replaces an edited draft, which D37 otherwise protects. Approved summaries are never replaced.
- **Not yet verified live:** that the re-summarised p3 now covers Phase 7. Check it in review.

## D65. The digest resolves stale follow-ups itself (digest-v2)

- **Date:** 2026-10-31
- **Decision:**
  - **Input:** the digest model now gets one timeline of all work, oldest first (W1, W2, …), each item with its dates and tickets. Tickets point to their work items instead of repeating them.
  - **Prompt rules (digest-v2):**
    - A risk or follow-up that later work shows as done, fixed or decided is left out.
    - Each ticket, and the overview, describe the state at the end of the period.
    - "Risks and open questions" holds only what a non-technical product owner could act on or should know: delivery or scope at risk, quality problems people could notice, cost, and decisions they need to make. Developer housekeeping and notes about how the work was recorded, reviewed or shared stay out.
  - **Judge:** it now reports `resolvedStillListed`: items in the digest that later work resolved.
  - **Golden fixture:** a new one (`golden-resolved.json`) holds early follow-ups resolved later, a housekeeping item, a process note, and two open items a PO should see. The opt-in eval requires the judge to catch a planted resolved item, and requires a fresh digest to list none and to keep both open items.
- **Why:** the first real Sprint 1 digest listed about 10 of 14 risks that were already resolved or internal. A real team won't clean follow-ups by hand every sprint, so the digest has to.
- **Not yet verified live:** the eval is opt-in and costs money.

## D66. Tickets that share exactly the same work get one section

- **Date:** 2026-10-31
- **Decision:**
  - **Grouping:** `digestInput` groups tickets whose sets of summaries are identical. This is deterministic, in key order, and the first key leads.
  - **The model:** it sees one line per group ("Ticket LOGS-4: Developer review, LOGS-5: Shared team store: W2") and writes one section for it. Any key of the group may name that section; a second section for the same group is refused and retried.
  - **Rendering:** the heading combines the group ("## LOGS-4: Developer review · LOGS-5: Shared team store"), and the content isn't repeated.
  - **Partial overlap:** a ticket whose work only overlaps a group's stays separate.
- **Why:** per-period summaries tagged with several tickets repeated the same text and decisions two or three times (Sprint 1: three pairs). That's how the digest reached 128 lines.

## D67. Ticket titles without a tracker

- **Date:** 2026-10-31
- **Decision:**
  - **Command:** `sprintdigest ticket title <KEY> "<title>"` calls `PUT /v1/ticket-titles`.
    - Developer tokens only.
    - Keys must be a single safe word. Titles must be 1–200 characters and pass the secret detectors.
  - **Storage:** the server keeps one title per key per repo, with who set it and when, in a `ticket_titles` table (migration 7).
  - **Use:** reports, `sprintdigest tickets` and digests use the tracker's title when there is one, and this title otherwise. Headings read "LOGS-1: Session parsing".
- **Why:** with no tracker connected, the Sprint 1 digest's headings were bare keys a reader couldn't place.

## D68. Jargon: a prompt rule, a deterministic check with one retry, and the judge

- **Date:** 2026-10-31
- **Decision:**
  - **Prompt rule:** "Write for someone who has never written software: explain a technical term in a few plain words, or avoid it." It is followed by the list of words to avoid or explain.
  - **Deterministic check:**
    - Every field of the reply is checked against a term list, as whole words in any case (plurals and verb endings too, so "commit" doesn't match "commitment").
    - The built-in list starts from the terms in the first Sprint 1 digest (pnpm, package manager, schema, prompt, chunk, commit, hook, pre-push, end-to-end test, work period) plus common developer words.
    - The server's `DIGEST_JARGON` (comma-separated) replaces it, and so does `report.jargon` in `.digest/config.json` for `sprintdigest report`.
    - A hit causes one retry that names the terms. If the second reply still uses them, it is kept, with a warning recorded on the digest (`warnings: ["jargon: schema"]`), not refused.
  - **Judge:** the eval judge reports unexplained jargon, and the golden fixture has a planted term ("payload") it must catch.
- **Alternative:** refuse a digest that still has jargon after the retry. That's too strict: one unavoidable word would block a whole sprint update.

## D69. One AI involvement level for every ticket is said once

- **Date:** 2026-10-31
- **Decision:**
  - When every ticket section (two or more) has the same AI involvement level, it is stated once, right after the overview, in fixed plain words for that level: "**AI involvement: heavy for every ticket.** AI wrote most of the changes."
  - Each section then leaves the line out.
  - Mixed levels keep a line per section, with the model's sentence.
  - The wording follows the summariser's own definitions (light, moderate, heavy).
- **Why:** in the Sprint 1 digest every section said "AI involvement: heavy", which told the reader nothing new seven times.
