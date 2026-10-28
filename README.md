# logs: AI Sprint Digest

Reads the session files your AI coding agents (Claude Code, Codex CLI) already write locally.
It turns them into plain-language, ticket-level digests for POs, scrum masters and managers, and into a short shared context log for the team's agents.
Developers approve every summary before it's shared, and raw transcripts stay on the machine.

**Status:** Phase 1, session discovery and parsing (in progress).

## Requirements

- Node.js 22+
- pnpm 10 (pinned in `package.json`; `corepack install -g pnpm@10.34.9` installs it)

## Setup

```sh
pnpm install
pnpm build   # compile packages to dist/
pnpm test    # build, then run all tests
```

## Commands

Run the CLI from the repo root with `node packages/cli/dist/bin.js <command>`.

| Command | What it does |
|---|---|
| `digest --version` | Print the CLI version |

## Layout

- `packages/core`: schemas and session parsers
- `packages/cli`: the `digest` command-line tool

## More detail

- [PROJECT_PLAN.md](PROJECT_PLAN.md): goals, architecture, phases
- [DECISIONS.md](DECISIONS.md): architectural decisions and why they were made
