// The disclosure (Phase 12, DECISIONS.md D106): the same words in the CLI, the dashboard and docs/cost-tracking.md.

export const COST_NOTICE =
  'What is recorded: for each AI request made with your company account, the time, session id, model, token counts, estimated cost, and whether the session was in a company repo. ' +
  'For repos with cost tracking on, also the hashes of commits made in a session. ' +
  'Never recorded: prompts, replies, commands, code, file paths, the name of any repo that is not a company one, or anything from a personal account. ' +
  'Who sees it: you, and the managers and POs your admin has granted cost access. They can see it at any time, whether or not you share a summary. ' +
  'You see everything they see about you, and each time they look is logged.';
