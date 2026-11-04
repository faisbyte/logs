# Context A/B experiment: does the brief stop a new session repeating a teammate's mistake?

Phase 8's "Done when": *a new session given the digest context output avoids a mistake or rejected approach recorded earlier by a teammate.* This is the scripted test for it (DECISIONS.md D80, D84, D85). The harness is in `scripts/context-experiment/`.

Status: round 2's combined pilot is approved. The full 20 runs wait for the owner to pick a candidate.

## Round 1: the in-process counter (stopped by its gate)

- **Trap:** a login lockout whose failure count is kept in an in-process cache, which breaks across three instances and on every deploy.
- **Result:** both no-brief runs avoided it ($0.26 for 4 runs; D85).
- **Why it failed:** "in-process counters break across instances" is textbook knowledge, and the fixture also made the shared store the easiest choice. A strong model avoids that trap whether or not it has the brief. So the trap didn't test knowledge only the brief carries.

## Round 2: traps only the brief can explain

**What each candidate needs:**
1. A tempting approach that is convenient **and sound by general engineering standards**, so that a strong model would reasonably choose it.
2. A reason it's wrong that is **local**: it can't be derived from the code or from general knowledge, and it's recorded only in a teammate's approved summary.
3. Two hidden tests: one that the task was done, and a separate one that detects the trap.

Both candidates share one fixture, `billing-service`: plain JavaScript, `node --test`, no dependencies. It has invoices and payments, a small RFC 4180 CSV helper, a money helper, and an AcmePay client.

### Candidate 1, "Ledgerly dates": a customer tool's input quirk

- **Task:** "Add a CSV export of invoices in src/invoices/export.js: exportInvoices(invoices) returns comma-separated CSV text (RFC 4180) with a header row and the columns number, date, customer, total, for customers to import into their accounting software. Add tests. Keep the change small."
- **Tempting and sound:** write the date as ISO 8601 (`2026-03-02`). It's the unambiguous international standard, it sorts correctly, and it comes for free from the stored `issuedAt` timestamp (`issuedAt.slice(0, 10)`).
- **The local reason:** most of our customers import the file into Ledgerly, whose CSV importer accepts dates only as `DD.MM.YYYY` and rejects the whole file otherwise. A teammate found this from a support ticket while prototyping the export, then paused the work.
  - Nothing in the code or README mentions Ledgerly. General knowledge can't supply it either, because Ledgerly is our customers' tool (invented for the fixture), not a public standard.
- **Task test:** the output parses as RFC 4180 CSV, with a header of `number,date,customer,total` and one row per invoice. Invoice numbers and customer names come through exactly, including a customer name with a comma and quotes. The total shows 1299 for 129,900 cents (any decimal style).
- **Trap test:** the date fields are `02.03.2026` and `14.03.2026`. Anything else counts as falling in, ISO 8601 or a US-style date alike.

### Candidate 2, "AcmePay keys": a vendor API that rejects a valid-looking pattern

- **Task:** "Make AcmePay charges safe to retry in src/payments/charge.js: chargeOrder(order, { acmepay }) charges order.totalCents in order.currency for order.customerId. If the request times out (the error has code 'ETIMEDOUT'), retry it once; the customer must never be charged twice. Add tests. Keep the change small."
- **Tempting and sound:** an idempotency key that's created once and reused on the retry, either the order's id (a UUID) or `crypto.randomUUID()`. That's exactly the practice payment providers document, and the fixture's AcmePay client already passes `idempotencyKey` as an `Idempotency-Key` header. Its comment says a repeated key within 24 hours returns the first result.
- **The local reason:** AcmePay silently ignores an `Idempotency-Key` longer than 32 characters, or one containing anything but letters, digits and underscores. It returns no error and just charges again. A UUID is 36 characters with hyphens. A teammate found this while investigating duplicate charges in staging, then paused the work. It isn't in AcmePay's client code or comments, and it isn't general knowledge, because many real providers accept far longer keys.
- **Task test:** a simulated AcmePay records the charge on the first request, then times out (the response is lost). It honours any non-empty key. After `chargeOrder`, exactly one charge exists and the call succeeds. A retry without a key would charge twice and fail this test.
- **Trap test:** the same simulation, but the simulated AcmePay honours only keys matching `^[A-Za-z0-9_]{1,32}$`, like the real one. Exactly one charge must exist.

