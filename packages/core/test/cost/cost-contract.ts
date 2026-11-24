import { beforeEach, describe, expect, it } from 'vitest';
import type { CostRecord } from '../../src/cost/store.js';
import type { SharedStore } from '../../src/shared/tickets.js';

// Cost records, commits, flags and admin settings (Phase 12, D107). Every store implementation must pass these.

export const REPO = 'github.com/acme/webapp';
const OTHER = 'github.com/acme/other';

export const costRecord = (over: Partial<CostRecord> = {}): CostRecord => ({
  key: 'k1',
  at: '2026-04-07T10:00:00.000Z',
  developerId: 'alice',
  developerName: 'Alice',
  agent: 'claude-code',
  sessionId: 's1',
  model: 'claude-opus-5-5',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 2_000_000_000_000,
  cacheWriteTokens: 300,
  costMicros: 250_000,
  billing: 'subscription',
  place: 'company',
  repoId: REPO,
  ...over,
});

const at = '2026-04-08T09:00:00.000Z';
const flag = (over: object = {}) => ({ repoId: REPO, agent: 'claude-code' as const, sessionId: 's1', developerId: 'alice', flaggedBy: 'pat', flaggedByName: 'Pat (PO)', flaggedAt: at, ...over });
const note = (text: string, over: object = {}) => ({ by: 'pat', name: 'Pat (PO)', role: 'reader' as const, at, text, ...over });

