import { describe, expect, it } from 'vitest';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { localPushTarget } from '../../src/shared/target.js';
import { payloadFor } from './store-contract.js';

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const ref = { agent: 'claude-code', sessionId: payloadFor().sessionId } as const;

describe('localPushTarget: ticket links and the tickets view behind the token', () => {
  it('links, unlinks and reads as the identity the token belongs to', async () => {
    const store = new InMemorySummaryStore();
    const target = localPushTarget(store, (await store.issueToken(alice)).token);
    await target.push(REPO, payloadFor());
    expect(await target.link(REPO, ref, 'OPS-7')).toEqual({ status: 'created' });
    expect(await target.tickets(REPO, { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' })).toMatchObject({ status: 'ok', report: { summaryCount: 1 } });
    expect(await target.unlink(REPO, ref, 'OPS-7')).toEqual({ status: 'removed' });
  });

  it('refuses an unknown token and a token for another repo', async () => {
    const store = new InMemorySummaryStore();
    const unknown = localPushTarget(store, 'dgt_wrong');
    expect(await unknown.link(REPO, ref, 'OPS-7')).toMatchObject({ status: 'unauthorized' });
    expect(await unknown.tickets(REPO, { sprint: 'S1' })).toMatchObject({ status: 'unauthorized' });
    const other = localPushTarget(store, (await store.issueToken({ ...alice, repoId: 'github.com/acme/other' })).token);
    expect(await other.unlink(REPO, ref, 'OPS-7')).toMatchObject({ status: 'forbidden' });
    expect(await other.tickets(REPO, { sprint: 'S1' })).toMatchObject({ status: 'forbidden' });
  });

  it('retracts as the identity the token belongs to (DECISIONS.md D60)', async () => {
    const store = new InMemorySummaryStore();
    const target = localPushTarget(store, (await store.issueToken(alice)).token);
    await target.push(REPO, payloadFor());
    expect(await target.retract(REPO, ref)).toMatchObject({ status: 'retracted' });
    const reader = localPushTarget(store, (await store.issueToken(alice, 'reader')).token);
    expect(await reader.retract(REPO, ref)).toMatchObject({ status: 'forbidden' });
  });
});
