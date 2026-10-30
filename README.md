# logs: AI Sprint Digest

Reads the session files your AI coding agents (Claude Code, Codex CLI) already write locally.
It turns them into plain-language, ticket-level digests for POs, scrum masters and managers, and into a short shared context log for the team's agents.
Developers approve every summary before it's shared, and raw transcripts stay on the machine.

**Status:** Phase 7: stakeholder digests.

## Setup

Needs Node.js 22+, pnpm 10 (`corepack install -g pnpm@10.34.9`) and git.

```sh
pnpm install
pnpm build   # compile packages to dist/
pnpm test    # build, then run all tests
```

For `sprintdigest summarize`, put your Anthropic API key in `.env` (`cp .env.example .env`; gitignored) or export `ANTHROPIC_API_KEY`.

To run `sprintdigest` from any repo, alias the built binary (run this in this repo's root):

```sh
alias sprintdigest="node $PWD/packages/cli/dist/bin.js"
```

## Commands

Run these inside the repo you want to inspect, or pass `--repo <path>`.

| Command | What it does |
|---|---|
| `sprintdigest list` (`--json`) | Show this repo's Claude Code and Codex sessions: time, turns, tools, files, commits, branch, status |
| `sprintdigest redact <sessionId>` | Redact a session and print counts per placeholder type (never the values); honours `.digest/config.json` |
| `sprintdigest summarize <sessionId>` / `--all` | Summarise sessions into local drafts in `.digest/summaries/` (`--estimate` shows the cost first, `--yes` skips the confirmation, `--by-period` writes one draft per work period) |
| `sprintdigest review` | Step through drafts: approve, edit in `$EDITOR`, reject or skip each one |
| `sprintdigest review --list` | List every summary with its status (draft, approved, rejected, edited) |
| `sprintdigest approve <id>` / `reject <id>` / `reopen <id>` | Approve or reject a draft, or put one back to draft before it's pushed |
| `sprintdigest retract <id>` | Withdraw a summary you pushed from the shared store; it becomes a local draft again |
| `sprintdigest push` | Push approved summaries to the shared store (only the shared fields; drafts and rejected summaries stay local) |
| `sprintdigest sync` | Summarise new sessions (cost estimate first), review the drafts, then push what you approved |
| `sprintdigest init` | Install an optional pre-push reminder that only prints a message; it never blocks a push |
| `sprintdigest link <id> <ticket>` / `unlink <id> <ticket>` | Link a pushed summary to another ticket, or remove such a link (ticket keys come from branch names, and from commit messages when `tickets.keys` is set in `.digest/config.json`) |
| `sprintdigest tickets --from <date> --to <date>` / `--sprint <name>` | Show the team's pushed summaries grouped by sprint, then ticket |
| `sprintdigest report --from <date> --to <date>` / `--sprint <name>` | Write a plain-language report of the team's shared AI work with your own API key (cost estimate first; `--out` to save it) |
| `sprintdigest preview` | Show scheduled digests waiting in developer preview before they are sent |
| `sprintdigest --version` | Print the CLI version |

### Shared store (sprintdigest-server)

```sh
node packages/server/dist/main.js token --data ./server-data --repo git@github.com:org/repo.git --developer alice --name Alice
node packages/server/dist/main.js sprint --data ./server-data --repo github.com/org/repo --name "Sprint 1" --from 2026-03-02 --to 2026-03-16
node packages/server/dist/main.js token --data ./server-data --repo github.com/org/repo --reader pat --name "Pat (PO)"   # read-only: digests and reports
node packages/server/dist/main.js repo --data ./server-data --repo github.com/org/repo --schedule sprint-end --email po@example.com --slack-env SLACK_WEBHOOK_URL
node packages/server/dist/main.js digest send-due --data ./server-data   # run from cron; sends what is due, once
node packages/server/dist/main.js serve --data ./server-data   # or set DATABASE_URL for Postgres; PORT defaults to 8787
```

Developers set `"share": {"url": "http://localhost:8787"}` in `.digest/config.json` and put their token in `.digest/token` (or `DIGEST_TOKEN`).
PGlite mode (`--data`) is single-process: stop the server before running `token` or `sprint`, then start it again.
`sprintdigest tickets --from/--to` (and `GET /v1/tickets`) selects every session overlapping the range, then files each under the sprint containing its start, so a session that began in the previous sprint shows under that sprint.

Sessions are read from `~/.claude/projects` and `~/.codex/sessions`, or from `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` if set.
Summarising sends redacted, condensed session text to the Anthropic API using your own `ANTHROPIC_API_KEY`; pushing sends only approved summaries' shared fields to your digest server. Raw transcripts never leave the machine, and `.digest/` (local state) is gitignored.

## More detail

- [PROJECT_PLAN.md](PROJECT_PLAN.md): goals, architecture, phases
- [DECISIONS.md](DECISIONS.md): architectural decisions and why they were made
- [docs/digests.md](docs/digests.md): the digest server's environment, scheduling with cron, and the report API
- [docs/po-feedback-checklist.md](docs/po-feedback-checklist.md): how to test a digest with a product owner or scrum master
- [docs/development.md](docs/development.md): package layout, tests, and how to run the real-Postgres test
- [docs/formats.md](docs/formats.md): Claude Code and Codex session file formats, as observed
