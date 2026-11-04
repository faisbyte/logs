# sprintdigest: AI Sprint Digest

**Turn the AI coding sessions a team already records into plain-language sprint updates for stakeholders, and into a short, curated memory for the team's AI agents.**

Built by Faisal Naveed · October to November 2026 · TypeScript · [github.com/faisbyte/logs](https://github.com/faisbyte/logs)

---

## At a glance

| | |
|---|---|
| What it is | A CLI (`sprintdigest`) and a small server (`sprintdigest-server`) that read Claude Code and Codex CLI session files and turn them into ticket-level digests and shared team context |
| Who it's for | Product owners, scrum masters and managers, who get readable updates, and developers and their AI agents, who get a short brief of past decisions and pitfalls |
| Core promise | Developers approve every summary before it's shared. Secrets are redacted before anything leaves the machine. Raw transcripts never leave the machine. |
| Scope built | 8 of the plan's 11 phases: parsing, redaction, summarisation, review, shared store, ticket linking, stakeholder digests, context distillation |
| Size | ~8,300 lines of TypeScript source and ~9,200 lines of tests in 3 packages |
| Tests | 958 passing, plus 58 opt-in live tests that call real models or a real database |
| History | 159 commits over 5 days, every one green, with CI on GitHub Actions |
| Decisions | 85 architectural decisions logged with alternatives and reasons ([DECISIONS.md](../DECISIONS.md)) |
| Dogfooded | Run on its own build sessions: the first real sprint digest was about the sprint that built it |

---

## 1. The problem

When several developers use AI coding agents (Claude Code, Codex and others) on one shared repository, two things go missing.

1. **Stakeholders can't see the AI work.** Managers, product owners and scrum masters have no readable picture of what the AI was used for, at the level they think in: tickets and sprints. Usage dashboards report tokens and seats, not "what happened on PROJ-142 and why".
2. **Every agent starts from zero.** Each developer's agent has no idea what teammates' agents already did, decided or tried and rejected. So the same dead ends get explored again, by different people, in different sessions.

The information needed to fix both already exists. Every Claude Code and Codex session is written to disk on the developer's machine (`~/.claude/projects`, `~/.codex/sessions`). But it's raw: long, noisy, full of tool output, sometimes containing secrets, and never meant for anyone else to read.

## 2. What already exists, and the gap

| Tool | What it does | Why it doesn't close the gap |
|---|---|---|
| Entire | Captures sessions through git hooks, with AI summaries per checkpoint | Developer-facing; not written for stakeholders |
| SpecStory | Saves sessions as Markdown, with a "Lore" feature | An archive, not a curated log |
| Rekal, TeamBrain, ContextPool, context-commit | Share agent memory through git | Share memory, not narrative digests |
| Agent Trace | An open spec for AI code attribution | Line-level attribution, not a story |
| Claude Code analytics, Jellyfish, DX, LinearB | Usage and productivity metrics | Metadata, not narrative |

**The gap sprintdigest targets:**
- **Narrative digests at the ticket and sprint level, for non-technical readers.** For example: "PROJ-142: the auth refactor was mostly agent-written; approach X was rejected because Y; open risk: Z."
- **Distilled, not dumped, shared context.** A short, curated list of decisions, conventions and pitfalls per repo, which agents can read before they start work.

## 3. Design principles (non-negotiable from day one)

1. **Automatic capture, never manual export.** It reads the agents' own local session files, with no copy and paste and no uploads.
2. **The developer approves before anything is shared.** Every summary is reviewed, can be edited or rejected, and only then pushed. This is what keeps the tool from feeling like surveillance.
3. **Secrets are redacted before anything leaves the machine,** and redaction can't be skipped by mistake (it's enforced by the type system).
4. **Share summaries, not transcripts.** Raw sessions stay local.
5. **Distilled over dumped.** Context given to agents is short and curated, never a growing raw log.
6. **No judgement of individual developers.** Digests report on tickets and work, not on people.

---

## 4. How it works, end to end

