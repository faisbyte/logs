import { DigestError, estimateDigestCost, generateDigest, type Digest } from '../digest/generate.js';
import { digestInput, type DigestInput } from '../digest/input.js';
import { DIGEST_PROMPT_VERSION } from '../digest/prompt.js';
import type { LlmClient } from '../summarize/llm.js';
import type { DigestStore, NewDigest, StoredDigest } from './digests.js';
import { reportSummaryKeys, ticketReport, type TicketReportFilter } from './ticket-report.js';
import type { SharedStore } from './tickets.js';

// Digests written on the server (DECISIONS.md D53): on-demand reports for any sprint or date range, cached, and
// every model call under a per-repo monthly cost cap.

export interface DigestDeps {
  store: SharedStore & DigestStore;
  /** null when the server has no API key: cached reports are still served. */
  llm: LlmClient | null;
  model: string;
  defaultCapUsd: number;
  now?: () => Date;
  /** Terms the digest must explain or avoid; the built-in list when absent (D68). */
  jargon?: readonly string[];
}

export type ReportResult =
  | { status: 'ok'; digest: StoredDigest; cached: boolean }
  | { status: 'cap-reached' | 'unavailable' | 'failed'; reason: string };

export const periodKey = (filter: TicketReportFilter) => ('sprint' in filter ? `sprint:${filter.sprint}` : `range:${filter.from}/${filter.to}`);
export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

const dollars = (n: number) => `$${n.toFixed(2)}`;
const isEmpty = (input: DigestInput) => input.tickets.length === 0 && input.unlinked.length === 0;
const NO_KEY = 'The digest server has no ANTHROPIC_API_KEY, so it can only serve reports it has already written.';

/** null when the call fits under the cap; otherwise why not. */
export async function capRefusal(deps: DigestDeps, repoId: string, input: DigestInput, what: string): Promise<string | null> {
  const estimate = estimateDigestCost(input, deps.model).costUsd;
  if (estimate === 0) return null;
  if (estimate === null) return `There is no known price for ${deps.model}, so the monthly cost cap can't be applied; set DIGEST_MODEL to a priced model.`;
  const now = (deps.now ?? (() => new Date()))();
  const since = monthStart(now);
  const settings = await deps.store.repoSettings(repoId);
  const cap = settings.monthlyCapUsd ?? deps.defaultCapUsd;
  const spent = await deps.store.spendSince(repoId, since);
  if (spent + estimate <= cap) return null;
  return `This repo has reached its monthly LLM cost cap: ${dollars(spent)} of ${dollars(cap)} spent since ${since.slice(0, 10)} (UTC), and ${what} could cost up to ${dollars(estimate)}. A sprintdigest-server admin can raise it with sprintdigest-server repo --cap-usd.`;
}

/** Writes a digest for an input, recording its cost whether or not it passed its checks. */
export async function writeDigest(deps: DigestDeps, repoId: string, input: DigestInput): Promise<Digest> {
  const now = deps.now ?? (() => new Date());
  const llm: LlmClient = deps.llm ?? {
    model: deps.model,
    complete: () => Promise.reject(new DigestError(NO_KEY)),
  };
  try {
    const digest = await generateDigest(input, llm, { now, ...(deps.jargon ? { jargon: deps.jargon } : {}) });
    if (digest.usage.costUsd) await deps.store.recordSpend(repoId, digest.usage.costUsd, now().toISOString());
    return digest;
  } catch (err) {
    if (err instanceof DigestError && err.usage?.costUsd) await deps.store.recordSpend(repoId, err.usage.costUsd, now().toISOString());
    throw err;
  }
}

export function storedFields(repoId: string, digest: Digest, summaryKeys: string[]): Omit<NewDigest, 'kind' | 'periodKey' | 'status' | 'previewUntil'> {
  return {
    repoId,
    summaryKeys,
    periodLabel: digest.period.label,
    from: digest.period.from,
    to: digest.period.to,
    inputHash: digest.inputHash,
    promptVersion: digest.promptVersion,
    model: digest.model,
    markdown: digest.markdown,
    summaryCount: digest.coverage.summaryCount,
    developerCount: digest.coverage.developerCount,
    costUsd: digest.usage.costUsd,
    createdAt: digest.generatedAt,
    warnings: digest.warnings,
    jargonRetried: digest.jargonRetried,
  };
}

/** A report for any sprint or date range, for readers and developers alike. */
export async function onDemandReport(deps: DigestDeps, repoId: string, filter: TicketReportFilter): Promise<ReportResult> {
  const report = await ticketReport(deps.store, repoId, filter);
  const input = digestInput(report);
  const key = { periodKey: periodKey(filter), inputHash: input.hash, promptVersion: DIGEST_PROMPT_VERSION, model: deps.model };
  const cached = await deps.store.findReport(repoId, key);
  if (cached) return { status: 'ok', digest: cached, cached: true };
  if (!deps.llm && !isEmpty(input)) return { status: 'unavailable', reason: NO_KEY };
  const refusal = await capRefusal(deps, repoId, input, 'this report');
  if (refusal) return { status: 'cap-reached', reason: refusal };
  let digest: Digest;
  try {
    digest = await writeDigest(deps, repoId, input);
  } catch (err) {
    if (err instanceof DigestError) return { status: 'failed', reason: err.message };
    throw err;
  }
  const stored = await deps.store.saveDigest({ ...storedFields(repoId, digest, reportSummaryKeys(report)), kind: 'report', periodKey: key.periodKey, status: 'ready', previewUntil: null });
  return { status: 'ok', digest: stored, cached: false };
}
