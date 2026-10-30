import { findSummary, saveSummary, shortSessionId } from '@digest/core';
import type { CliContext } from './cli.js';
import { connect } from './tickets.js';

// sprintdigest retract (DECISIONS.md D60): the developer who pushed a summary withdraws it from the shared store.
// Locally it goes back to draft, so it can be edited, re-summarised by id, re-approved and pushed again.

export async function retractCommand(sessionId: string, options: { repo?: string }, ctx: CliContext): Promise<number> {
  const c = connect('retract', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const found = findSummary(c.repoRoot, sessionId);
  if ('error' in found) return c.fail(found.error);
  const s = found.summary;
  const short = shortSessionId(s.sessionId);
  if (!s.pushedAt) return c.fail(`${short} was never pushed; reopen or edit it locally instead.`);
  const result = await c.target.retract(c.repoId, { agent: s.agent, sessionId: s.sessionId });
  switch (result.status) {
    case 'retracted':
    case 'already':
      break;
    case 'unauthorized':
      return c.fail(`the store refused the token: ${result.reason}`);
    default:
      return c.fail(result.reason);
  }
  saveSummary(c.repoRoot, { ...s, status: 'draft', approvedAt: null, approvedBy: null, approvalHash: null, pushedAt: null });
  ctx.stdout(`Retracted ${short} from the shared store. It is a draft again: edit it, re-summarise it by id, or approve it and push again.\n`);
  return 0;
}
