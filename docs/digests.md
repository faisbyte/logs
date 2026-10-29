# Stakeholder digests

The digest server writes plain-language digests of the team's approved AI work, for product owners, scrum masters and managers. Decisions D48–D56 in [DECISIONS.md](../DECISIONS.md) explain the design.

## Server environment

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Lets the server write digests and reports. Without it, the server only serves ones it has already written. |
| `DIGEST_MODEL`, `DIGEST_EFFORT` | Model and effort for digests (default `claude-sonnet-5-5`, `medium`). |
| `DIGEST_MONTHLY_CAP_USD` | Default monthly LLM cost cap per repo, in dollars (default 10). Change one repo's cap with `digest-server repo --cap-usd`. |
| `SMTP_URL`, `DIGEST_EMAIL_FROM` | Email delivery, e.g. `smtps://user:pass@smtp.example.com:465` (Resend, Postmark or your own server). |
| Any name you choose, e.g. `SLACK_WEBHOOK_URL` | A Slack incoming webhook URL. Point a repo at it with `digest-server repo --slack-env SLACK_WEBHOOK_URL`. |

Keep these out of version control. The server never logs or stores the API key, the SMTP password or the webhook URL.

## Scheduling

Configure a repo with `digest-server repo` (run it with no options to see the current settings):

- `--schedule weekly --weekday mon` sends a digest every Monday, covering the 7 days before. `--schedule sprint-end` sends one when each sprint ends (sprints come from `digest-server sprint`).
- `--preview-hours 24` lets developers read a digest with `digest preview` for 24 hours before it goes out. Developers can read it but can't change it.
- `--since 2026-03-01` sends digests for periods that ended after this date. By default it is the moment the schedule is turned on.

Then run `digest-server digest send-due` from cron, for example `0 7 * * *`. Each run sends whatever is due, once. A second run changes nothing, and failed deliveries are retried on the next run. It exits 1 if anything due wasn't sent.

## Reports on demand

A stakeholder with a reader token (`digest-server token --reader`) can request a report for any sprint or date range, and can read past digests:

```sh
curl -X POST "$SERVER/v1/reports" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"repoId": "github.com/org/repo", "sprint": "Sprint 12"}'
curl "$SERVER/v1/digests?repoId=github.com%2Forg%2Frepo" -H "authorization: Bearer $TOKEN"
```

A repeat request with unchanged summaries comes from the cache. If the next report would take the repo past its monthly cost cap, the server refuses with a 429 that says by how much.

Readers never see individual session summaries or who did what. Those endpoints answer 403 to a reader token.
