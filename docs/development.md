# Development

## Layout

- `packages/core`: schemas, session parsers, repo filter, truncation, state tracker
- `packages/cli`: the `digest` command-line tool
- `packages/server`: the digest server (HTTP API on Postgres or PGlite)
- `fixtures/`: synthetic session files for tests (no real content)

## Tests

`pnpm test` builds everything and runs the whole suite. It needs no API key and no database: the server tests use PGlite. The same command runs in CI and in the pre-commit hook.

Some tests are opt-in and skipped by default:

- The live API smoke test (`DIGEST_LIVE_TESTS=1`) and the live eval against the goldens (`DIGEST_EVAL=1`). Both also need `ANTHROPIC_API_KEY`, and both cost money.
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
