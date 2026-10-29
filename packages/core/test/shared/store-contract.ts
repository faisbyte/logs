import { inspect } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { approve, uploadPayload } from '../../src/review/approval.js';
import type { SummaryStore, TokenStore } from '../../src/shared/store.js';
import type { SessionSummary } from '../../src/summarize/schema.js';
import { draftSummary } from '../review/helpers.js';

// Every SummaryStore implementation must pass these (DECISIONS.md D40). Call from each implementation's test file.

const REPO = 'github.com/acme/webapp';
const now = new Date('2026-10-29T12:00:00.000Z');
export const payloadFor = (overrides: Partial<SessionSummary> = {}) => uploadPayload(approve(draftSummary(overrides), { now }));
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };

export function summaryStoreContract(name: string, make: () => Promise<SummaryStore & TokenStore> | (SummaryStore & TokenStore)) {
  describe(`${name}: SummaryStore contract`, () => {
    let store: SummaryStore & TokenStore;
    beforeEach(async () => {
      store = await make();
    });

    describe('push', () => {
      it('stores a valid payload with who pushed it and when', async () => {
        const result = await store.push(alice, payloadFor());
        expect(result.status).toBe('created');
        const [stored] = await store.list({ repoId: REPO });
        expect(stored).toMatchObject({ repoId: REPO, developerId: 'alice', developerName: 'Alice', retractedAt: null, summary: payloadFor() });
        expect(Date.parse(stored!.pushedAt)).not.toBeNaN();
      });

      it('is idempotent: the same summary pushed twice is stored once', async () => {
        await store.push(alice, payloadFor());
        expect((await store.push(alice, payloadFor())).status).toBe('unchanged');
        expect(await store.list({ repoId: REPO })).toHaveLength(1);
      });

      it('keeps pushed summaries immutable: different content for a pushed session is a conflict', async () => {
        await store.push(alice, payloadFor());
        const result = await store.push(alice, payloadFor({ goal: 'Something else.' }));
        expect(result).toMatchObject({ status: 'conflict', reason: expect.stringMatching(/immutable/) });
        expect((await store.list({ repoId: REPO }))[0]!.summary.goal).toBe('Rate limit the login endpoint.');
      });

      it("refuses one developer's push of another developer's session", async () => {
        await store.push(alice, payloadFor());
        expect(await store.push(bob, payloadFor())).toMatchObject({ status: 'conflict', reason: expect.stringMatching(/another developer/) });
      });

      it('validates every push and stores nothing it rejects', async () => {
        const fakeToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
        for (const bad of [{ ...payloadFor(), transcript: [] }, { ...payloadFor(), goal: `Uses ${fakeToken}` }, { ...payloadFor(), whatWasDone: 'USER: hi\nASSISTANT: hello' }, null]) {
          expect(await store.push(alice, bad)).toMatchObject({ status: 'rejected', errors: [expect.any(String)] });
        }
        expect(await store.list({ repoId: REPO })).toEqual([]);
      });

      it('returns copies: changing a result never changes the store', async () => {
        await store.push(alice, payloadFor());
        const [first] = await store.list({ repoId: REPO });
        try {
          (first!.summary as { goal: string }).goal = 'changed';
        } catch {
          // frozen is fine too
        }
        expect((await store.list({ repoId: REPO }))[0]!.summary.goal).toBe('Rate limit the login endpoint.');
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await store.push(alice, payloadFor({ sessionId: 'a1', branch: 'feature/PROJ-1-x', ticketRefs: ['PROJ-1'], startedAt: '2026-03-02T09:00:00.000Z', endedAt: '2026-03-02T10:00:00.000Z' }));
        await store.push(alice, payloadFor({ sessionId: 'a2', branch: 'main', ticketRefs: [], startedAt: '2026-03-10T09:00:00.000Z', endedAt: '2026-03-10T10:00:00.000Z' }));
        await store.push(bob, payloadFor({ sessionId: 'b1', branch: 'feature/PROJ-2-y', ticketRefs: ['PROJ-2', 'PROJ-1'], startedAt: '2026-03-05T23:00:00.000Z', endedAt: '2026-03-06T01:00:00.000Z' }));
        await store.push({ ...alice, repoId: 'github.com/acme/other' }, payloadFor({ sessionId: 'o1' }));
      });
      const ids = (rows: { summary: { sessionId: string } }[]) => rows.map((r) => r.summary.sessionId);

      it('lists one repo, oldest session first', async () => {
        expect(ids(await store.list({ repoId: REPO }))).toEqual(['a1', 'b1', 'a2']);
      });

      it('filters by branch, ticket and developer', async () => {
        expect(ids(await store.list({ repoId: REPO, branch: 'main' }))).toEqual(['a2']);
        expect(ids(await store.list({ repoId: REPO, ticket: 'PROJ-1' }))).toEqual(['a1', 'b1']);
        expect(ids(await store.list({ repoId: REPO, developerId: 'bob' }))).toEqual(['b1']);
      });

      it('filters by date range: sessions overlapping [from, to)', async () => {
        expect(ids(await store.list({ repoId: REPO, from: '2026-03-06T00:00:00.000Z', to: '2026-03-10T09:00:00.000Z' }))).toEqual(['b1']);
        expect(ids(await store.list({ repoId: REPO, from: '2026-03-02T10:00:00.000Z' }))).toEqual(['a1', 'b1', 'a2']);
        expect(ids(await store.list({ repoId: REPO, to: '2026-03-02T09:00:00.000Z' }))).toEqual([]);
      });
    });

    describe('teamReport', () => {
      it('combines every developer for a date range, with coverage counts', async () => {
        await store.push(alice, payloadFor({ sessionId: 'a1', startedAt: '2026-03-02T09:00:00.000Z', endedAt: '2026-03-02T10:00:00.000Z' }));
        await store.push(alice, payloadFor({ sessionId: 'a2', startedAt: '2026-03-03T09:00:00.000Z', endedAt: '2026-03-03T10:00:00.000Z' }));
        await store.push(bob, payloadFor({ sessionId: 'b1', startedAt: '2026-03-04T09:00:00.000Z', endedAt: '2026-03-04T10:00:00.000Z' }));
        await store.push(bob, payloadFor({ sessionId: 'b2', startedAt: '2026-04-01T09:00:00.000Z', endedAt: '2026-04-01T10:00:00.000Z' }));
        const report = await store.teamReport({ repoId: REPO, from: '2026-03-01T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z' });
        expect(report).toMatchObject({ repoId: REPO, from: '2026-03-01T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z', summaryCount: 3, developerCount: 2 });
        expect(report.summaries.map((s) => [s.summary.sessionId, s.developerName])).toEqual([
          ['a1', 'Alice'],
          ['a2', 'Alice'],
          ['b1', 'Bob'],
        ]);
      });

      it('reports zero coverage for an empty range', async () => {
        expect(await store.teamReport({ repoId: REPO, from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' })).toMatchObject({ summaryCount: 0, developerCount: 0, summaries: [] });
      });
    });

    describe('tokens', () => {
      it('issues a token per developer per repo that authenticates as that identity', async () => {
        const { token } = await store.issueToken(alice);
        expect(token).toMatch(/^dgt_[A-Za-z0-9_-]{40,}$/);
        expect(await store.authenticate(token)).toEqual(alice);
        expect(await store.authenticate(`${token}x`)).toBeNull();
        expect(await store.authenticate('')).toBeNull();
      });

      it('keeps one token per developer and repo: issuing again replaces the old one', async () => {
        const first = await store.issueToken(alice);
        const second = await store.issueToken(alice);
        expect(await store.authenticate(first.token)).toBeNull();
        expect(await store.authenticate(second.token)).toEqual(alice);
        const other = await store.issueToken({ ...alice, repoId: 'github.com/acme/other' });
        expect(await store.authenticate(other.token)).toEqual({ ...alice, repoId: 'github.com/acme/other' });
        expect(await store.authenticate(second.token)).toEqual(alice);
      });

      it('stores only a hash of each token', async () => {
        const { token } = await store.issueToken(alice);
        expect(inspect(store, { depth: 10, showHidden: true })).not.toContain(token);
        expect(inspect(store, { depth: 10, showHidden: true })).not.toContain(token.slice(4));
      });
    });
  });
}
