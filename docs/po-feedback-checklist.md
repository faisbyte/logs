# Digest feedback session: checklist

For the session that tests Phase 7's "Done when": a real sprint's digest, read by a product owner or scrum master who is not technical. Plan for about 30 minutes, with a facilitator taking notes.

## Before the session

- [ ] Pick one finished sprint with at least 5 approved, pushed summaries from at least 2 developers.
- [ ] Generate its digest (`digest report --sprint <name> --out digest.md`, or `POST /v1/reports`) and read it yourself first.
- [ ] Ask one developer who worked in that sprint to mark anything wrong or misleading in the digest. Fix nothing yet: record it.
- [ ] Deliver it the way the PO or SM would really get it: Slack or email.
- [ ] Don't explain the tool, AI involvement levels or the coverage line beforehand. The digest has to stand on its own.

## During the session

Ask them to read the digest once, thinking aloud. Then go through these in order. Note their words, not your summary of them.

**Understanding**
- [ ] For each ticket section: "In your own words, what happened here?" Note whether each answer is right, partly right or wrong.
- [ ] "Were there words or phrases you didn't understand?" Note each one.
- [ ] "What does 'AI involvement: heavy' (or moderate, or light) tell you?" Does it match what the level means?
- [ ] "What does the line at the bottom ('Based on N summaries that M developers chose to share') tell you?" Do they read it as complete or partial coverage?

**Trust**
- [ ] "Is anything here surprising, or different from what you heard in stand-ups or reviews?" Check each item against the developer's notes.
- [ ] "Would you repeat anything from this to your manager or a client as it stands?"

**Usefulness**
- [ ] "Which part would you act on, if any?" Ask especially about "Risks and open questions".
- [ ] "What would you want that isn't here?"
- [ ] "What could be cut?" Is the length right for a sprint?
- [ ] "Today, how do you find out what AI was used for in a sprint, and how long does that take?"
- [ ] "Would you rather get this weekly, at the end of each sprint, or only when you ask?" And by Slack or by email?

**Comfort** (ask the developer separately)
- [ ] "Does anything here feel like it judges you or a colleague?"
- [ ] "Did anything shared surprise you?"

## Passing the "Done when"

Agree on the bar before the session. A suggested one:

- [ ] Every ticket section is understood correctly, or partly understood with no misunderstanding that matters.
- [ ] Any unexplained word has an obvious fix (a prompt or wording change), not a structural problem.
- [ ] The developer found no wrong or invented facts. One slight overstatement is acceptable if it's logged for the prompt.
- [ ] They would use it, or use it with changes they named.

## Afterwards

- [ ] Write the notes into a short summary: what worked, each misunderstanding, each error, requested changes.
- [ ] Turn errors into golden-eval cases (`packages/core/test/digest/golden-sprint.json` shows the format) before changing the prompt.
- [ ] Record in DECISIONS.md whether "Done when" passed, with the evidence.
