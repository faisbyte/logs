# logs: AI Sprint Digest

Reads the session files your AI coding agents (Claude Code, Codex CLI) already write locally.
It turns them into plain-language, ticket-level digests for POs, scrum masters and managers, and into a short shared context log for the team's agents.
Developers approve every summary before it's shared, and raw transcripts stay on the machine.

**Status:** Phase 5: shared store (storage choice pending; see DECISIONS.md D39).

## Requirements

- Node.js 22+
- pnpm 10 (pinned in `package.json`; `corepack install -g pnpm@10.34.9` installs it)
- git (for repo detection and commit lookup)

## Setup

```sh
pnpm install
pnpm build   # compile packages to dist/
pnpm test    # build, then run all tests
```

For `digest summarize`, put your Anthropic API key in `.env` (`cp .env.example .env`; gitignored) or export `ANTHROPIC_API_KEY`.

To run `digest` from any repo, alias the built binary (run this in this repo's root):

```sh
alias digest="node $PWD/packages/cli/dist/bin.js"
```

## Commands

Run these inside the repo you want to inspect, or pass `--repo <path>`.

| Command | What it does |
|---|---|
| `digest list` | Show this repo's Claude Code and Codex sessions: time, turns, tools, files, commits, branch, status |
| `digest list --json` | Same sessions as JSON (no transcript content beyond the title) |
| `digest redact <sessionId>` | Redact a session and print counts per placeholder type (never the values); honours `.digest/config.json` |
| `digest summarize <sessionId>` / `--all` | Summarise sessions into local drafts in `.digest/summaries/` (`--estimate` shows the cost first, `--yes` skips the confirmation) |
| `digest review` | Step through drafts: approve, edit in `$EDITOR`, reject or skip each one |
| `digest review --list` | List every summary with its status (draft, approved, rejected, edited) |
| `digest approve <id>` / `reject <id>` / `reopen <id>` | Approve or reject a draft, or put one back to draft before it's pushed |
| `digest push` | Push approved summaries to the shared store (only the shared fields; drafts and rejected summaries stay local) |
| `digest sync` | Summarise new sessions (cost estimate first), review the drafts, then push what you approved |
| `digest init` | Install an optional pre-push reminder that only prints a message; it never blocks a push |
| `digest --version` | Print the CLI version |

Sessions are read from `~/.claude/projects` and `~/.codex/sessions`, or from `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` if set.
Summarising sends redacted, condensed session text to the Anthropic API using your own `ANTHROPIC_API_KEY`; nothing else leaves the machine, and `.digest/` (local state) is gitignored.

## Layout

- `packages/core`: schemas, session parsers, repo filter, truncation, state tracker
- `packages/cli`: the `digest` command-line tool
- `fixtures/`: synthetic session files for tests (no real content)

## More detail

- [PROJECT_PLAN.md](PROJECT_PLAN.md): goals, architecture, phases
- [DECISIONS.md](DECISIONS.md): architectural decisions and why they were made
- [docs/formats.md](docs/formats.md): Claude Code and Codex session file formats, as observed