```mermaid
flowchart LR
  subgraph Dev["Developer machine"]
    A["Claude Code / Codex<br/>session files"] --> B["Parse +<br/>normalise"]
    B --> C["Redact secrets<br/>+ PII"]
    C --> D["Summarise<br/>(Claude Haiku)"]
    D --> E["Review: approve,<br/>edit, reject"]
  end
  E -- "approved summaries only" --> F
  subgraph Server["sprintdigest-server"]
    F["Shared store<br/>(Postgres)"] --> G["Group by sprint<br/>+ ticket"]
    G --> H["Stakeholder digest<br/>(Claude Sonnet)"]
    H --> I["Slack + email"]
    F --> J["Context distillation<br/>(cron)"]
    J --> K["Context items:<br/>decisions, conventions,<br/>pitfalls"]
  end
  K --> L["sprintdigest context<br/>path | ticket"]
  K --> M["AGENTS.md section<br/>as a pull request"]
```

### Step by step

| # | Step | Where | Command |
|---|---|---|---|
| 1 | **Discover** the repo's Claude Code and Codex sessions | Laptop | `sprintdigest list` |
| 2 | **Parse** them into one common schema: turns, tools, files, commits, branch | Laptop | |
| 3 | **Redact** secrets and PII | Laptop | `sprintdigest redact <id>` shows counts, never values |
| 4 | **Summarise** each session into a structured draft with an LLM, after a cost estimate | Laptop, with the developer's own API key | `sprintdigest summarize` |
| 5 | **Review**: approve, edit in `$EDITOR`, or reject | Laptop | `sprintdigest review` |
| 6 | **Push** approved summaries (shared fields only) to the team server | Laptop to server | `sprintdigest push` (or `sync` for steps 4–6) |
| 7 | **Link tickets** from branch names and commit messages, plus manual links | Both | `sprintdigest link`, `tickets` |
| 8 | **Write the digest** for a sprint, in plain language | Server, under a cost cap | `sprintdigest report`, or scheduled |
| 9 | **Deliver** it by Slack (Block Kit) and email, after an optional developer preview | Server, by cron | `sprintdigest-server digest send-due` |
| 10 | **Distil** approved summaries into context items | Server, by cron | `sprintdigest-server context distill` |
| 11 | **Brief** an agent before it starts: about 300 words for a path or ticket | Laptop, works offline | `sprintdigest context src/auth` |
| 12 | **Propose** the notes as a marked `AGENTS.md` section, in a PR | Laptop, via `gh` | `sprintdigest context propose` |

---

## 5. Architecture

```mermaid
flowchart TB
  subgraph core["packages/core (shared library)"]
    parsers["Parsers<br/>Claude Code · Codex"]
    redact["Redactor<br/>detectors · entropy · PII"]
    summ["Summariser<br/>condense · chunk · merge"]
    review["Review + approval<br/>branded ApprovedSummary"]
    shared["Shared-store contract<br/>payload · tickets · digests · context"]
    digest["Digest writer + checks + judge"]
    context["Context extraction · brief · AGENTS.md"]
  end
  cli["packages/cli<br/>sprintdigest"] --> core
  server["packages/server<br/>sprintdigest-server<br/>node:http · Postgres/PGlite<br/>cron jobs · Slack · SMTP"] --> core
```

- **Monorepo:** pnpm workspaces. Plain `tsc -b` with ESM, no bundler. zod validates every schema, including every LLM reply.
- **One store contract, three implementations:** in-memory (for tests and as the reference), PGlite (in-process Postgres, for local runs and CI), and real Postgres. All three pass the same contract test suite.
- **Server:** `node:http` with no framework. Numbered migrations (11 so far). Every endpoint except the health check needs a bearer token, and tokens are stored only as hashes. Logs are one line per request (method, path, status), never headers or bodies.
- **Two token roles:**
  - **developer** tokens can push, link, retract and read context;
  - **reader** tokens (for a PO or scrum master) can read digests and reports only, and get 403 on anything with per-session or per-developer detail.
