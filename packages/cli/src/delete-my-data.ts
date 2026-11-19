import type { CliContext } from './cli.js';
import { connect } from './tickets.js';

// sprintdigest delete-my-data (DECISIONS.md D98): a developer deletes everything they pushed to the repo's shared store,
// and what was made only from it. Local files are left alone, and stay marked as pushed so nothing re-uploads them.

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function deleteMyDataCommand(options: { repo?: string; yes?: boolean }, ctx: CliContext): Promise<number> {
  const c = connect('delete-my-data', options.repo, ctx);
  if ('exit' in c) return c.exit;
  if (!options.yes) {
    return c.fail(
      `this permanently deletes every summary you pushed to ${c.repoId}, and what was made only from them ` +
        '(context items, and the text of digests that included them). It cannot be undone. Run it again with --yes to go ahead.',
    );
  }
  const result = await c.target.deleteMyData(c.repoId);
  if (result.status !== 'deleted') return c.fail(`the store refused the token: ${result.reason}`);
  ctx.stdout(
    [
      `Deleted your data on ${c.repoId}:`,
      `  ${count(result.summaries, 'summary', 'summaries')}`,
      `  ${count(result.ticketLinks, 'ticket link', 'ticket links')}`,
      `  ${count(result.contextItemsDeleted, 'context item', 'context items')} deleted, ${result.contextItemsEdited} edited`,
      `  ${count(result.digestsWithdrawn, 'digest', 'digests')} withdrawn, ${result.digestsDeleted} deleted`,
      "Your summaries in .digest/ on this machine are untouched, and won't be pushed again.",
      '',
    ].join('\n'),
  );
  return 0;
}
