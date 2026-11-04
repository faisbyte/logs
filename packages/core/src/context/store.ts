import type { PushIdentity } from '../shared/store.js';
import type { ContextChanges } from './extract.js';
import { itemProblems, type ContextItem, type ContextItemStatus } from './item.js';

// Stored context items (DECISIONS.md D77). Items are never deleted: superseded and retired ones stay, so a retired
// item can't come back and the history of a decision stays readable. Developers only; readers get 403 (D51).

export type RetireResult = { status: 'retired' | 'already'; retiredAt: string } | { status: 'not-found' };

/** One distillation run (D82): what it read, what it changed, why it retried and what it cost. */
export interface ContextRun {
  repoId: string;
  at: string;
  model: string;
  promptVersion: string;
  /** The summaries it read, with the payload hash, so a changed re-push is read again. */
  summaries: { key: string; payloadHash: string }[];
  added: number;
  merged: number;
  superseded: number;
  dropped: string[];
  /** Of those, pitfalls and decisions nothing in their sources backs (D86). */
  untraced: number;
  retryReasons: string[];
  costUsd: number | null;
}

export interface ContextStore {
  /** Newest first (by date, then id). */
  contextItems(repoId: string, filter?: { statuses?: ContextItemStatus[] }): Promise<ContextItem[]>;
  /**
   * Applies one extraction's changes at once, after the safety check (D76): an unsafe added item refuses the whole
   * change. An added item whose id is already stored is skipped; merges and supersessions touch active items only.
   * With a run, the run is recorded in the same step (D82).
   */
  applyContextChanges(repoId: string, changes: ContextChanges, run?: ContextRun): Promise<void>;
  /** Distillation runs, newest first. */
  contextRuns(repoId: string): Promise<ContextRun[]>;
  /** Every summary a run has read, by key then hash. */
  distilledSummaries(repoId: string): Promise<{ key: string; payloadHash: string }[]>;
  /** Repos with at least one pushed summary that is not retracted, sorted. */
  contextRepos(): Promise<string[]>;
  /** Any developer on the repo can retire an item; retired items never come back automatically. */
  retireContextItem(identity: PushIdentity, id: string): Promise<RetireResult>;
}

export class ContextBlockedError extends Error {}

/** The checks every ContextStore runs before keeping items. */
export function checkContextChanges(repoId: string, changes: ContextChanges): void {
  const problems = changes.added.flatMap((item, i) => [
    ...(item.repoId === repoId ? [] : [`items.${i}: belongs to another repo`]),
    ...itemProblems(item).map((p) => `items.${i}: ${p}`),
  ]);
  if (problems.length) throw new ContextBlockedError(`Context items refused: ${problems.join('; ')}.`);
}

const bySummary = (a: { key: string; payloadHash: string }, b: { key: string; payloadHash: string }) => a.key.localeCompare(b.key) || a.payloadHash.localeCompare(b.payloadHash);

/** The distinct summaries a list of runs read. */
export function runSummaries(runs: readonly ContextRun[]): { key: string; payloadHash: string }[] {
  const seen = new Map(runs.flatMap((r) => r.summaries).map((s) => [`${s.key}\n${s.payloadHash}`, s]));
  return [...seen.values()].map((s) => ({ key: s.key, payloadHash: s.payloadHash })).sort(bySummary);
}

export const byNewest = (a: ContextItem, b: ContextItem) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id);

/** Whether every source of an item is a summary that is currently retracted (D77). */
export const allSourcesRetracted = (item: ContextItem, retracted: (key: string) => boolean) => item.sources.length > 0 && item.sources.every(retracted);