- **The LLM sits behind an interface** with a fake for tests. Every request must carry proof of where its data came from (more in §6.1).

---

## 6. Engineering highlights

### 6.1 Privacy and safety by construction

- **Redaction that can't be skipped:**
  - `redactSession()` is the only way to get a `RedactedSession`. It's a class with a private brand field, exported as a type only, and deep-frozen.
  - The compiler rejects raw sessions, look-alike objects and spread copies. A runtime check catches forced casts.
  - Every LLM client refuses a request whose source isn't a `RedactedSession`, a `DigestInput` or a `ContextInput`.
  - Tests compile misuse snippets with the real `tsc` and pin the exact errors.
- **Approval that can't be faked:**
  - `ApprovedSummary` uses the same pattern.
  - `approve()` records who approved it, when, and a sha256 of the shared fields.
  - The upload gate re-checks the brand and the hash, so a hand-edited JSON file doesn't get through.
- **Redaction that fails closed:**
  - If a detector throws, the whole string becomes `[REDACTED:unscannable]`.
  - Every regex is bounded, and pathological 200 KB–1 MB inputs finish within a 1.5 s budget. Two real patterns used to take over 10 s and now take under 15 ms.
- **Detectors:**
  - known key formats (AWS, GitHub, Anthropic, OpenAI, JWTs, private keys, connection strings);
  - `.env`-style secret-named keys;
  - emails and phone numbers;
  - the home directory and username, which become `~`;
  - allow and deny lists;
  - a structure-aware entropy detector. It was calibrated on the developer's 15 real sessions, where false hits fell from 121 to about 21, and on 20,000 random tokens per length.
- **Defence in depth on the server:**
  - every push is validated again against the shared schema;
  - pushes are scanned for transcript markers and secrets;
  - every stored digest and every delivery runs the secret check once more;
  - a digest with a secret is blocked outright, never retried.
- **Prompt-injection defence for context items:**
  - Items an agent will read must be statements of fact with reasons, never commands.
  - Code refuses items containing shell commands, URLs, instructions ("ignore previous instructions", "you should…", imperative openings), credential handling, or tool permissions.
  - The model gets one retry naming the problems. The store checks again before keeping anything.

### 6.2 Summarising long AI sessions faithfully

Real sessions are long, run over several days, and end up very different from where they started. Each fix below came from a measured failure on real sessions:

| Problem found | Fix |
|---|---|
| Multi-day sessions were summarised as if only the last day happened | Split at **6-hour idle gaps into work periods**. Every period becomes its own part, and the merge must cover all of them. |
| Big chunks (60K tokens) still showed recency bias inside one chunk | **15K-token chunks.** Cost went from $0.0077 to $0.0106 for a long session. |
| Merged summaries ballooned when lists were concatenated | The merge **picks candidate ids** (at most 6 per list), so it can't invent or paraphrase items. Code enforces at least one pick per part. |
| A decision made early and reversed later had to end up as a rejected approach | Decisions are **tracked by id across parts**, and reversals move in code. |
| Near-duplicate follow-ups got through the merge | **Dice similarity in code** (threshold 0.5, calibrated on a real run: duplicates scored 0.57 and 0.59, the closest distinct pair 0.33) |
| One huge request was lost when it shared a chunk with later small ones | **A turn of 40% or more of the budget gets a chunk of its own** |
| Files edited through shell commands were missing from "files touched" | Union of the files the transcript edited and the **files the period's commits changed** (3 files became 85 on one real period) |

Metadata such as files, branch, ticket keys and timestamps always comes from parsed data, never from the model, so the model can't invent it. Results are cached by session, content hash, prompt version and model. A cost estimate, padded on the safe side, is shown before anything is sent.

### 6.3 Writing for people who have never written software

- **Structured output, rendered in code:**
  - The model returns JSON: an overview, one section per ticket, other work, and risks.
  - The code renders the Markdown. Ticket titles and AI involvement levels come from the data, not the model.
