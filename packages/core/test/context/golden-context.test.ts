import { describe, expect, it } from 'vitest';
import { contextInput, extractContext, type ExtractedItem } from '../../src/context/extract.js';
import { FakeLlmClient } from '../../src/summarize/fake-llm.js';
import { GOLDEN_REPO, goldenFailures, goldenSummaries } from './golden.js';

// The golden context fixture through the real pipeline with scripted replies (DECISIONS.md D79): it checks the
// two-run flow and the checks the live eval uses, not the model.

const now = () => new Date('2026-03-20T12:00:00.000Z');
const reply = (items: ExtractedItem[]) => new FakeLlmClient([JSON.stringify({ items })], 'claude-sonnet-5-5');
const item = (over: Partial<ExtractedItem> & Pick<ExtractedItem, 'type' | 'text' | 'reason'>): ExtractedItem => ({ paths: ['src/auth'], sources: ['S1'], supersedes: [], ...over });

async function twoRuns(second: (fifteenMinuteId: string) => ExtractedItem[]) {
  const { store, first, rest } = await goldenSummaries();
  const one = await extractContext(contextInput(first), reply([
    item({ type: 'decision', text: 'Failed logins are counted per account rather than per IP address.', reason: 'Many users share one office network address.' }),
    item({ type: 'decision', text: 'An account locks for 15 minutes after 5 failed logins.', reason: 'Product wanted a short lockout support never has to undo.', paths: ['src/auth/lockout.ts'] }),
  ]), { now });
  await store.applyContextChanges(GOLDEN_REPO, one.changes);
  const fifteen = one.changes.added.find((i) => i.text.includes('15 minutes'))!.id;
  const two = await extractContext(contextInput(rest, await store.contextItems(GOLDEN_REPO)), reply(second(fifteen)), { now });
  await store.applyContextChanges(GOLDEN_REPO, two.changes);
  return store.contextItems(GOLDEN_REPO);
}

describe('golden context fixture', () => {
  it('passes its checks when the replies keep the decision, the pitfall and the supersession, and skip the temporary items', async () => {
    const items = await twoRuns((fifteen) => [
      item({ type: 'decision', text: 'Failed-login counters live in Redis with a time-to-live equal to the lockout window.', reason: 'All three app servers must see the same count.' }),
      item({ type: 'pitfall', text: "Keeping failed-login counters in each app server's memory was tried and dropped.", reason: 'Counts reset on every deploy and differ between servers.' }),
      item({ type: 'decision', text: 'An account locks for 30 minutes after 5 failed logins.', reason: 'The security review found 15 minutes too short.', sources: ['S2'], paths: ['src/auth/lockout.ts'], supersedes: [fifteen] }),
    ]);
    expect(goldenFailures(items)).toEqual([]);
    expect(items.filter((i) => i.status === 'active')).toHaveLength(4);
  });

  it('reports a missed supersession and a kept temporary item', async () => {
    const items = await twoRuns(() => [
      item({ type: 'pitfall', text: "Keeping failed-login counters in each app server's memory was tried and dropped.", reason: 'Counts reset on every deploy.' }),
      item({ type: 'convention', text: 'Password-reset emails go through a test mail account.', reason: 'No email provider has been picked.', paths: ['src/auth/lockout.ts'] }),
      item({ type: 'decision', text: 'Accounts now lock for 30 minutes after five failures.', reason: 'The security review asked for it.', sources: ['S2'], paths: ['src/auth/lockout.ts'] }),
    ]);
    const failures = goldenFailures(items);
    expect(failures).toEqual(expect.arrayContaining([expect.stringMatching(/\("15 minutes"\) is active, not superseded/), expect.stringMatching(/keeps temporary "test mail account"/), expect.stringMatching(/keeps temporary "email provider"/)]));
  });
});
