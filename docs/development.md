# Development

## Layout

- `packages/core`: schemas, session parsers, repo filter, truncation, state tracker
- `packages/cli`: the `sprintdigest` command-line tool
- `packages/server`: `sprintdigest-server`, the digest server (HTTP API on Postgres or PGlite)
- `fixtures/`: synthetic session files for tests (no real content)

## Tests

`pnpm test` builds everything and runs the whole suite. It needs no API key and no database: the server tests use PGlite. The same command runs in CI and in the pre-commit hook.

Some tests are opt-in and skipped by default:

- The live API smoke test (`DIGEST_LIVE_TESTS=1`) and the live evals against the goldens and the golden sprint (`DIGEST_EVAL=1`). All also need `ANTHROPIC_API_KEY`, and all cost money.
- The Mailpit email test below.
- The real-Postgres test below.

## Running the real-Postgres test

This runs the SummaryStore and TicketStore contract tests against a real Postgres. Every test empties the tables it uses, so use a throwaway database, never one you care about.

```sh
# 1. Start a throwaway Postgres 16 that only this machine can reach (no password).
docker run --rm -d --name digest-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5433:5432 postgres:16

# 2. Wait until it accepts TCP connections. Checking over TCP (-h 127.0.0.1) skips the
#    temporary server the image runs during first-time setup.
until docker exec digest-pg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do sleep 1; done

# 3. Run the test.
DIGEST_TEST_DATABASE_URL=postgres://postgres@localhost:5433/postgres \
  pnpm exec vitest run packages/server/test/postgres-real.test.ts

# 4. Stop it; --rm deletes the container and its data.
docker stop digest-pg
```

These steps map the container to port 5433, because 5432 is often taken by a local Postgres. If you change the port, change it in the URL too. If the test fails with "password authentication failed", it has probably reached a different Postgres than the container.

## Running the Mailpit email test

This sends a digest email through a real SMTP server and reads it back from Mailpit's API.

```sh
docker run --rm -d --name digest-mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit:v1.31.5
until curl -fs http://127.0.0.1:8025/api/v1/info >/dev/null; do sleep 1; done
DIGEST_TEST_SMTP_URL=smtp://127.0.0.1:1025 DIGEST_TEST_MAILPIT_URL=http://127.0.0.1:8025 \
  pnpm exec vitest run packages/server/test/mailpit.test.ts
docker stop digest-mailpit
```

Open http://127.0.0.1:8025 to see the message as an email client would.

## Running the digest eval

The eval costs money, so it needs `DIGEST_EVAL=1` and `ANTHROPIC_API_KEY`:

```sh
DIGEST_EVAL=1 pnpm exec vitest run packages/core/test/digest/judge.live.test.ts
```

It checks that the judge flags the claims planted in `packages/core/test/digest/golden-sprint.json`, then writes and judges a fresh digest. The report goes to `.digest/eval/`.