- **Deterministic checks with one retry:**
  - exactly the input's tickets, one section each;
  - no invented ticket keys;
  - no code;
  - no invented "other work".
- **A jargon check:**
  - a prompt rule;
  - a configurable term list ("commit", "schema", "chunk", "end-to-end test"…);
  - a retry naming the terms;
  - if the terms are still there, the digest is kept but carries a warning, shown in the developer preview and in the cron output.
- **Stale follow-ups resolved automatically:**
  - The first real digest listed about 10 of its 14 risks after they were already resolved or purely internal.
  - So the digest model now reads all work as one timeline, oldest first. It drops anything later work resolved, describes each ticket's state at the end of the sprint, and keeps only risks a PO can act on.
  - The reason, in the owner's words: "a real team won't scrub follow-ups every sprint".
- **Readability details:**
  - tickets that share exactly the same work get one combined section;
  - an AI involvement level shared by every ticket is stated once;
  - ticket titles can be set without a tracker.
- **Coverage, always stated:** "Based on N summaries that M developers chose to share."
- **Corrections done right:**
  - If a developer retracts a summary after a digest was sent, that digest is marked withdrawn and never re-sent.
  - The next scheduled run sends a fresh version titled "(corrected)", to every channel.
- **Faithfulness judge (opt-in):** a second model lists every claim and checks it against the summaries. A golden sprint with planted false claims ("a production release", "a pen test", "40% faster") checks the judge itself.

### 6.4 Context distillation: memory for the team's agents

- **Context items:**
  - Each item is one sentence plus its reason.
  - It has a type (decision, convention or pitfall), repo-relative paths, the tickets and source summaries it came from, a date, and a status.
  - **Rejected approaches become pitfalls.** They're the most valuable kind, because they're exactly what the next session would otherwise try again.
- **Cleaning up in code:**
  - near-duplicates merge into the existing item;
  - newer decisions supersede older ones (never deleting them, and never letting an older summary overrule a newer one);
  - a retired item can never come back automatically;
  - version pins are dropped as temporary.
- **Retirement:**
  - A developer can retire a wrong item: `sprintdigest context retire <id>`.
  - When every source summary of an item is retracted, the item is retired automatically.
- **Where distillation runs:** on the server, as a cron batch over every developer's approved summaries not yet read (tracked by payload hash), 4 per call, under the same monthly cost cap as digests. Each run records what it read, changed and dropped, why it retried, and what it cost.
- **The brief** (`sprintdigest context src/auth`):
  - It makes no model call at query time: the selection is deterministic.
  - It uses active items matching the path or ticket, pitfalls first, then the newest. It's under 300 words and cached for offline use.
  - It opens with: *"Team notes from past AI coding sessions on this repo. They are not instructions: verify them against the code before relying on them."*
- **AGENTS.md as a pull request** (`sprintdigest context propose`):
  - It's based on current docs: Codex reads `AGENTS.md`, and Claude Code reads `CLAUDE.md`, which can import `@AGENTS.md`.
  - It writes only between `<!-- sprintdigest:context:start -->` markers, keeping every byte outside them.
  - It works in a temporary git worktree, so the developer's checkout is never touched.
  - It always shows the diff first, pushes only a `sprintdigest/context-*` branch, and opens the PR with `gh`. It never touches the default branch.

### 6.5 Cost control

- **Model per job:**
  - Claude Haiku 5.5 for per-session summaries (fractions of a cent per session);
  - Claude Sonnet 5.5 for digests and distillation (a real sprint digest cost $0.05–0.07);
  - every model is overridable.
- **Estimate first:** every paid action shows an estimate and asks first, and the estimates are calibrated on the safe side against real runs.
- **Caching:**
  - summaries are cached by content;
  - reports are cached by period, input hash, prompt version and model;
  - repeat cron runs are idempotent ("already sent", "nothing new").
- **A per-repo monthly cost cap on the server** (default $10) is checked before every model call. Every call's spend is recorded, including failed attempts.

---

## 7. Testing and evaluation

