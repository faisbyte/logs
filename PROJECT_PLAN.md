# AI Sprint Digest: Project Plan

Working name: logs
This file is the single source of truth for the project. It was written so a fresh AI session with no prior context can pick it up and start building.

---

## 0. How to use this file (instructions for the AI assistant)

Read this entire file before writing any code.
Work **one phase at a time**, in order. Don't start a phase until the previous phase's acceptance criteria pass.
Before writing any parser, **inspect real session files on the machine**. Don't trust the format notes in this file blindly, because agent log formats change between versions.
Prefer small, testable increments. Each task should end with something runnable.
When a decision isn't covered here, propose 2 options with tradeoffs and ask before proceeding.
Keep a DECISIONS.md file in the repo and log every architectural decision there.
---

## 1. Context and positioning

### The problem
When several developers use AI coding agents (Claude Code, Codex, etc.) on one shared repository:
1. Managers, product owners and scrum masters have no readable picture of what AI was used for, at the level of tickets and sprints.
2. Each developer's agent starts with no knowledge of what teammates' agents already did, decided or rejected.

### What already exists (don't rebuild these)
- **Entire** (entire.io, founded by ex-GitHub CEO Thomas Dohmke, $60M raised): captures agent sessions automatically through git hooks, stores them on a separate git branch, offers AI summaries per checkpoint, a web UI, and an "explain this code" feature. It's developer-facing.
- **SpecStory**: a free tool that auto-saves Claude Code, Codex, Cursor and other sessions as markdown in .specstory/history/, with cloud sync and a "Lore" feature that turns history into agent skills.
- **Rekal, TeamBrain, ContextPool, context-commit**: open-source tools that share agent memory across a team through git.
- **Agent Trace**: an open spec for recording AI code attribution, backed by Cursor, Cognition, OpenCode and git-ai.
- **Claude Code analytics dashboard, Jellyfish, DX, LinearB, Exceeds AI**: usage and productivity metrics for managers. They report metadata, not narrative.

### The gap this project targets
1. **Narrative digests at the ticket and sprint level for non-technical stakeholders** (POs, scrum masters, managers). For example: "PROJ-142: the auth refactor was mostly agent-written; approach X was rejected because Y; open risk: Z."
2. **Distilled shared context.** Raw transcripts are mostly noise. The product should maintain a curated, short log of decisions, conventions and pitfalls per repo that agents can use.

### Design principles (non-negotiable)
1. **Automatic capture, never manual export.** Read the agents' local session files directly. No Excel uploads.
2. **The developer approves before anything is shared.** Developers see and can edit or redact summaries before they reach the team or a manager. This prevents the tool from feeling like surveillance. One disclosed exception: AI cost data (Phase 12, D106) holds no content and is visible to managers without per-summary approval.
3. **Secrets are redacted before anything leaves the machine.**
4. **Share summaries, not raw transcripts.** Raw transcripts stay local by default.
5. **Distilled over dumped.** Context given to agents must be short and curated, never a growing raw log.
6. **Interoperate where possible.** Later on, be able to ingest Entire checkpoints, SpecStory markdown, and Agent Trace records.

---

## 2. Users and core flows

### Personas
- **Developer**: uses Claude Code or Codex on the shared repo.
- **Stakeholder**: manager, PO or scrum master. Usually non-technical. Wants plain-language updates.

### Core flows (v1)
1. Developer works normally with their AI agent.
2. Developer runs digest sync (or a git hook runs it on commit or push). The CLI:
   - finds new sessions for this repo,
   - parses and normalises them,
   - redacts secrets,
   - generates a structured summary per session,
   - shows the summary for approval and editing,
   - pushes approved summaries to the shared store.
3. The backend aggregates approved summaries per repo and links them to tickets.
4. On a schedule (weekly or end of sprint), the backend generates a **stakeholder digest** and sends it to Slack or email.
5. Developers (or their agents) run digest context [path|ticket] to get a short brief of relevant past decisions before starting work.
6. The system periodically proposes updates to AGENTS.md / CLAUDE.md as a pull request, built from accumulated decisions.

