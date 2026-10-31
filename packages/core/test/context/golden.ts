import { readFileSync } from 'node:fs';
import type { ContextItem } from '../../src/context/item.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import type { StoredSummary } from '../../src/shared/store.js';
import { payloadFor } from '../shared/store-contract.js';

// The golden context fixture (DECISIONS.md D79) and the checks both the offline test and the live eval run.

export const golden = JSON.parse(readFileSync(new URL('./golden-context.json', import.meta.url), 'utf8')) as {
  summaries: ({ developer: string } & Record<string, unknown>)[];
  firstRun: string[];
  expect: { decision: string; pitfall: string; superseded: { old: string; new: string }; temporary: string[]; mustNotAppear: string[] };
};
export const GOLDEN_REPO = 'github.com/acme/eval';

/** The fixture's summaries as the shared store holds them: the first run's, then the rest. */
export async function goldenSummaries(): Promise<{ store: InMemorySummaryStore; first: StoredSummary[]; rest: StoredSummary[] }> {
  const store = new InMemorySummaryStore();
  for (const { developer, ...s } of golden.summaries) await store.push({ repoId: GOLDEN_REPO, developerId: developer, developerName: developer }, payloadFor(s));
  const all = await store.list({ repoId: GOLDEN_REPO });
  return { store, first: all.filter((s) => golden.firstRun.includes(s.summary.sessionId)), rest: all.filter((s) => !golden.firstRun.includes(s.summary.sessionId)) };
}

const has = (item: ContextItem, phrase: string) => `${item.text} ${item.reason}`.toLowerCase().includes(phrase.toLowerCase());

/** What the stored items get wrong against the fixture's expectations; empty when they pass. */
export function goldenFailures(items: readonly ContextItem[]): string[] {
  const e = golden.expect;
  const active = items.filter((i) => i.status === 'active');
  const failures: string[] = [];
  if (!active.some((i) => i.type === 'decision' && has(i, e.decision))) failures.push(`no active decision mentions "${e.decision}"`);
  if (!active.some((i) => i.type === 'pitfall' && has(i, e.pitfall))) failures.push(`no active pitfall mentions "${e.pitfall}"`);
  const old = items.filter((i) => has(i, e.superseded.old) && !has(i, e.superseded.new));
  if (!old.length) failures.push(`no item about "${e.superseded.old}" was kept`);
  for (const i of old) {
    const by = items.find((x) => x.id === i.supersededBy);
    if (i.status !== 'superseded' || !by || by.status !== 'active' || !has(by, e.superseded.new)) failures.push(`${i.id} ("${e.superseded.old}") is ${i.status}, not superseded by an active item about "${e.superseded.new}"`);
  }
  for (const phrase of e.temporary) for (const i of items) if (has(i, phrase)) failures.push(`${i.id} keeps temporary "${phrase}"`);
  for (const phrase of e.mustNotAppear) for (const i of items) if (has(i, phrase)) failures.push(`${i.id} contains "${phrase}"`);
  return failures;
}