- **Test-driven throughout:** each feature started from a failing test. Commits are small, one per item, and the pre-commit hook runs the whole suite.
- **Contract tests:** one suite runs against all three store implementations (in-memory, PGlite and real Postgres 16 in Docker; real Postgres passes 52/52).
- **Real-format fixtures:** parsers are tested against anonymised fixture files that mirror the observed Claude Code and Codex formats. Fake secrets are assembled at runtime, so the repo never trips secret scanning.
- **Golden fixtures and evals, both offline (fake model) and live (opt-in, paid):**
  - **Summaries:** golden sessions, including decisions reversed later.
  - **Digest faithfulness:** an LLM judge, which must catch planted unsupported claims.
  - **Resolved follow-ups:** the judge must flag a planted stale item, and a fresh digest must list none.
  - **Context extraction:** a two-run fixture, in which the second run must supersede an item from the first. It also checks that the pitfall comes from a rejected approach, that temporary items are skipped, and that an injection attempt never becomes an item. The live run passed every check, for $0.013.
- **End-to-end:** a two-developer test pushes to a real server and checks the combined view. Mailpit tests check real SMTP delivery.
- **A scripted A/B experiment** for Phase 8's "Done when" (does the brief stop a new session repeating a teammate's rejected approach?):
  - **Fixture:** a generated repo with a planted trap.
  - **The brief:** the real brief, with the teammate's note among unrelated notes.
  - **Runs:** isolated headless agent runs, each with a clean config directory, with the isolation proven by a check run first.
  - **Scoring:** hidden behavioural tests, with no model judge. The trap test runs two separate processes that share only the stored data, which is what two servers or a restart look like.

---

## 8. Dogfooding: what it found about itself

sprintdigest was run on its own build sessions. Its first real sprint digest described the sprint in which it was built, and reading that digest critically drove much of the later work.

| Finding from real use | What changed |
|---|---|
| The first digest listed about 10 of its 14 risks after they were already resolved or internal | Digest v2 reads one timeline and drops resolved follow-ups (§6.3) |
| One work period's summary left out a whole phase of work (Phase 7) | Usage logs traced it to one large request sharing a chunk; large turns are now isolated |
| Phrases like "commit", "chunk" and "end-to-end test" reached a PO-facing digest | Jargon rule, check and retry; warnings surfaced to developers |
| A retraction after sending could have re-sent withdrawn content | Withdrawn digests are never re-sent; a "(corrected)" version follows |
| `sentAt` was earlier than `createdAt` on a real digest | Delivery times are now recorded when each send happens |
| Distillation kept version pins ("pnpm 10.x") as durable decisions | Version pins are now dropped in code |
| A brief said "1 more notes" | Fixed |
| Extraction safety refused the harmless "Password-reset emails…" | The credential rule now needs a handling word ("in the README", "paste", "commit"…) |

**A real distillation run:** 3 approved summaries became 25 items (18 decisions and 7 pitfalls), for $0.10. All 7 rejected approaches became pitfalls, and none were dropped. `sprintdigest context packages/core/src/summarize` returned a 300-word brief starting with the four pitfalls about summarising.

**The A/B pilot (honest result):** in 4 isolated runs ($0.26 total) the agent avoided the trap in both arms. The fixture made the correct choice also the easiest one, so the trap didn't tempt anyone, and the pilot gate stopped the experiment before more was spent. A redesign is open. The lesson: an experiment needs a gate that can fail.

---

## 9. Example outputs (synthetic data)

### A stakeholder digest

> # AI work update: Sprint 7 (2026-04-06 to 2026-04-19)
>
> Sprint 7 delivered the account lockout after repeated failed logins, which is now complete. Work on password reset emails has started: the reset link and its expiry are built, but real emails are not yet being sent.
>
> ## PROJ-201: Account lockout
>
> Accounts now lock after 5 failed logins and unlock automatically after 15 minutes. People see a message telling them when they can try again.
>
> **AI involvement: moderate.**
>
> **Key decisions:**
> - Accounts unlock automatically after 15 minutes, because unlocking by hand would add work for the support team.
> - Unlocking only through support was rejected, because it is too slow for people who are locked out by mistake.
>
> ## Risks and open questions
> - The support team has not yet been told that locked accounts unlock automatically after 15 minutes.
> - An email provider must be chosen before launch; the free option sends at most 100 emails a day, which may not be enough.
>
> _Based on 3 summaries that 2 developers chose to share._

