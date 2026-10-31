import type { PushIdentity } from '../shared/store.js';
import type { ContextChanges } from './extract.js';
import { itemProblems, type ContextItem, type ContextItemStatus } from './item.js';

// Stored context items (DECISIONS.md D77). Items are never deleted: superseded and retired ones stay, so a retired
// item can't come back and the history of a decision stays readable. Developers only; readers get 403 (D51).

export type RetireResult = { status: 'retired' | 'already'; retiredAt: string } | { status: 'not-found' };

export interface ContextStore {
  /** Newest first (by date, then id). */
  contextItems(repoId: string, filter?: { statuses?: ContextItemStatus[] }): Promise<ContextItem[]>;
  /**
   * Applies one extraction's changes at once, after the safety check (D76): an unsafe added item refuses the whole
   * change. An added item whose id is already stored is skipped; merges and supersessions touch active items only.
   */
  applyContextChanges(repoId: string, changes: ContextChanges): Promise<void>;
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

export const byNewest = (a: ContextItem, b: ContextItem) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id);

/** Whether every source of an item is a summary that is currently retracted (D77). */
export const allSourcesRetracted = (item: ContextItem, retracted: (key: string) => boolean) => item.sources.length > 0 && item.sources.every(retracted);
