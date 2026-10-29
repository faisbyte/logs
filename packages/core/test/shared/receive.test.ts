import { describe, expect, it } from 'vitest';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { receivePush } from '../../src/shared/store.js';
import { payloadFor } from './store-contract.js';

const alice = { repoId: 'github.com/acme/webapp', developerId: 'alice', developerName: 'Alice' };

describe('receivePush (the receiving side of one push)', () => {
  it('pushes as the identity the token belongs to', async () => {
    const store = new InMemorySummaryStore();
    const { token } = await store.issueToken(alice);
    expect(await receivePush(store, token, alice.repoId, payloadFor())).toMatchObject({ status: 'created', stored: { developerId: 'alice' } });
  });

  it('refuses an unknown token and a token for a different repo, storing nothing', async () => {
    const store = new InMemorySummaryStore();
    const { token } = await store.issueToken(alice);
    expect(await receivePush(store, 'dgt_wrong', alice.repoId, payloadFor())).toEqual({ status: 'unauthorized', reason: 'unknown or revoked token' });
    expect(await receivePush(store, token, 'github.com/acme/other', payloadFor())).toEqual({ status: 'forbidden', reason: 'this token is for a different repo' });
    expect(await store.list({ repoId: alice.repoId })).toEqual([]);
  });
});
