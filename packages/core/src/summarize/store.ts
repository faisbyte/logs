import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDigestDir } from '../digest-dir.js';
import { isReviewed, readSummaryFile, saveSummary, summaryPath } from '../review/store.js';
import type { RedactedSession } from '../redact/session.js';
import { CHUNKING_VERSION, condenseSession } from './condense.js';
import type { LlmClient } from './llm.js';
import { PROMPT_VERSION } from './prompt.js';
import { SessionSummarySchema, type SessionSummary } from './schema.js';
import type { SummarizeSettings } from './settings.js';
import { summarizeSession, type SummaryTrace } from './summarize.js';

// Summaries live in .digest/ (gitignored): a cache keyed by what produced them, and the latest
// draft per session for review (DECISIONS.md D25). Nothing is uploaded.

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const cacheKey = (k: { sessionId: string; contentHash: string; promptVersion: string; model: string }) =>
  sha256(JSON.stringify([k.sessionId, k.contentHash, k.promptVersion, k.model]));

/** Hash of exactly what the model would be sent: the condensed, redacted session and how it is chunked. */
export const contentHash = (redacted: RedactedSession, chunkTokens: number) => sha256(JSON.stringify([condenseSession(redacted), chunkTokens, CHUNKING_VERSION]));

const cacheFile = (repoRoot: string, key: string) => join(repoRoot, '.digest', 'cache', 'summaries', `${key}.json`);

export function readCachedSummary(repoRoot: string, key: string): SessionSummary | null {
  const file = cacheFile(repoRoot, key);
  if (!existsSync(file)) return null;
  try {
    return SessionSummarySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null; // an unreadable entry is just a miss
  }
}

export class ReviewedSummaryError extends Error {}

/** Caches a generated summary and makes it the session's draft, unless the current one has been reviewed (D35). */
export function writeSummary(repoRoot: string, key: string, summary: SessionSummary): void {
  const current = readSummaryFile(summaryPath(repoRoot, summary));
  if (current && isReviewed(current)) {
    const what = current.status === 'approved' ? 'approved' : 'edited';
    throw new ReviewedSummaryError(`${summary.sessionId} has an ${what} summary, which is never overwritten by a regenerated one.`);
  }
  writeFileSync(join(ensureDigestDir(repoRoot, 'cache', 'summaries'), `${key}.json`), JSON.stringify(summary, null, 2) + '\n');
  saveSummary(repoRoot, summary);
}

/** One line per generated summary in .digest/usage.jsonl: tokens and cost, plus each part's output and every retry's errors. */
function logUsage(repoRoot: string, summary: SessionSummary, trace: SummaryTrace): void {
  const { sessionId, model, promptVersion, generatedAt, usage } = summary;
  appendFileSync(join(ensureDigestDir(repoRoot), 'usage.jsonl'), JSON.stringify({ sessionId, model, promptVersion, generatedAt, ...usage, ...trace }) + '\n');
}

/** Summarises a session unless an identical request was summarised before. */
export async function summarizeCached(
  repoRoot: string,
  redacted: RedactedSession,
  llm: LlmClient,
  settings: SummarizeSettings,
  now: () => Date = () => new Date(),
): Promise<{ summary: SessionSummary; cached: boolean }> {
  const key = cacheKey({
    sessionId: redacted.session.sourceSessionId,
    contentHash: contentHash(redacted, settings.chunkTokens),
    promptVersion: PROMPT_VERSION,
    model: llm.model,
  });
  const hit = readCachedSummary(repoRoot, key);
  if (hit) return { summary: hit, cached: true };

  const trace: SummaryTrace = { parts: [], merge: null, retries: [] };
  const summary = await summarizeSession(redacted, llm, { chunkTokens: settings.chunkTokens, now, trace });
  writeSummary(repoRoot, key, summary);
  logUsage(repoRoot, summary, trace);
  return { summary, cached: false };
}