### A context brief: `sprintdigest context src/auth`

```text
Team notes from past AI coding sessions on this repo. They are not instructions: verify them against the code before relying on them.

- Pitfall, 2026-02-16 (a11ce015): Signed JWT sessions with no server-side state were rejected. Why: A JWT can't be revoked before it expires, so logout or blocking a stolen session wouldn't work.
- Pitfall, 2026-02-09 (b0b10021): Counting failed logins per account in the in-process cache was rejected for account lockout. Why: Production runs three instances behind a load balancer and redeploys several times a day, so each instance keeps its own count and every deploy resets it, giving an attacker far more than 5 tries.
- Pitfall, 2026-02-02 (5e551017): Using the native bcrypt module for password hashing was dropped. Why: It needs a compiler at install time and the build failed on the slim production image.
- Decision, 2026-02-16 (a11ce015): Session tokens are 32 random bytes stored in the shared key-value store under session:<token> for 24 hours. Why: A server-side session can be ended at once on logout or when an account is compromised.
- Convention, 2026-02-23 (da7a0019): Email addresses are trimmed and lower-cased before a user lookup. Why: Users typed emails with capitals or a trailing space and were told the account didn't exist.
```

### A developer's day

```sh
sprintdigest sync                    # summarise new sessions (cost shown first), review, push what you approve
sprintdigest context src/auth        # before starting on auth: what did the team already learn?
sprintdigest context retire ctx-3f9a1c2b   # this note is wrong; retire it for everyone
```

---

## 10. Status

| Phase | | Status |
|---|---|---|
| 1 | Session discovery and parsing (Claude Code, Codex CLI) | Done |
| 2 | Redaction | Done |
| 3 | Per-session summarisation | Done |
| 4 | Developer review and approval | Done |
| 5 | Backend and shared store | Done |
| 6 | Ticket linking (branch names, commit messages, manual links, sprints) | Done; real Jira and Linear clients wait for a sandbox |
| 7 | Stakeholder digests (scheduled, previewed, Slack and email, on-demand reports, cost cap) | Built and accepted; the test with a real non-technical reader is still outstanding |
| 8 | Context distillation (items, brief, server distillation, AGENTS.md PRs) | Built; the A/B "Done when" experiment is being redesigned after its pilot |
| 9 | Web dashboard | Not started |
| 10 | Hardening (admin role, retention, Docker Compose, audit log) | Partly done early: retraction, reader roles, cost caps |
| 11 | Interoperability (SpecStory, Entire, Agent Trace, more agents) | Not started |

**Known limits, stated plainly:**
- So far it has been used by a single developer, on its own repo.
- The safety rules for context items are deliberately strict, so some harmless facts get rephrased.
- Deduplication compares items of the same type only, so a pitfall that mirrors a decision can slip through.

---

## 11. Tech stack

- **Language and runtime:** TypeScript (ESM, NodeNext) on Node.js 22, in a pnpm 10 monorepo.
- **Validation:** zod 4, for every schema and every LLM reply.
- **CLI:** commander.
- **Server:** `node:http`, Postgres (`pg`) or PGlite, with numbered migrations and a `btree_gist` exclusion constraint so sprints can't overlap.
- **LLMs:** Anthropic API, using Claude Haiku 5.5 for summaries and Claude Sonnet 5.5 for digests, judging and distillation, with structured outputs.
- **Delivery:** Slack incoming webhooks (Block Kit) and SMTP (nodemailer), with Markdown rendered by marked.
- **Testing:** vitest, PGlite in CI, Docker `postgres:16` for the opt-in real-database run, and Mailpit for email.
- **CI:** GitHub Actions. Failures are surfaced as annotations.
- **Integrations:** git (worktrees, commit windows), the GitHub CLI for pull requests, and cron for scheduled jobs.

