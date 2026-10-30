import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDigestDir } from '../digest-dir.js';
import { periodId } from '../periods.js';
import { SessionSummarySchema, type SessionSummary } from '../summarize/schema.js';

// One file per session in .digest/summaries/ holds its current summary and review state (DECISIONS.md D25, D34).
// The model's first output is kept in .digest/originals/ once a developer edits it.

const fileName = (s: Pick<SessionSummary, 'agent' | 'sessionId'>) => `${s.agent}-${s.sessionId}.json`;
const json = (summary: SessionSummary) => JSON.stringify(summary, null, 2) + '\n';

export function summaryPath(repoRoot: string, s: Pick<SessionSummary, 'agent' | 'sessionId'>): string {
  return join(repoRoot, '.digest', 'summaries', fileName(s));
}

export function readSummaryFile(file: string): SessionSummary | null {
  if (!existsSync(file)) return null;
  try {
    return SessionSummarySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Approved and developer-edited summaries are never replaced by a regenerated one. */
export const isReviewed = (s: SessionSummary) => s.status === 'approved' || s.editedByDeveloper;

export function listSummaries(repoRoot: string): SessionSummary[] {
  const dir = join(repoRoot, '.digest', 'summaries');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSummaryFile(join(dir, f)))
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId));
}

export function findSummary(repoRoot: string, prefix: string): { summary: SessionSummary } | { error: string } {
  // "fe5d7843.p2" names one work period of a session (DECISIONS.md D58).
  const wanted = periodId(prefix);
  const matches = listSummaries(repoRoot).filter((s) =>
    wanted.period === null ? s.sessionId.startsWith(prefix) : periodId(s.sessionId).period === wanted.period && periodId(s.sessionId).sessionId.startsWith(wanted.sessionId),
  );
  if (matches.length === 1) return { summary: matches[0]! };
  if (matches.length === 0) return { error: `No summary matching ${prefix}. Run sprintdigest review --list to see them.` };
  return { error: `${prefix} matches ${matches.length} summaries; use more of the session id.` };
}

export function saveSummary(repoRoot: string, summary: SessionSummary): void {
  writeFileSync(join(ensureDigestDir(repoRoot, 'summaries'), fileName(summary)), json(SessionSummarySchema.parse(summary)));
}

/** Keeps the model's own output the first time a summary is edited, for future evals. */
export function saveOriginal(repoRoot: string, summary: SessionSummary): void {
  const file = join(ensureDigestDir(repoRoot, 'originals'), fileName(summary));
  if (!existsSync(file)) writeFileSync(file, json(summary));
}