### Out of scope for v1
- Line-level code attribution (leave that to Agent Trace and Entire).
- Productivity metrics or leaderboards. (Phase 12's cost tracking is after v1 and adds neither: no rankings or output scores, D106.)
- IDE extensions.
- Agents other than Claude Code and Codex CLI.

---

## 3. Architecture

 Developer machine                                  Server
 ┌───────────────────────────────┐                  ┌──────────────────────────────┐
 │ ~/.claude/projects/...  ─┐    │                  │ API (auth, repos, sessions)  │
 │ ~/.codex/sessions/...   ─┼─►  │  Collector CLI   │ DB (Postgres)                │
 │                          │    │  ├ parse         │ Ticket linker (Jira/Linear)  │
 │                          │    │  ├ normalise     │ Digest generator (LLM)       │
 │                          │    │  ├ redact        │ Delivery (Slack/email)       │
 │                          │    │  ├ summarise(LLM)│ Context distiller (LLM)      │
 │                          │    │  ├ review/approve├─►  └ opens PR to AGENTS.md    │
 │                          │    │  └ push          │ Web dashboard                │
 └───────────────────────────────┘                  └──────────────────────────────┘
### Components
| Component | Responsibility |
|---|---|
| Collector CLI | Discover, parse, normalise, redact, summarise, review, push |
| Parsers | One adapter per agent (Claude Code, Codex), producing a common schema |
| Redactor | Remove secrets and PII before summarisation and before upload |
| Summariser | LLM call producing a structured JSON summary per session |
| API + DB | Store repos, developers, approved summaries, ticket links, digests |
| Ticket linker | Map sessions to tickets via branch names, commit messages, APIs |
| Digest generator | Turn a sprint's summaries into a plain-language stakeholder report |
| Delivery | Slack webhook and email |
| Context distiller | Maintain the decisions log and propose AGENTS.md/CLAUDE.md PRs |
| Context command | Return a short brief for a path or ticket (CLI, later an MCP server) |
| Dashboard | Web UI for stakeholders and developers |

### Suggested tech stack (change it if you prefer)
- **Language:** TypeScript monorepo (pnpm workspaces) so the CLI and server share types.
  - packages/core: schemas, parsers, redactor, prompts
  - packages/cli: Node CLI (commander or yargs)
  - apps/server: Fastify or Next.js API routes
  - apps/web: Next.js dashboard
- **DB:** Postgres with Prisma or Drizzle. SQLite for a local-only mode.
- **Validation:** zod for every schema, including LLM output.
- **LLM:** Anthropic API (a fast model for per-session summaries, a stronger one for digests).
- **Testing:** vitest, with fixture session files.
- Alternative: Python (Typer CLI + FastAPI + Pydantic) if you're more comfortable with it.

---

## 4. Data model (first draft)

Repo        { id, name, remoteUrl, createdAt }
Developer   { id, name, email, repoIds[] }
Session     {
  id, repoId, developerId, agent: "claude-code" | "codex",
  sourceSessionId, startedAt, endedAt, gitBranch, cwd,
  commitShas[], filesTouched[], turnCount, toolCallCount,
  rawStoredLocallyOnly: true
}
SessionSummary {
  sessionId, status: "draft" | "approved" | "rejected",
  goal, outcome: "completed" | "partial" | "abandoned",
  whatWasDone,            // plain language, 2-5 sentences
  decisions[],            // { decision, reason }
  rejectedApproaches[],   // { approach, reason }
  risksOrFollowUps[],
  filesTouched[], ticketRefs[],
  aiInvolvement: "light" | "moderate" | "heavy",
  editedByDeveloper: boolean, approvedAt
}
TicketLink  { sessionId, ticketKey, source: "branch" | "commit" | "manual" | "api" }
Digest      { id, repoId, periodStart, periodEnd, audience, markdown, sentAt, channel }
ContextItem { id, repoId, type: "decision" | "convention" | "pitfall",
              text, paths[], sourceSessionIds[], status: "active" | "superseded" }
---

## 5. Phases

### Phase 0: Validation (run alongside Phase 1)
- [ ] Interview 10–15 scrum masters, POs or engineering managers. Ask what they do today to find out what AI did in a sprint and whether they'd pay for a sprint-level narrative. Don't ask "would you want visibility?"
- [ ] Interview 5+ developers about the approval flow and about surveillance concerns.
- [ ] Write the findings to research/interviews.md.

**Done when:** you have written evidence for or against stakeholder demand.
**Status:** Closed by the owner without interviews (D105). The "Done when" is not met: there is no written evidence for or against demand, and the items above stay unticked.

### Phase 1: Session discovery and parsing
- [x] Inspect real files first:
  - Claude Code: usually ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl, one JSON event per line (user and assistant messages, tool use, timestamps, cwd, git branch).
  - Codex CLI: usually ~/.codex/sessions/YYYY/MM/DD/*.jsonl.
  - **Verify both on your machine and record the actual formats in docs/formats.md.**
- [x] Define a normalised ParsedSession schema in packages/core (zod).
- [x] Write a parser adapter per agent.
- [x] Filter sessions to the current repo (match cwd against the repo root).
- [x] Track already-processed sessions in a local state file (.digest/state.json, gitignored).
- [x] Strip or truncate tool outputs (file dumps, command output). Keep user prompts, assistant reasoning text, tool call names, and file paths.
- [x] Extract metadata: branch, files touched, start and end time, commit SHAs made during the session if detectable.
- [x] CLI command digest list shows the sessions found for this repo.

**Done when:** digest list correctly shows your real Claude Code and Codex sessions for a test repo, and parser unit tests pass on fixture files.
**Status:** Met (formats in docs/formats.md).

### Phase 2: Redaction
- [x] Use regex detectors for common secrets (AWS keys, GitHub tokens, Anthropic/OpenAI keys, JWTs, private keys, .env-style KEY=value, connection strings).
- [x] Add entropy-based detection for unknown high-entropy strings.
- [x] Add optional PII detection (emails, phone numbers).
- [x] Support a configurable allow/deny list in .digest/config.json.
- [x] Replace matches with typed placeholders like [REDACTED:aws_key].
- [x] Write unit tests with a fixture file full of fake secrets.

**Done when:** no fixture secret survives redaction, and redaction runs before any LLM call or network request.
**Status:** Met: redaction can't be skipped (D16, D17).

### Phase 3: Per-session summarisation
- [x] Write the summariser prompt (see Section 6) that returns JSON matching SessionSummary.
- [x] Validate the output with zod and retry once on invalid JSON.
- [x] Chunk long sessions: summarise the chunks, then merge.
- [x] Cache summaries locally keyed by session ID and content hash.
- [x] CLI command digest summarize [sessionId].
- [x] Track cost: log the tokens used per summary.

**Done when:** summaries of 5+ real sessions are accurate and readable, as judged by you.
**Status:** Met: the owner's review of the dogfood summaries drove the fixes in D31 to D38.

### Phase 4: Developer review and approval
- [x] CLI command digest review: show each draft summary, let the developer approve, edit (open in $EDITOR), or reject.
- [x] Rejected sessions are never uploaded.
- [x] Mark summaries editedByDeveloper when changed.
- [x] Add a config option to auto-approve for solo or trusted setups (off by default).

**Done when:** nothing can be uploaded without an explicit approval state.
**Status:** Met: approval is a type the push path requires (D34).

### Phase 5: Backend and shared store
- [x] API with token auth per developer and per repo.
- [x] Endpoints: register repo, push summaries, list summaries by repo, branch, ticket or date. (A repo is registered when the server issues its first token, an admin command rather than an endpoint: D43.)
- [x] CLI command digest push, and digest sync (= discover, summarise, review, push).
- [x] Optional git hook installer: digest init adds a post-commit or pre-push reminder.
- [x] Alternative storage mode (decide in DECISIONS.md): store approved summaries as JSON on an orphan git branch instead of a server, Entire-style. (Decided in D39: the server. The git branch was not built.)

**Done when:** two developer accounts can push summaries for the same repo, and both appear in one combined list.
**Status:** Met in the server tests, against PGlite and real Postgres (D43).

### Phase 6: Ticket linking
- [x] Extract ticket keys from branch names and commit messages (configurable regex, e.g. [A-Z]+-\d+).
- [x] Allow manual ticket tagging during review.
- [ ] Optional Jira and Linear integrations to fetch ticket titles and sprint membership. (The interface and a fake are built, D47; real clients wait for a sandbox, in Phase 11.)

**Done when:** summaries are grouped correctly by ticket and sprint for a test project.
**Status:** Met in tests, with a fake tracker (D46, D47).

### Phase 7: Stakeholder digest
- [x] Digest prompt (see Section 6): plain language, grouped by ticket, no code, a short "risks and open questions" section, and the AI involvement level per ticket.
- [x] Schedule weekly or end of sprint (cron or a queue).
- [x] Delivery: Slack incoming webhook and email (Resend, Postmark or SMTP).
- [x] Store sent digests and let stakeholders view past ones in the dashboard.
- [x] Add a "developer preview" step: developers can see the digest before it's sent (configurable).
- [x] On-demand team report: a manager can generate one document covering all developers'
      approved AI work on a repo for any sprint or date range, not just on the schedule.
      Available from the dashboard and as `digest report --from --to` (or `--sprint`).
- [x] Export the report as Markdown and PDF. (Markdown from the CLI; PDF through the dashboard's "Print or save as PDF" and its print stylesheet, D93.)
- [x] The report states its coverage, e.g. "Based on 23 approved session summaries from
      4 developers." Whether it also shows how many sessions are still unreviewed is a
      decision to log in DECISIONS.md.
- [ ] (Moved to the backlog, waiting for interview evidence.) Per-developer breakdown: off by default (see the "no judgement of individual
      developers" rule). If enabled, it's a repo-level setting that every developer on
      that repo can see is on.

**Done when:** a real sprint's worth of summaries produces a digest that a non-technical person can understand. Test this with an actual PO or SM.
**Status:** Built and accepted (D73). The reader test is done (D104). **Outstanding:** a sprint with several developers (D57).

### Phase 8: Context distillation (the developer-side value)
- [x] From approved summaries, extract ContextItems (decisions, conventions, pitfalls) with the file paths they relate to.
- [x] Deduplicate and supersede. Newer decisions on the same topic mark older ones superseded.
- [x] CLI command digest context [path|ticket] returns a brief of at most about 300 words with only active, relevant items.
- [x] Generate proposed edits to AGENTS.md / CLAUDE.md and open them as a pull request for human review. Never commit directly.
- [ ] Later: expose context as an MCP server tool so agents can query it themselves.

**Done when:** a new session given the digest context output avoids a mistake or rejected approach recorded earlier by a teammate (test this deliberately).
**Status:** Built. **Outstanding:** the 40-run experiment is parked (D90); the harness is ready.

### Phase 9: Web dashboard
- [x] Repo overview: recent sessions, tickets, digests.
- [x] Ticket view: all summaries for a ticket, as a timeline.
- [x] Stakeholder view: digest archive only, with no transcript access.
- [x] Context view: active and superseded ContextItems.

**Status:** Accepted (D96), with end-to-end and axe tests in CI.

### Phase 10: Hardening
- [x] Roles: developer, stakeholder, admin. Stakeholders never see raw content. (Reader tokens for stakeholders, D51; the admin is the server operator, D97, D102.)
- [x] Data retention settings and a delete-my-data option. (D98, D99.)
- [x] Self-host option (Docker Compose). (D97, docs/self-hosting.md.)
- [x] Rate limiting and LLM cost caps per repo. (D53, D101.)
- [x] Audit log of who viewed or sent what. (D100.)

**Status:** Accepted (D103).

### Phase 11 (later): Interoperability
- [ ] Ingest SpecStory .specstory/history/*.md.
- [ ] Ingest Entire checkpoints from the entire/checkpoints/v1 branch.
- [ ] Read and write Agent Trace records.
- [ ] Add more agents (Gemini CLI, Cursor CLI).
- [ ] Opt-in GitHub issue references (#123, fixes #45) as ticket keys (left out of Phase 6).
- [ ] Per-developer breakdown in reports (from Phase 7): off by default, a repo-level setting every developer can see is on. Waiting for interview evidence that stakeholders need it.
- [x] PDF export of reports (from Phase 7): with the Phase 9 dashboard. (Print or save as PDF, D93.)
- [ ] Tracker work left from Phase 6, waiting for a Jira or Linear sandbox (DECISIONS.md D47): real Jira and Linear clients, a `digest-server` command that runs refreshTracker, removing tickets a tracker no longer knows, and tracker sprint dates.

### Phase 12: AI cost tracking (separate workflow, D106)
Managers and POs can see at any time what AI development cost per developer. It is independent of summaries: developers still choose which summaries to share. Developers are told about it and see their own data. It only tracks: no plan advice, no rankings. It doesn't depend on Phase 11 and can come before it. Steps are done in order.

**12.1 Trial (before any design is fixed)**
- [ ] (The listener is built: `sprintdigest-server cost trial`. It needs a live session.) Capture real Claude Code telemetry on one machine, on API billing and on a subscription if both are available. Record the fields in docs/formats.md, with no real content.
- [ ] The same for Codex: whether cost, tokens, account, session and repo are available, and whether an admin can set it centrally. (Unconfirmed.)
- [x] Choose how commit hashes arrive. Claude Code's `OTEL_LOG_TOOL_DETAILS` also sends full shell commands, so it stays off. Chosen: a Claude Code hook that reports only session id, repo and commit hash (D107). Codex has none yet.

**12.2 Receive**
- [x] An OpenTelemetry Collector in Docker Compose, off by default, and an authenticated server endpoint.
- [x] An allowlist of stored fields (time, account, session, agent, model, tokens, estimated cost, repo classification, commit hash). Everything else is dropped, in the collector and again on the server, and a test sends prompt text and shell commands and checks that neither is stored.
- [x] Company accounts only: usage from any account or organisation that isn't registered is dropped, so a developer's personal subscription is never recorded.
- [x] Setup docs: managed settings for Claude Code, and the Codex equivalent from the trial.

**12.3 Store**
- [x] Migration and store contract for cost records: duplicates ignored, account mapped to developer, amounts marked as estimates.
- [x] Price tables versioned by date for agents that report tokens but not cost.
- [x] Retention and delete-my-data (D98, D99) extended to cost records, after deciding what finance must keep.

**12.4 Match sessions to work**
- [x] Each session is one of: **shared repo** (registered here, and the viewer has access), **other company repo** (a registered company repo or organisation the viewer lacks access to), **outside company repos**, or **unknown** (no git remote).
- [x] Repo names are kept only for company repos. For outside ones only the classification is kept, never the name, path or commit hash.
- [x] Commit hashes shown for shared repos, linked to the repo host. "No commit" is a normal state (research, review, debugging), not a warning.
- [x] Sessions linked to approved summaries and their tickets where they exist. A session without an approved summary shows its cost only.

**12.5 Access and disclosure**
- [x] Cost access: a permission the admin grants per repo to a reader (manager or PO), off by default. It covers the developers on that repo. Update the reader role matrix (D102).
- [x] Developers see their own records exactly as a manager sees them, plus any flag on them.
- [x] A notice in the CLI, dashboard and docs stating what is collected and who sees it. Collection can't be enabled for a repo until the admin confirms developers were told.
- [x] Audit events for viewing per-developer cost, granting access, and flagging.

**12.6 Dashboard: Cost**
- [x] Totals for a day, sprint or date range: by repo, developer, model and ticket.
- [x] Drill-down: developer, then day, then session, showing time, agent, model, estimated cost, repo classification and commit hashes.
- [x] On subscriptions, amounts are labelled "API-equivalent estimate, not money spent".
- [x] Filter for work outside the viewer's shared repos.
- [x] Flag a session "to discuss", with an optional note. The developer sees it and can reply, and either can mark it resolved. Wording is neutral: a flag is a question, not a finding.
- [x] CSV export.
- [x] An optional cost line (repo total only) in stakeholder digests, off by default.

**12.7 Check**
- [ ] Compare a few weeks of estimates with real bills (Claude Console, and OpenAI for Codex) and record the difference.
- [ ] A test with a real PO and at least two developers, including how developers feel about it.

**Not in this phase:** plan recommendations, budget alerts, leaderboards, cost-per-output scores, automatic detection of personal use.

**Done when:** a PO can open the dashboard, see each developer's cost by day and session with commit hashes for shared repos, and flag a session outside them; the developer sees the same data and the flag; and tests show that no prompt, command, outside repo name or personal-account usage is stored.
**Status:** Built, not accepted (D107). Outstanding: the live trial (12.1) and the check with real bills and people (12.7). It was built from the agents' documentation and source before the trial, at the owner's request, so the trial may change it.

---

## 6. LLM prompt drafts

### 6.1 Session summariser (developer-facing, structured)

You are summarising one AI coding session for a team log.
Input: a redacted, condensed transcript of a developer working with an AI coding agent, plus metadata (branch, files touched).

Return ONLY JSON matching this schema: {schema}

Rules:
- "whatWasDone": 2–5 plain sentences on what changed and why.
- "decisions": only decisions that were actually made, each with its reason.
- "rejectedApproaches": approaches tried or proposed then abandoned, with reasons. These are valuable, so include them.
- "risksOrFollowUps": unfinished work, TODOs, known bugs, things to verify.
- Don't invent anything that isn't in the transcript. If unsure, leave it out.
- Don't include code, secrets, or redaction placeholders.
- "aiInvolvement": light = Q&A/explanations, moderate = AI wrote parts, heavy = AI wrote most of the change.
### 6.2 Stakeholder digest (non-technical)

You are writing a sprint update for a product owner or scrum master who is not technical.
Input: approved session summaries grouped by ticket, plus ticket titles.

Write markdown:
1. A 2–3 sentence overview of the period.
2. One short section per ticket: what was achieved, how AI was involved (light/moderate/heavy, in plain words), key decisions in plain language.
3. "Risks and open questions": a combined list.

Rules: no code, no file paths unless essential, no jargon without a short explanation, no judgement of individual developers, no invented facts.
### 6.3 Context distiller

From these approved summaries, extract durable team knowledge: decisions, conventions, pitfalls.
Each item: one sentence, the related paths, and the source session IDs.
Mark an existing item as superseded if a newer summary contradicts it.
Skip anything temporary or session-specific.
---

## 7. Testing and evaluation
- fixtures/: anonymised real session files for Claude Code and Codex, including a long one and a messy one with abandoned approaches.
- Parser tests: field extraction, repo filtering, tool output truncation.
- Redaction tests: a fake-secret corpus with zero leaks.
- Summary evals: hand-write 5 "golden" summaries and compare them for missing decisions or invented facts.
- Digest evals: show the output to a real non-technical person and record their feedback.
- Context evals: a scripted scenario where context should prevent a repeated mistake.

---

## 8. Risks and open questions
- **Platform risk:** Entire, Anthropic, OpenAI or GitHub may build stakeholder digests. Stay focused on the PO/SM workflow and ticket integrations.
- **Format drift:** agent log formats change. Keep the parsers isolated and well tested.
- **Developer trust:** if the tool feels like surveillance, adoption fails. The approval flow is essential. Cost tracking (Phase 12) adds to this risk, so it must stay disclosed, and developers must see everything recorded about them.
- **Summary accuracy:** wrong summaries sent to managers are harmful. Keep the developer preview, and always state uncertainty.
- **Cost:** LLM cost per session. Use cheaper models for per-session work and caching.
- **Open question:** server storage or git-branch storage? Decide in Phase 5.
- **Open question:** is this a CLI-first product, or a GitHub App that runs in CI on pushed session data?

---

## 9. First prompt for the new session

"Read PROJECT_PLAN.md fully. Set up the monorepo structure from Section 3 with TypeScript, pnpm, zod and vitest. Then begin Phase 1: first help me locate and inspect my real Claude Code and Codex session files, document the formats in docs/formats.md, and only then write the parsers. Log decisions in DECISIONS.md."