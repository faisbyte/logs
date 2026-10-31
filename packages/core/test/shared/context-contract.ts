import { beforeEach, describe, expect, it } from 'vitest';
import type { ContextItem } from '../../src/context/item.js';
import { ContextBlockedError, type ContextStore } from '../../src/context/store.js';
import type { SharedStore } from '../../src/shared/tickets.js';
import { payloadFor } from './store-contract.js';

// Every ContextStore implementation must pass these (DECISIONS.md D77). Call from each implementation's test file.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
const fakeGithub = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

export const contextItem = (over: Partial<ContextItem> = {}): ContextItem => ({
  id: 'ctx-0000000a', repoId: REPO, type: 'pitfall', text: 'Counting failed logins in memory was tried and dropped.', reason: 'The counts reset on every deploy.',
  paths: ['src/auth/lockout.ts'], tickets: ['PROJ-2'], sources: ['claude-code/b2'], date: '2026-03-10', status: 'active',
  supersededBy: null, retiredBy: null, retiredAt: null, createdAt: '2026-03-20T12:00:00.000Z', ...over,
});
const none = { added: [], merged: [], superseded: [] };

export function contextStoreContract(name: string, make: () => Promise<SharedStore & ContextStore> | (SharedStore & ContextStore)) {
  describe(`${name}: ContextStore contract`, () => {
    let store: SharedStore & ContextStore;
    beforeEach(async () => {
      store = await make();
    });

    it('stores new items and lists them by status, newest first', async () => {
      const older = contextItem({ id: 'ctx-0000000b', type: 'decision', text: 'Accounts lock after 3 failed logins.', reason: 'Security asked for it.', date: '2026-03-03' });
      await store.applyContextChanges(REPO, { ...none, added: [older, contextItem()] });
      expect(await store.contextItems(REPO)).toEqual([contextItem(), older]);
      expect(await store.contextItems(REPO, { statuses: ['retired'] })).toEqual([]);
      expect(await store.contextItems('github.com/other/repo')).toEqual([]);
    });

    it('keeps the stored item when an added one has the same id', async () => {
      await store.applyContextChanges(REPO, { ...none, added: [contextItem()] });
      await store.applyContextChanges(REPO, { ...none, added: [contextItem({ reason: 'Different.' })] });
      expect((await store.contextItems(REPO)).map((i) => i.reason)).toEqual(['The counts reset on every deploy.']);
    });

    it('adds sources to an active item, and marks one superseded without deleting it', async () => {
      const old = contextItem({ id: 'ctx-0000000b', type: 'decision', text: 'Accounts lock after 3 failed logins.', reason: 'Security asked for it.', date: '2026-03-03' });
      await store.applyContextChanges(REPO, { ...none, added: [old, contextItem()] });
      const newer = contextItem({ id: 'ctx-0000000c', type: 'decision', text: 'Accounts lock after 5 failed logins.', reason: 'Fewer support calls.', date: '2026-03-12' });
      await store.applyContextChanges(REPO, {
        added: [newer],
        merged: [{ id: 'ctx-0000000a', sources: ['claude-code/a1', 'claude-code/b2'], paths: ['src/auth/lockout.ts', 'src/auth'], tickets: ['PROJ-1', 'PROJ-2'], date: '2026-03-12' }],
        superseded: [{ id: old.id, by: newer.id }],
      });
      expect(await store.contextItems(REPO, { statuses: ['superseded'] })).toEqual([{ ...old, status: 'superseded', supersededBy: newer.id }]);
      expect((await store.contextItems(REPO, { statuses: ['active'] })).find((i) => i.id === 'ctx-0000000a')).toMatchObject({ sources: ['claude-code/a1', 'claude-code/b2'], paths: ['src/auth/lockout.ts', 'src/auth'], tickets: ['PROJ-1', 'PROJ-2'], date: '2026-03-12' });
    });

    it('changes only active items when merging or superseding', async () => {
      await store.applyContextChanges(REPO, { ...none, added: [contextItem()] });
      await store.retireContextItem(alice, 'ctx-0000000a');
      await store.applyContextChanges(REPO, { added: [], merged: [{ id: 'ctx-0000000a', sources: ['claude-code/x'], paths: [], tickets: [], date: '2026-04-01' }], superseded: [{ id: 'ctx-0000000a', by: 'ctx-0000000f' }] });
      expect(await store.contextItems(REPO)).toEqual([expect.objectContaining({ status: 'retired', sources: ['claude-code/b2'], supersededBy: null })]);
    });

    it('refuses to store an unsafe item, and stores nothing from that change (DECISIONS.md D76)', async () => {
      const leaky = contextItem({ id: 'ctx-0000000d', reason: `The CI token is ${fakeGithub}.` });
      await expect(store.applyContextChanges(REPO, { ...none, added: [contextItem(), leaky] })).rejects.toThrow(ContextBlockedError);
      await expect(store.applyContextChanges(REPO, { ...none, added: [contextItem(), leaky] })).rejects.toThrow(/items.1: reason: contains a secret \(github_token\)/);
      expect(await store.contextItems(REPO)).toEqual([]);
    });

    it('lets any developer on the repo retire an item, once, recording who and when', async () => {
      await store.applyContextChanges(REPO, { ...none, added: [contextItem()] });
      const result = await store.retireContextItem(bob, 'ctx-0000000a');
      expect(result).toEqual({ status: 'retired', retiredAt: expect.any(String) });
      expect(await store.contextItems(REPO)).toEqual([{ ...contextItem(), status: 'retired', retiredBy: 'bob', retiredAt: (result as { retiredAt: string }).retiredAt }]);
      expect(await store.retireContextItem(alice, 'ctx-0000000a')).toEqual({ status: 'already', retiredAt: (result as { retiredAt: string }).retiredAt });
      expect(await store.retireContextItem(alice, 'ctx-99999999')).toEqual({ status: 'not-found' });
      expect(await store.retireContextItem({ ...alice, repoId: 'github.com/other/repo' }, 'ctx-0000000a')).toEqual({ status: 'not-found' });
    });

    it('retires items whose every source summary was retracted, and keeps items that still have one', async () => {
      await store.push(alice, payloadFor({ sessionId: 'a1' }));
      await store.push(bob, payloadFor({ sessionId: 'b2' }));
      const onlyA = contextItem({ id: 'ctx-0000000e', sources: ['claude-code/a1'] });
      const both = contextItem({ id: 'ctx-0000000f', type: 'decision', text: 'Lockout state is stored per account.', reason: 'Two devices share it.', sources: ['claude-code/a1', 'claude-code/b2'] });
      await store.applyContextChanges(REPO, { ...none, added: [onlyA, both] });
      await store.retract(alice, { agent: 'claude-code', sessionId: 'a1' });
      expect((await store.contextItems(REPO)).map((i) => [i.id, i.status, i.retiredBy])).toEqual([
        ['ctx-0000000e', 'retired', 'retraction'],
        ['ctx-0000000f', 'active', null],
      ]);
      await store.retract(bob, { agent: 'claude-code', sessionId: 'b2' });
      expect((await store.contextItems(REPO, { statuses: ['active'] }))).toEqual([]);
      // A new push of a retracted session doesn't bring its items back (D77).
      await store.push(alice, payloadFor({ sessionId: 'a1', goal: 'Corrected.' }));
      expect((await store.contextItems(REPO, { statuses: ['active'] }))).toEqual([]);
    });
  });
}