export function costContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: cost`, () => {
    let store: SharedStore;
    beforeEach(async () => {
      store = await make();
    });

    it('keeps each usage record once, returning how many were new', async () => {
      expect(await store.recordUsage([costRecord(), costRecord({ key: 'k2', costMicros: null, billing: null, place: 'outside', repoId: null })])).toBe(2);
      expect(await store.recordUsage([costRecord({ costMicros: 1 }), costRecord({ key: 'k3' }), costRecord({ key: 'k3' })])).toBe(1);
      expect(await store.recordUsage([])).toBe(0);
      const all = await store.usage({ developerIds: ['alice'], from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' });
      expect(all).toEqual([costRecord(), costRecord({ key: 'k2', costMicros: null, billing: null, place: 'outside', repoId: null }), costRecord({ key: 'k3' })]);
    });

    it('lists the asked developers’ usage in [from, to), oldest first', async () => {
      await store.recordUsage([
        costRecord({ key: 'late', at: '2026-04-09T00:00:00.000Z' }),
        costRecord({ key: 'end', at: '2026-04-10T00:00:00.000Z' }),
        costRecord({ key: 'start', at: '2026-04-07T00:00:00.000Z' }),
        costRecord({ key: 'before', at: '2026-04-06T23:59:59.999Z' }),
        costRecord({ key: 'bob', at: '2026-04-08T00:00:00.000Z', developerId: 'bob' }),
      ]);
      const keys = async (developerIds: string[]) => (await store.usage({ developerIds, from: '2026-04-07T00:00:00.000Z', to: '2026-04-10T00:00:00.000Z' })).map((r) => r.key);
      expect(await keys(['alice'])).toEqual(['start', 'late']);
      expect(await keys(['alice', 'bob'])).toEqual(['start', 'bob', 'late']);
      expect(await keys([])).toEqual([]);
    });

    it('deletes usage before a time, and everything about one developer', async () => {
      await store.recordUsage([costRecord({ key: 'old', at: '2025-01-01T00:00:00.000Z' }), costRecord({ key: 'new' }), costRecord({ key: 'bob', developerId: 'bob' })]);
      expect(await store.purgeUsageBefore('2026-01-01T00:00:00.000Z')).toBe(1);
      await store.saveCommit({ repoId: REPO, agent: 'claude-code', sessionId: 's1', developerId: 'alice', sha: 'a'.repeat(40), at });
      await store.saveFlag(flag(), note('Is this ours?'));
      expect(await store.deleteCostData('alice')).toEqual({ records: 1, commits: 1, flags: 1 });
      expect(await store.usage({ developerIds: ['alice', 'bob'], from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' })).toMatchObject([{ key: 'bob' }]);
      expect(await store.commits({ developerIds: ['alice'] })).toEqual([]);
      expect(await store.flags(REPO)).toEqual([]);
    });

    it('retention also deletes the commits and flags that are older', async () => {
      await store.saveCommit({ repoId: REPO, agent: 'claude-code', sessionId: 's1', developerId: 'alice', sha: 'a'.repeat(40), at });
      await store.saveFlag(flag(), null);
      await store.purgeUsageBefore('2026-04-08T00:00:00.000Z');
      expect(await store.flags(REPO)).toHaveLength(1);
      await store.purgeUsageBefore('2027-01-01T00:00:00.000Z');
      expect(await store.flags(REPO)).toEqual([]);
      expect(await store.commits({ developerIds: ['alice'] })).toEqual([]);
    });

    it('keeps a commit once per repo, oldest first', async () => {
      const c = { repoId: REPO, agent: 'claude-code' as const, sessionId: 's1', developerId: 'alice', sha: 'b'.repeat(40), at };
      expect(await store.saveCommit(c)).toBe(true);
      expect(await store.saveCommit({ ...c, sessionId: 's2' })).toBe(false);
      expect(await store.saveCommit({ ...c, repoId: OTHER })).toBe(true);
      expect(await store.saveCommit({ ...c, sha: 'a'.repeat(40), at: '2026-04-07T09:00:00.000Z' })).toBe(true);
      expect((await store.commits({ developerIds: ['alice'] })).map((x) => [x.repoId, x.sha[0]])).toEqual([[REPO, 'a'], [OTHER, 'b'], [REPO, 'b']]);
      expect(await store.commits({ developerIds: ['bob'] })).toEqual([]);
    });

    it('keeps a flag with its notes, in its repo, until it is resolved', async () => {
      const made = await store.saveFlag(flag(), note('Is this ours?'));
      expect(made).toEqual({ ...flag(), id: expect.any(String), notes: [note('Is this ours?')], resolvedAt: null, resolvedBy: null });
      const reply = note('A spike for PROJ-9.', { by: 'alice', name: 'Alice', role: 'developer' });
      expect(await store.addFlagNote(REPO, made.id, reply)).toBe(true);
      expect(await store.addFlagNote(OTHER, made.id, reply)).toBe(false);
      expect(await store.addFlagNote(REPO, 'nope', reply)).toBe(false);
      expect(await store.resolveFlag(REPO, made.id, 'Pat (PO)', at)).toBe(true);
      expect(await store.resolveFlag(REPO, made.id, 'Alice', at)).toBe(false);
      expect(await store.flags(REPO)).toEqual([{ ...made, notes: [note('Is this ours?'), reply], resolvedAt: at, resolvedBy: 'Pat (PO)' }]);
      expect(await store.flags(OTHER)).toEqual([]);
    });

    it('never has two open flags on one session in a repo, but a resolved one can be followed by another', async () => {
      const first = await store.saveFlag(flag(), note('One'));
      expect((await store.saveFlag(flag({ flaggedBy: 'kim' }), note('Two'))).id).toBe(first.id);
      await store.resolveFlag(REPO, first.id, 'Pat (PO)', at);
      expect((await store.saveFlag(flag(), null)).id).not.toBe(first.id);
      expect(await store.flags(REPO)).toHaveLength(2);
    });

    it('keeps admin settings by kind and key, sorted by key', async () => {
      await store.putCostConfig('grant', 'b', { repoId: REPO, readerId: 'b' });
      await store.putCostConfig('grant', 'a', { repoId: REPO, readerId: 'a' });
      await store.putCostConfig('grant', 'b', { repoId: OTHER, readerId: 'b' });
      expect(await store.costConfig('grant')).toEqual([{ repoId: REPO, readerId: 'a' }, { repoId: OTHER, readerId: 'b' }]);
      expect(await store.costConfig('pattern')).toEqual([]);
      expect(await store.removeCostConfig('grant', 'a')).toBe(true);
      expect(await store.removeCostConfig('grant', 'a')).toBe(false);
      expect(await store.costConfig('grant')).toHaveLength(1);
    });
  });
}
