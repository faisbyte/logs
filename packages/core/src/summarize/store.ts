import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDigestDir } from '../digest-dir.js';
import type { RedactedSession } from '../redact/session.js';
import { condenseSession } from './condense.js';
import type { LlmClient } from './llm.js';
import { PROMPT_VERSION } from './prompt.js';
import { SessionSummarySchema, type SessionSummary } from './schema.js';
import type { SummarizeSettings } from './settings.js';
import { summarizeSession } from './summarize.js';

// Summaries live in .digest/ (gitignored): a cache keyed by what produced them, and the latest
// draft per session for review (DECISIONS.md D25). Nothing is uploaded.

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const cacheKey = (k: { sessionId: string; contentHash: string; promptVersion: string; model: string }) =>
  sha256(JSON.stringify([k.sessionId, k.contentHash, k.promptVersion, k.model]));

/** Hash of exactly what the model would be sent: the condensed, redacted session and how it is chunked. */
export const contentHash = (redacted: RedactedSession, chunkTokens: number) => sha256(JSON.stringify([condenseSession(redacted), chunkTokens]));

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

export function writeSummary(repoRoot: string, key: string, summary: SessionSummary): void {
  const json = JSON.stringify(summary, null, 2) + '\n';
  writeFileSync(join(ensureDigestDir(repoRoot, 'cache', 'summaries'), `${key}.json`), json);
  writeFileSync(join(ensureDigestDir(repoRoot, 'summaries'), `${summary.agent}-${summary.sessionId}.json`), json);
}

function logUsage(repoRoot: string, summary: SessionSummary): void {
  const { sessionId, model, promptVersion, generatedAt, usage } = summary;
  appendFileSync(join(ensureDigestDir(repoRoot), 'usage.jsonl'), JSON.stringify({ sessionId, model, promptVersion, generatedAt, ...usage }) + '\n');
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

  const summary = await summarizeSession(redacted, llm, { chunkTokens: settings.chunkTokens, now });
  writeSummary(repoRoot, key, summary);
  logUsage(repoRoot, summary);
  return { summary, cached: false };
}
