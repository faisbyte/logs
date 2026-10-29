import { listSummaries, repoIdentity, saveSummary, uploadPayload, verifyApproval, type SessionSummary } from '@digest/core';
import type { CliContext } from './cli.js';
import { resolvePushTarget } from './share.js';
import { writableRepoRoot } from './sessions.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Pushes approved, unpushed summaries. Only uploadPayload() output leaves the machine (DECISIONS.md D34, D40). */
export async function pushCommand(options: { repo?: string }, ctx: CliContext): Promise<number> {
  const fail = (message: string) => (ctx.stderr(`digest push: ${message}\n`), 1);
  const writable = writableRepoRoot(options.repo, ctx);
  if ('error' in writable) return fail(writable.error);
  const repoRoot = writable.root;
  const resolved = resolvePushTarget(ctx, repoRoot);
  if ('error' in resolved) return fail(resolved.error);
  const identity = repoIdentity(repoRoot);
  if ('error' in identity) return fail(identity.error);

  const all = listSummaries(repoRoot);
  const waiting = all.filter((s) => s.status === 'approved' && !s.pushedAt);
  const drafts = all.filter((s) => s.status === 'draft').length;
  const reviewNote = drafts ? ` ${plural(drafts, 'draft')} still ${drafts === 1 ? 'needs' : 'need'} review; rejected summaries are never pushed.` : '';
  if (waiting.length === 0) return (ctx.stdout(`Nothing to push: no approved summaries waiting.${reviewNote}\n`), 0);

  const short = (s: SessionSummary) => s.sessionId.slice(0, 8);
  let pushed = 0;
  let failed = 0;
  for (const summary of waiting) {
    let payload;
    try {
      payload = uploadPayload(verifyApproval(summary));
    } catch (err) {
      ctx.stdout(`${short(summary)}  not pushed: ${(err as Error).message}\n`);
      failed++;
      continue;
    }
    const result = await resolved.target.push(identity.repoId, payload);
    switch (result.status) {
      case 'unauthorized':
      case 'forbidden':
        return fail(`the store refused the token: ${result.reason}`);
      case 'created':
      case 'unchanged':
        saveSummary(repoRoot, { ...summary, pushedAt: new Date().toISOString() });
        ctx.stdout(`${short(summary)}  ${result.status === 'created' ? 'pushed' : 'already pushed'}\n`);
        pushed++;
        break;
      case 'conflict':
        ctx.stdout(`${short(summary)}  conflict: ${result.reason}\n`);
        failed++;
        break;
      case 'rejected':
        ctx.stdout(`${short(summary)}  rejected by the store: ${result.errors.join('; ')}\n`);
        failed++;
    }
  }
  ctx.stdout(`\nPushed ${pushed} ${pushed === 1 ? 'summary' : 'summaries'} to ${identity.repoId}.${failed ? ` ${failed} failed.` : ''}${reviewNote}\n`);
  return failed ? 1 : 0;
}
