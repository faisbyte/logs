// The disclosure (Phase 12, DECISIONS.md D106): the same words in the CLI, the dashboard and docs/cost-tracking.md.

export const COST_NOTICE =
  'What is recorded: for each AI request made with your company account, the time, session id, model, token counts, estimated cost, and the repo if it is a company one (otherwise only that it was not). ' +
  'For repos with cost tracking on, also the hashes of commits made in a session. ' +
  'Never recorded: prompts, replies, commands, code, file paths, the name of any repo that is not a company one, or anything from an account your admin has not registered. ' +
  'Who sees it: you, and the managers and POs your admin has granted cost access. They can see it at any time, whether or not you share a summary. ' +
  'You see everything they see about you, and each time they look is logged.';