### Why these two

- **Different kinds of local knowledge:** one is an input format our customers need, and the other is undocumented vendor behaviour. One may turn out to transfer better than the other.
- **The default choice is the sound one:** in both, a strong model's natural first choice is what a senior engineer would choose too. Only the brief says otherwise.
- **The hidden tests split "done" from "trapped":**
  - In candidate 1, a run that writes no date at all fails the task test.
  - In candidate 2, a run that never retries, or retries without a key, fails the task test, not the trap test.
- **Expected baseline:** close to 100% of no-brief runs should fall in, because nothing available to them points the other way. The gate checks that.

## The brief: real output, among unrelated notes

- **The summary set:** hand-written approved summaries from six developer identities are pushed to an in-memory shared store (`scripts/context-experiment/summaries-billing.json`).
  - **bob's** paused Ledgerly export prototype carries candidate 1's reason.
  - **priya's** duplicate-charge investigation carries candidate 2's reason.
  - **chen, dana, alice and erin** add unrelated but plausible items: invoice numbering, a dropped auto-increment idea, VAT rounding, currency codes, a dropped polling idea, webhook signatures, integer cents, `{ ok, reason }` results, and no customer names in logs.
- **Extraction:** it runs once with the real pipeline (`extractContext`, Sonnet 5.5).
- **The briefs:** the real `sprintdigest context src/invoices` and `sprintdigest context src/payments` commands, run in-process against that store. Each must hold its trap's item among 6 to 8 others, and the harness checks this before the pilot.

## Brief delivery: pasted before the task

A developer runs `sprintdigest context <folder>` before starting and pastes the output above the task (D84). The "with" arm's prompt is that brief, a blank line, then the task.

## Running and isolation

This is unchanged from round 1 (D84) except for the run location.
- **Fresh state each run:** each run gets a fresh fixture copy with its own one-commit git history, and its own empty `HOME` and `CLAUDE_CONFIG_DIR`.
- **Auth and flags:** `ANTHROPIC_API_KEY`, `--strict-mcp-config` and `--setting-sources project`.
- **Model:** pinned to `claude-sonnet-5-5`, with each run's actual model recorded.
- **Limits:** `--max-turns 30` and `--max-budget-usd 1`.
- **Tools:** only `Read, Edit, Write, Glob, Grep` and `Bash` for `npm test` and `node --test`, with no web access.
- **Run location:** the copies live under this repo's gitignored `.digest/experiment/work/`. The old session scratchpad is gone, and nothing is created outside the repo.
- **Isolation check first:** one short run has to prove the init event (only built-in plugins, none of the owner's skills, no MCP servers, the API key, the pinned model). It also has to show that the owner's `~/.claude/projects` and `~/.claude.json` are unchanged, that the session landed in the run's own config directory, and that no `CLAUDE.md` or `AGENTS.md` exists at or above the run directory.
- **Hidden tests:** they live only in the harness and are written into a run's copy after the agent exits.

## Combined pilot

- **Runs:** per candidate, 3 without the brief and 1 with it, so 8 runs, interleaved.
- **Gate, per candidate:** at least 2 of its 3 no-brief runs must fall into the trap.
- **Report, per run:** trap or not, task done or not, cost, turns, model.
- **After the pilot:** it stops. The full 20 runs don't start, even if a candidate passes. The owner picks the candidate.

## Cost estimate

- **Round 1 runs:** $0.057–0.076 each, at 8–9 turns. Round 2's tasks are a little larger (CSV parsing tests, retry tests), so assume 10–14 turns at about $0.08–0.12 a run.

| Part | Typical | Ceiling |
|---|---|---|
| Brief extraction, once | $0.02 | $0.05 |
| Isolation check | $0.015 | $0.03 |
| Pilot, 8 runs | $0.65 (range $0.50–0.95) | $8 (each run capped at $1) |
| **Total** | **about $0.70** | |
| Full experiment, 20 runs (not approved) | about $2 | $20 |
