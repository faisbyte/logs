import { inspect } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { approve, uploadPayload } from '../../src/review/approval.js';
import type { SharedStore } from '../../src/shared/tickets.js';
import type { SessionSummary } from '../../src/summarize/schema.js';
import { draftSummary } from '../review/helpers.js';

// Every SummaryStore implementation must pass these (DECISIONS.md D40). Call from each implementation's test file.

const REPO = 'github.com/acme/webapp';
const now = new Date('2026-10-29T12:00:00.000Z');
export const payloadFor = (overrides: Partial<SessionSummary> = {}) => uploadPayload(approve(draftSummary(overrides), { now }));
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };

export function summaryStoreContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: SummaryStore contract`, () => {
    let store: SharedStore;
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

    describe('retract (DECISIONS.md D60)', () => {
      const ref = { agent: 'claude-code', sessionId: payloadFor().sessionId } as const;
      const key = `claude-code/${payloadFor().sessionId}`;

      it('lets the developer who pushed a summary retract it: it leaves every list and report, and the record and time are kept', async () => {
        await store.push(alice, payloadFor());
        const result = await store.retract(alice, ref);
        expect(result).toEqual({ status: 'retracted', retractedAt: expect.any(String) });
        expect(await store.list({ repoId: REPO })).toEqual([]);
        expect(await store.teamReport({ repoId: REPO, from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' })).toMatchObject({ summaryCount: 0 });
        expect(await store.retractions(REPO)).toEqual([{ repoId: REPO, ...ref, developerId: 'alice', payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/), retractedAt: (result as { retractedAt: string }).retractedAt }]);
        expect(await store.retract(alice, ref)).toEqual({ status: 'already', retractedAt: (result as { retractedAt: string }).retractedAt });
      });

      it("refuses another developer's token and an unknown session", async () => {
        await store.push(alice, payloadFor());
        expect(await store.retract(bob, ref)).toMatchObject({ status: 'forbidden', reason: expect.stringMatching(/only the developer who pushed/) });
        expect(await store.retract(alice, { ...ref, sessionId: 'unknown' })).toMatchObject({ status: 'not-found' });
        expect(await store.list({ repoId: REPO })).toHaveLength(1);
      });

      it('takes a new push of a retracted session from its developer, replacing it', async () => {
        await store.push(alice, payloadFor());
        await store.retract(alice, ref);
        expect(await store.push(bob, payloadFor({ goal: 'Taken over.' }))).toMatchObject({ status: 'conflict' });
        expect(await store.push(alice, payloadFor({ goal: 'Corrected.' }))).toMatchObject({ status: 'created' });
        expect((await store.list({ repoId: REPO })).map((s) => [s.summary.goal, s.retractedAt])).toEqual([['Corrected.', null]]);
        expect(await store.retractions(REPO)).toHaveLength(1);
      });

      it('withdraws digests that included it: cached reports and unsent digests go, sent ones are kept but withdrawn', async () => {
        await store.push(alice, payloadFor());
        const base = { repoId: REPO, periodLabel: 'p', from: null, to: null, inputHash: 'h', promptVersion: 'digest-v1', model: 'm', markdown: '# p\n', summaryCount: 1, developerCount: 1, costUsd: 0, previewUntil: null, createdAt: '2026-03-16T00:00:00.000Z' };
        const cached = await store.saveDigest({ ...base, kind: 'report', periodKey: 'sprint:Sprint 1', status: 'ready', summaryKeys: [key] });
        await store.saveDigest({ ...base, kind: 'scheduled', periodKey: 'week:1', status: 'preview', summaryKeys: [key] });
        const sent = await store.saveDigest({ ...base, kind: 'scheduled', periodKey: 'week:2', status: 'sent', summaryKeys: [key] });
        const other = await store.saveDigest({ ...base, kind: 'report', periodKey: 'sprint:Sprint 2', status: 'ready', summaryKeys: ['claude-code/other'] });
        await store.retract(alice, ref);
        expect((await store.digests(REPO)).map((d) => [d.id, d.status]).sort()).toEqual([[other.id, 'ready'], [sent.id, 'withdrawn']].sort());
        expect(await store.findReport(REPO, { periodKey: 'sprint:Sprint 1', inputHash: 'h', promptVersion: 'digest-v1', model: 'm' })).toBeNull();
        expect(await store.getDigest(REPO, cached.id)).toBeNull();
      });
    });

    describe('a withdrawn scheduled digest (DECISIONS.md D70)', () => {
      it('no longer counts as its period\'s digest, so a corrected one can be stored next to it', async () => {
        await store.push(alice, payloadFor());
        const base = { repoId: REPO, kind: 'scheduled' as const, periodKey: 'sprint:Sprint 1', periodLabel: 'p', from: null, to: null, inputHash: 'h', promptVersion: 'digest-v2', model: 'm', markdown: '# p\n', summaryCount: 1, developerCount: 1, costUsd: 0, previewUntil: null, createdAt: '2026-03-16T00:00:00.000Z' };
        const first = await store.saveDigest({ ...base, status: 'sent', summaryKeys: [`claude-code/${payloadFor().sessionId}`] });
        await store.retract(alice, { agent: 'claude-code', sessionId: payloadFor().sessionId });
        expect(await store.scheduledDigest(REPO, 'sprint:Sprint 1')).toBeNull();
        const corrected = await store.saveDigest({ ...base, status: 'ready', markdown: '# p (corrected)\n', corrects: first.id });
        expect(corrected.id).not.toBe(first.id);
        expect(await store.scheduledDigest(REPO, 'sprint:Sprint 1')).toMatchObject({ id: corrected.id, corrects: first.id });
        expect(await store.getDigest(REPO, first.id)).toMatchObject({ status: 'withdrawn', corrects: null });
      });
    });

    describe('tokens', () => {
      it('issues a token per developer per repo that authenticates as that identity', async () => {
        const { token } = await store.issueToken(alice);
        expect(token).toMatch(/^dgt_[A-Za-z0-9_-]{40,}$/);
        expect(await store.authenticate(token)).toEqual({ ...alice, role: 'developer' });
        expect(await store.authenticate(`${token}x`)).toBeNull();
        expect(await store.authenticate('')).toBeNull();
      });

      it('keeps one token per developer and repo: issuing again replaces the old one', async () => {
        const first = await store.issueToken(alice);
        const second = await store.issueToken(alice);
        expect(await store.authenticate(first.token)).toBeNull();
        expect(await store.authenticate(second.token)).toEqual({ ...alice, role: 'developer' });
        const other = await store.issueToken({ ...alice, repoId: 'github.com/acme/other' });
        expect(await store.authenticate(other.token)).toEqual({ ...alice, repoId: 'github.com/acme/other', role: 'developer' });
        expect(await store.authenticate(second.token)).toEqual({ ...alice, role: 'developer' });
      });

      it('issues read-only tokens for stakeholders, kept apart from developer tokens with the same id (DECISIONS.md D51)', async () => {
        const developer = await store.issueToken(alice);
        const reader = await store.issueToken({ ...alice, developerName: 'Alice (PO)' }, 'reader');
        expect(await store.authenticate(reader.token)).toEqual({ ...alice, developerName: 'Alice (PO)', role: 'reader' });
        expect(await store.authenticate(developer.token)).toEqual({ ...alice, role: 'developer' });
        const again = await store.issueToken(alice, 'reader');
        expect(await store.authenticate(reader.token)).toBeNull();
        expect(await store.authenticate(again.token)).toMatchObject({ role: 'reader' });
        expect(await store.authenticate(developer.token)).toMatchObject({ role: 'developer' });
      });

      it('stores only a hash of each token', async () => {
        const { token } = await store.issueToken(alice);
        expect(inspect(store, { depth: 10, showHidden: true })).not.toContain(token);
        expect(inspect(store, { depth: 10, showHidden: true })).not.toContain(token.slice(4));
      });
    });
  });
}
