import { beforeEach, describe, expect, it } from 'vitest';
import { flagSession, replyToFlag, settleFlag } from '../../src/cost/flags.js';
import { enableCost, saveAccount } from '../../src/cost/ingest.js';
import { grantCost } from '../../src/cost/report.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import type { Identity } from '../../src/shared/store.js';
import { costRecord, REPO } from './cost-contract.js';

// Flags (Phase 12, D106): a manager asks about a session, the developer sees it and can answer.

const NOW = new Date('2026-04-08T09:00:00.000Z');
const who = (developerId: string, role: Identity['role']): Identity => ({ repoId: REPO, developerId, developerName: developerId.toUpperCase(), role });
const [pat, kim, alice, bob] = [who('pat', 'reader'), who('kim', 'reader'), who('alice', 'developer'), who('bob', 'developer')];
const target = { agent: 'claude-code', sessionId: 's1', developerId: 'alice' };

let store: InMemorySummaryStore;
beforeEach(async () => {
  store = new InMemorySummaryStore();
  await enableCost(store, REPO, new Date('2026-04-01T00:00:00.000Z'));
  await saveAccount(store, { repoId: REPO, email: 'alice@acme.example', developerId: 'alice', developerName: 'Alice', organizationId: null, billing: null });
  await grantCost(store, REPO, 'pat');
  await store.recordUsage([costRecord()]);
});
const open = async (note: unknown = 'Is this ours?') => {
  const r = await flagSession(store, pat, { ...target, note }, NOW);
  if (r.status !== 'ok') throw new Error(r.status);
  return r.flag;
};

describe('flagging a session', () => {
  it('is for readers with cost access, on a session they can see', async () => {
    expect(await open()).toMatchObject({ ...target, flaggedBy: 'pat', flaggedByName: 'PAT', notes: [{ by: 'pat', name: 'PAT', role: 'reader', text: 'Is this ours?' }], resolvedAt: null });
    for (const other of [kim, alice, bob]) expect(await flagSession(store, other, target, NOW)).toMatchObject({ status: 'forbidden' });
    expect(await flagSession(store, pat, { ...target, sessionId: 'nope' }, NOW)).toMatchObject({ status: 'not-found' });
    expect(await flagSession(store, pat, { ...target, developerId: 'bob' }, NOW)).toMatchObject({ status: 'not-found' });
  });

  it('needs no note, and refuses one that is too long or holds a secret, without echoing it', async () => {
    expect((await open(null)).notes).toEqual([]);
    expect(await flagSession(store, pat, { ...target, note: 'x'.repeat(1001) }, NOW)).toMatchObject({ status: 'invalid' });
    const secret = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const refused = await flagSession(store, pat, { ...target, note: `see ${secret}` }, NOW);
    expect(refused).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(refused)).not.toContain(secret);
  });

  it('lets the developer it is about reply and settle it, and no other developer', async () => {
    const { id } = await open();
    expect(await replyToFlag(store, alice, id, 'A spike for PROJ-9.', NOW)).toEqual({ status: 'ok' });
    for (const other of [bob, kim]) {
      expect(await replyToFlag(store, other, id, 'hi', NOW)).toMatchObject({ status: 'not-found' });
      expect(await settleFlag(store, other, id, NOW)).toMatchObject({ status: 'not-found' });
    }
    expect(await replyToFlag(store, pat, id, 'Thanks.', NOW)).toEqual({ status: 'ok' });
    expect(await replyToFlag(store, alice, id, '  ', NOW)).toMatchObject({ status: 'invalid' });
    expect(await settleFlag(store, alice, id, NOW)).toEqual({ status: 'ok' });
    expect(await settleFlag(store, pat, id, NOW)).toMatchObject({ status: 'not-found' });
    expect(await store.flags(REPO)).toMatchObject([{ notes: [{ by: 'pat' }, { by: 'alice', role: 'developer', text: 'A spike for PROJ-9.' }, { by: 'pat' }], resolvedBy: 'ALICE' }]);
  });
});
