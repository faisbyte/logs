# Self-hosting with Docker Compose

`compose.yaml` runs the whole server side on one machine from one image (DECISIONS.md D97):

| Service | What it does |
|---|---|
| `db` | Postgres 16, with its data in the `db` volume |
| `server` | The digest server API on port 8787. Developers' CLIs push here. |
| `jobs` | Once an hour: `digest send-due`, `context distill` and `retention apply` (the cron jobs in [digests.md](digests.md)) |
| `web` | The dashboard on port 3000 |

Nothing secret is built into the image. `.dockerignore` keeps `.env`, `.digest/`, local databases and session data out
of it, and keys are read from the environment at run time.

## Start it

```sh
docker compose up -d --build
```

Settings come from your shell or from a `.env` file next to `compose.yaml`. All of them are optional:

| Variable | Default | What it's for |
|---|---|---|
| `POSTGRES_PASSWORD` | `logs` | The database password. Set your own before the first start. |
| `ANTHROPIC_API_KEY` | unset | Writing digests, reports and context. Without it the server serves what it has already written. |
| `DIGEST_MONTHLY_CAP_USD` | `10` | The default monthly LLM cost cap per repo |
| `DIGEST_MODEL` | Sonnet 5.5 | The digest model |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests a minute per token or dashboard session (per address without one); `0` turns it off |
| `SMTP_URL`, `DIGEST_EMAIL_FROM` | unset | Email delivery |
| `SLACK_WEBHOOK_URL` | unset | Slack delivery; name it in the repo's settings with `--slack-env SLACK_WEBHOOK_URL` |
| `LOGS_API_PORT`, `LOGS_WEB_PORT` | `8787`, `3000` | Host ports |
| `LOGS_API_BIND`, `LOGS_WEB_BIND` | `127.0.0.1` | Host addresses; both listen on this machine only by default |

## Admin commands

The admin is whoever can run commands on the server (D43, D97). There is no admin endpoint on the network. Run the
admin commands inside the server container:

```sh
docker compose exec server sprintdigest-server token --repo github.com/org/repo --developer alice --name Alice
docker compose exec server sprintdigest-server token --repo github.com/org/repo --reader pat --name "Pat (PO)"
docker compose exec server sprintdigest-server sprint --repo github.com/org/repo --name "Sprint 1" --from 2026-03-02 --to 2026-03-16
docker compose exec server sprintdigest-server repo --repo github.com/org/repo --schedule sprint-end --email po@example.com
docker compose exec server sprintdigest-server repo --repo github.com/org/repo --retention-days 365   # summaries age out; default: kept for good
docker compose exec server sprintdigest-server delete-data --repo github.com/org/repo --developer alice --yes   # a departed developer
docker compose exec server sprintdigest-server audit --repo github.com/org/repo --limit 50   # who viewed or sent what
```

With Postgres there is no need to stop the server first (that's only for the local PGlite mode).

## Point developers at it

Each developer sets `"share": {"url": "https://logs.example.com"}` in `.digest/config.json` and puts their token in
`.digest/token`.

## Before exposing it beyond this machine

- **Use HTTPS.** Put a reverse proxy (Caddy, nginx, a cloud load balancer) in front of both ports and bind them to
  `127.0.0.1` (the default). Tokens travel in request headers, so plain HTTP would expose them. The dashboard's session
  cookie is `Secure`, so browsers only accept it over HTTPS, or on `localhost`.
- **Set `POSTGRES_PASSWORD`** before the first start. It can't be changed by the variable afterwards.

## Back up and upgrade

```sh
docker compose exec db pg_dump -U logs logs > logs-backup.sql   # back up
git pull && docker compose up -d --build                         # upgrade: migrations run when the server starts
```

## Test

`DIGEST_DOCKER_TESTS=1 pnpm exec vitest run packages/server/test/compose.test.ts` builds the stack and checks it end to
end. It uses its own project name and ports and removes everything afterwards. CI runs it on every push.
