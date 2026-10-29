import { repoIdentity } from '@digest/core';
import type { CliContext } from './cli.js';
import { pushCommand } from './push.js';
import { reviewDrafts } from './review.js';
import { resolvePushTarget } from './share.js';
import { writableRepoRoot } from './sessions.js';
import { summarizeCommand } from './summarize.js';

/** discover → summarise → review → push, stopping at the first step that fails or is declined (DECISIONS.md D42). */
export async function syncCommand(options: { repo?: string }, ctx: CliContext): Promise<number> {
  const fail = (message: string) => (ctx.stderr(`digest sync: ${message}\n`), 1);
  // Everything that would stop the run later is checked before any money is spent.
  const writable = writableRepoRoot(options.repo, ctx);
  if ('error' in writable) return fail(writable.error);
  const target = resolvePushTarget(ctx, writable.root);
  if ('error' in target) return fail(target.error);
  const identity = repoIdentity(writable.root);
  if ('error' in identity) return fail(identity.error);
  if (!ctx.ask) return fail('the review step needs a terminal. Run digest summarize, digest approve and digest push instead.');
  const repo = writable.root;

  ctx.stdout('Step 1 of 3: summarise new sessions\n');
  await summarizeCommand(undefined, { all: true, estimate: true, repo }, ctx);
  if ((await summarizeCommand(undefined, { all: true, repo }, ctx)) !== 0) return fail('stopped after summarising; nothing was pushed.');

  ctx.stdout('\nStep 2 of 3: review drafts\n');
  const review = await reviewDrafts({ repo }, ctx);
  if (review.code !== 0) return review.code;
  if (review.quit) return (ctx.stdout('You quit the review, so nothing was pushed.\n'), 0);

  ctx.stdout('\nStep 3 of 3: push approved summaries\n');
  return pushCommand({ repo }, ctx);
}
