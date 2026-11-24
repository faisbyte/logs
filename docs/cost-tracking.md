# AI cost tracking

Shows managers and POs what AI development cost per developer, by day and session, and developers the same rows about
themselves (PROJECT_PLAN.md Phase 12, DECISIONS.md D106 and D107). It is separate from summaries and off by default.

Amounts are **estimates**. On a subscription they are what the usage would have cost at API prices, not money spent.

## Tell developers first

Tracking can't be turned on until the admin confirms developers were told. Some places require written notice of
electronic monitoring by law (New York, Connecticut and Delaware, and GDPR countries generally). Get legal advice; this
page isn't it. A notice to adapt:

> From <date>, we record the cost of AI coding tools used with company accounts on <repos>. For each AI request: the
> time, session id, model, token counts, estimated cost, and the repo if it is a company one (otherwise only that it was
> not). For those repos, also the hashes of commits made in a session. Prompts, replies, commands, code, file paths,
> names of other repos, and unregistered accounts are never recorded. You can see everything recorded about you in the
> dashboard under Cost, or with `sprintdigest cost`. <names> can see it at any time, and each look is logged. It is kept
> for <365> days. If someone asks about a session, you'll see the question and can answer it.

## Set up the server

```sh
sprintdigest-server cost enable --repo github.com/acme/webapp --developers-told
sprintdigest-server cost account --repo github.com/acme/webapp --email alice@acme.example --developer alice --name Alice --org <organisation id> --billing subscription
sprintdigest-server cost company --match 'github.com/acme/*'           # company repos are named; others never are
sprintdigest-server cost grant --repo github.com/acme/webapp --reader pat   # pat needs a reader token too
sprintdigest-server cost telemetry-token --label laptops               # can send usage, reads nothing
sprintdigest-server cost status
```

- **Set company repos before collecting.** A session in a repo that isn't registered is stored only as "outside", and
  that can't be corrected later, because its name was never kept.
- **Set `--org`.** Without it, usage under that email counts even on a personal plan. `cost trial` (below) shows the id.
- **A developer id is one person across the whole server.** Registering it under another name is refused.
- **Codex reports tokens, not cost.** Set a price, or its sessions show "No price":
  `cost price --model <id> --since 2026-04-01 --input <usd> --output <usd> --cache-read <usd>` (per million tokens).
- **Retention:** 365 days unless `cost retention --days <n>|forever`. `retention apply`, which the self-host stack runs
  hourly, enforces it.
- **Deleting:** `cost delete --developer alice --yes`. `sprintdigest delete-my-data` deletes a developer's summaries, not
  cost records: those are the company's spending record, so the admin deletes them.
- **Digest line:** `repo --repo <repo> --cost-line on` ends scheduled digests with the repo's total, no names.

## Set up Claude Code

In the organisation's managed settings (or, to try it, `~/.claude/settings.json`):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://logs.example.com",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <telemetry token>",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "true",
    "OTEL_LOG_USER_PROMPTS": "0",
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",
    "OTEL_LOG_TOOL_DETAILS": "0"
  },
  "hooks": {
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "sprintdigest cost commit-hook" }] }]
  }
}
```

- **Keep the three `OTEL_LOG_*` settings at 0.** The server drops that content anyway, but this keeps it on the machine.
- **The hook** reports a commit's hash and session id for repos that share with this server, and nothing else. It needs
  the developer's token (`.digest/token`). Without it, sessions show "No commit".
- **Repo names** need Claude Code 2.1.269 or later. Earlier versions show "Repo not reported".

## Set up Codex

Codex's log telemetry includes **tool output**, whatever its settings. Don't send it straight to a server. Run the
collector (`deploy/otel-collector.yaml`) on the developer's machine, so that content is dropped before it leaves:

```toml
[otel]
log_user_prompt = false

[otel.exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/logs"
protocol = "json"
```

Codex reports no repo. A session counts as shared when its developer shared a summary of it, and otherwise shows
"Repo not reported". This setup follows Codex's source and hasn't been tried with a live session yet.

## The collector

Optional for Claude Code. It drops everything the server wouldn't read. On the server:
`LOGS_TELEMETRY_TOKEN=<token> docker compose --profile cost up -d`, then point agents at port 4318 over HTTPS.

## Check what an agent sends

```sh
sprintdigest-server cost trial          # listens on http://127.0.0.1:4318 and stores nothing
```

Point one agent at it with the settings above and run a short session. It prints field names, whether a record would be
kept, and the account and organisation id. It never prints prompts, commands or other content.

## What the labels mean

| Label | Meaning |
|---|---|
| Shared repo | A repo the viewer has cost access to |
| Other company repo | A company repo the viewer has no cost access to; not named |
| Outside company repos | Any other repo: perhaps personal, perhaps a new project or a test folder |
| Repo not reported | No git remote, or the agent doesn't report one |

Cost can't show what work was for. A flag asks the developer; it isn't a finding.

## Limits

- **Estimates.** Compare with real bills before relying on them.
- **Trust.** Every machine shares a telemetry token and reports its own account, so someone could send false usage. It is
  a spending record, not evidence.
- **Access is a token on this server**, not GitHub membership.
- **A day's total can hint at work someone didn't share.**