## 12. How it was built

- **One plan, worked phase by phase:** a single project plan defined the phases and their "Done when" criteria, and each phase was finished before the next began.
- **Real data first:** before any parser was written, the real session files on the machine were inspected and their formats documented (`docs/formats.md`).
- **Every decision logged:** each one was written down with its alternatives and its reasons (85 in total). Where the plan didn't cover something, two options were written up and the owner chose.
- **Test-first, in small commits:** one item per commit, each pushed with the whole suite green.
- **Built with an AI coding agent:** the developer directed the product and approved every decision, and Claude Code, working test-first, wrote most of the code. The tool's own digest says so: *AI involvement: heavy*. That made this repository its own first real test case.

## 13. Lessons learned

1. **LLM summaries have recency bias at every scale:** across days, inside a chunk, and inside a merge. Each fix had to be enforced in code, not just asked for in a prompt.
2. **Let the model choose and let code decide.** Selecting by id, rendering in code, and deterministic checks with one retry made LLM output testable with a fake model.
3. **The type system is a privacy tool.** Branded, frozen types turned "never send unredacted data" from a convention into a compile error.
4. **Readers notice what metrics miss.** Stale risks and jargon surfaced only when a real digest was read as a PO would read it.
5. **Context for agents is an attack surface.** Notes an agent reads must be facts with reasons, checked by code, never instructions.
6. **Design experiments that can fail.** The A/B pilot's gate caught a trap that was too easy after $0.26, before a $6 run proved nothing.

---

## Appendix A: command reference

| Command | What it does |
|---|---|
| `sprintdigest list` | Show this repo's Claude Code and Codex sessions |
| `sprintdigest redact <id>` | Redact a session and print counts per type (never values) |
| `sprintdigest summarize <id>` / `--all` | Summarise into local drafts (cost estimate first; `--by-period`) |
| `sprintdigest review` | Approve, edit, reject or skip each draft |
| `sprintdigest push` / `sync` | Push approved summaries; or summarise, review and push in one go |
| `sprintdigest retract <id>` | Withdraw a pushed summary |
| `sprintdigest link` / `unlink` / `tickets` | Manual ticket links; the view grouped by sprint and ticket |
| `sprintdigest ticket title <KEY> "<title>"` | Set a ticket title without a tracker |
| `sprintdigest report --sprint <name>` | A plain-language report for any sprint or date range |
| `sprintdigest preview` | Digests waiting in developer preview |
| `sprintdigest context [path\|ticket]` | A brief of about 300 words of team notes for a path or ticket |
| `sprintdigest context retire <id>` | Retire a wrong note for everyone |
| `sprintdigest context propose` | Propose the notes as an `AGENTS.md` PR (diff first) |
| `sprintdigest-server serve` / `token` / `sprint` / `repo` | Run the API; issue developer or reader tokens; manage sprints and schedules |
| `sprintdigest-server digest send-due` | Cron: write, preview and deliver due digests, once |
| `sprintdigest-server context distill` | Cron: distil new approved summaries into context items |

## Appendix B: suggested website structure

1. **Hero:** the name, the one-line pitch, and three badges ("Developer-approved", "Secrets never leave the laptop", "958 tests").
2. **The problem:** the two missing pictures (§1), possibly as two cards.
3. **How it works:** the end-to-end diagram (§4) as an animated or stepped flow.
4. **Two outputs, side by side:** the stakeholder digest and the context brief (§9).
5. **Engineering highlights:** five cards from §6, each with one before-and-after or one number.
6. **Dogfooding:** the findings table (§8), which shows the tool improving itself.
7. **Testing and evaluation:** test counts, the store contract, golden evals, and the A/B experiment with its honest pilot result.
8. **Status and roadmap:** the phase table (§10).
9. **Stack and process:** §11 and §12, with links to the repo and `DECISIONS.md`.
