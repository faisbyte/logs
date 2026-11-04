import { contextInput, ContextError, costCapRefusal, digestSummaryKey, estimateContextCost, extractContext, type DigestDeps, type StoredSummary } from '@digest/core';

// Context distillation on the server (DECISIONS.md D74 option B, D82). `sprintdigest-server context distill`, run by
// cron like `digest send-due`, reads every repo's approved summaries that no run has read yet (by key and payload
// hash), oldest first, in batches, under the same monthly cost cap as digests. Running it again changes nothing.

export interface DistillDeps extends Omit<DigestDeps, 'jargon'> {
  /** Summaries per model call; the default keeps a call well under the summariser's chunk size. */
  batchSize?: number;
}

export interface DistillResult {
  repoId: string;
  result: string;
}

export const DISTILL_BATCH = 4;
const NO_KEY = 'not run: the server has no ANTHROPIC_API_KEY';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const key = (s: StoredSummary) => `${digestSummaryKey(s.summary)}\n${s.payloadHash}`;

async function distillRepo(deps: DistillDeps, repoId: string): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const done = new Set((await deps.store.distilledSummaries(repoId)).map((s) => `${s.key}\n${s.payloadHash}`));
  const pending = (await deps.store.list({ repoId })).filter((s) => !done.has(key(s)));
  if (!pending.length) return 'nothing new';
  if (!deps.llm) return NO_KEY;

  const size = deps.batchSize ?? DISTILL_BATCH;
  const total = { summaries: 0, calls: 0, added: 0, merged: 0, superseded: 0, dropped: 0, untraced: 0, cost: 0 };
  const retries: string[] = [];
  const line = () =>
    `distilled ${count(total.summaries, 'summary', 'summaries')} in ${count(total.calls, 'call', 'calls')}: ${total.added} added, ${total.merged} merged, ${total.superseded} superseded, ${total.dropped} dropped${total.untraced ? ` (${total.untraced} untraced)` : ''}, $${total.cost.toFixed(4)}` +
    (retries.length ? `; retried ${retries.length === 1 ? 'once' : `${retries.length} times`}: ${retries.join('; ')}` : '');

  for (let i = 0; i < pending.length; i += size) {
    const batch = pending.slice(i, i + size);
    // Each call sees the items earlier calls in this run just stored.
    const input = contextInput(batch, await deps.store.contextItems(repoId));
    const refusal = await costCapRefusal(deps, repoId, estimateContextCost(input, deps.model).costUsd, 'this distillation call');
    if (refusal) return total.calls ? `${line()}; then not run: ${refusal}` : `not run: ${refusal}`;
    let extraction;
    try {
      extraction = await extractContext(input, deps.llm, { now });
    } catch (err) {
      if (err instanceof ContextError && err.usage?.costUsd) await deps.store.recordSpend(repoId, err.usage.costUsd, now().toISOString());
      const failed = `failed: ${(err as Error).message}`;
      return total.calls ? `${line()}; then ${failed}` : failed;
    }
    const at = now().toISOString();
    if (extraction.usage.costUsd) await deps.store.recordSpend(repoId, extraction.usage.costUsd, at);
    const { changes } = extraction;
    await deps.store.applyContextChanges(repoId, changes, {
      repoId,
      at,
      model: extraction.model,
      promptVersion: extraction.promptVersion,
      summaries: batch.map((s) => ({ key: digestSummaryKey(s.summary), payloadHash: s.payloadHash })),
      added: changes.added.length,
      merged: changes.merged.length,
      superseded: changes.superseded.length,
      dropped: extraction.dropped,
      untraced: extraction.untraced,
      retryReasons: extraction.retryReasons,
      costUsd: extraction.usage.costUsd,
    });
    Object.assign(total, {
      summaries: total.summaries + batch.length,
      calls: total.calls + 1,
      added: total.added + changes.added.length,
      merged: total.merged + changes.merged.length,
      superseded: total.superseded + changes.superseded.length,
      dropped: total.dropped + extraction.dropped.length,
      untraced: total.untraced + extraction.untraced,
      cost: total.cost + (extraction.usage.costUsd ?? 0),
    });
    retries.push(...(extraction.retried ? [extraction.retryReasons.join('; ')] : []));
  }
  return line();
}

/** One pass over every repo with shared summaries. */
export async function distill(deps: DistillDeps): Promise<DistillResult[]> {
  const results: DistillResult[] = [];
  for (const repoId of await deps.store.contextRepos()) results.push({ repoId, result: await distillRepo(deps, repoId) });
  return results;
}

/** Whether a distill result means summaries were left unread, so cron should alert. */
export const distillNeedsAttention = (result: string) => /^(not run|failed)|; then (not run|failed)/.test(result);
