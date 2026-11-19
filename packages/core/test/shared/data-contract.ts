import { beforeEach, describe, expect, it } from 'vitest';
import type { SharedStore } from '../../src/shared/tickets.js';
import { contextItem } from './context-contract.js';
import { newDigest } from './digest-contract.js';
import { payloadFor } from './store-contract.js';

// Delete my data (Phase 10, DECISIONS.md D98): a developer removes everything they pushed to a repo, and what was
// derived only from it. Every store implementation must pass these.

const REPO = 'github.com/acme/webapp';
const OTHER = 'github.com/acme/other';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
const none = { added: [], merged: [], superseded: [] };
const key = (sessionId: string) => `claude-code/${sessionId}`;

export function dataDeletionContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: delete my data`, () => {
    let store: SharedStore;
    beforeEach(async () => {
      store = await make();
      await store.push(alice, payloadFor({ sessionId: 'a1' }));
      await store.push(alice, payloadFor({ sessionId: 'a2' }));
      await store.retract(alice, { agent: 'claude-code', sessionId: 'a2' });
      await store.push(bob, payloadFor({ sessionId: 'b1' }));
      await store.push({ ...alice, repoId: OTHER }, payloadFor({ sessionId: 'a9' }));
    });

    it("deletes every summary the developer pushed to the repo, retracted ones too, and leaves everyone else's", async () => {
      const result = await store.deleteDeveloperData(alice);
      expect(result.summaries).toBe(2);
      expect((await store.list({ repoId: REPO })).map((s) => s.summary.sessionId)).toEqual(['b1']);
      expect(await store.retractions(REPO)).toEqual([]);
      expect((await store.list({ repoId: OTHER })).map((s) => s.summary.sessionId)).toEqual(['a9']);
      // Nothing of hers is left to conflict with: the same session can be pushed again as new.
      expect((await store.push(alice, payloadFor({ sessionId: 'a1' }))).status).toBe('created');
    });

    // Only a summary's own developer can link it (D45), so her links are the ones on her summaries.
    it("deletes the ticket links on her summaries, and keeps everyone else's", async () => {
      await store.addTicketLink(alice, { agent: 'claude-code', sessionId: 'a1' }, 'PROJ-1');
      await store.addTicketLink(alice, { agent: 'claude-code', sessionId: 'a1' }, 'PROJ-2');
      await store.addTicketLink(bob, { agent: 'claude-code', sessionId: 'b1' }, 'PROJ-3');
      expect((await store.deleteDeveloperData(alice)).ticketLinks).toBe(2);
      expect((await store.ticketLinks(REPO)).map((l) => l.ticketKey)).toEqual(['PROJ-3']);
    });

    it('deletes context items that came only from her summaries, and takes her summaries out of shared ones', async () => {
      await store.applyContextChanges(REPO, {
        ...none,
        added: [
          contextItem({ id: 'ctx-000000a1', sources: [key('a1')] }),
          contextItem({ id: 'ctx-000000a2', sources: [key('a1'), key('a2')], status: 'superseded', supersededBy: 'ctx-000000b1' }),
          contextItem({ id: 'ctx-000000ab', sources: [key('a1'), key('b1')] }),
          contextItem({ id: 'ctx-000000b1', sources: [key('b1')] }),
        ],
      });
      const result = await store.deleteDeveloperData(alice);
      expect([result.contextItemsDeleted, result.contextItemsEdited]).toEqual([2, 1]);
      const items = await store.contextItems(REPO);
      expect(items.map((i) => [i.id, i.sources]).sort()).toEqual([
        ['ctx-000000ab', [key('b1')]],
        ['ctx-000000b1', [key('b1')]],
      ]);
    });

    it('forgets that distillation read her summaries, so a summary pushed again is read again', async () => {
      await store.applyContextChanges(REPO, none, {
        repoId: REPO, at: '2026-11-01T00:00:00.000Z', model: 'm', promptVersion: 'p', added: 0, merged: 0, superseded: 0, dropped: [], untraced: 0, retryReasons: [], costUsd: 0,
        summaries: [{ key: key('a1'), payloadHash: 'h1' }, { key: key('b1'), payloadHash: 'h2' }],
      });
      await store.deleteDeveloperData(alice);
      expect(await store.distilledSummaries(REPO)).toEqual([{ key: key('b1'), payloadHash: 'h2' }]);
    });

    it('withdraws a sent digest that included her work and deletes its text; unsent ones are deleted; others stay', async () => {
      const sent = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:1', status: 'sent', summaryKeys: [key('a1'), key('b1')] }));
      const withdrawn = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:0', status: 'withdrawn', summaryKeys: [key('a2')] }));
      await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:2', status: 'preview', summaryKeys: [key('a1')] }));
      await store.saveDigest(newDigest({ kind: 'report', status: 'ready', summaryKeys: [key('a1')] }));
      const bobs = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:3', status: 'sent', summaryKeys: [key('b1')] }));
      const result = await store.deleteDeveloperData(alice);
      expect([result.digestsWithdrawn, result.digestsDeleted]).toEqual([2, 2]);
      expect((await store.digests(REPO)).map((d) => d.id).sort()).toEqual([sent.id, withdrawn.id, bobs.id].sort());
      for (const id of [sent.id, withdrawn.id]) {
        const d = (await store.getDigest(REPO, id))!;
        expect(d.status).toBe('withdrawn');
        expect(d.markdown).toBe(DELETED_DIGEST_TEXT);
      }
      expect((await store.getDigest(REPO, bobs.id))!).toMatchObject({ status: 'sent', markdown: newDigest().markdown });
    });

    it('keeps her token working, and says when there was nothing to delete', async () => {
      const { token } = await store.issueToken(alice);
      await store.deleteDeveloperData(alice);
      expect(await store.authenticate(token)).toMatchObject({ developerId: 'alice' });
      expect(await store.deleteDeveloperData(alice)).toEqual({ summaries: 0, ticketLinks: 0, contextItemsDeleted: 0, contextItemsEdited: 0, digestsWithdrawn: 0, digestsDeleted: 0 });
    });
  });
}

export const DELETED_DIGEST_TEXT = '# Deleted\n\nThis digest included work whose developer deleted their data, so its text was deleted too.\n';

// Retention (Phase 10, D99): summaries that ended before a cut-off age out, with what came only from them.
export function retentionContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: retention`, () => {
    let store: SharedStore;
    const CUTOFF = '2026-03-10T00:00:00.000Z';
    beforeEach(async () => {
      store = await make();
      await store.push(alice, payloadFor({ sessionId: 'old1', startedAt: '2026-03-01T09:00:00.000Z', endedAt: '2026-03-01T10:00:00.000Z' }));
      await store.push(bob, payloadFor({ sessionId: 'old2', startedAt: '2026-03-05T09:00:00.000Z', endedAt: '2026-03-05T10:00:00.000Z' }));
      // Ends after the cut-off, though it started before it: kept.
      await store.push(alice, payloadFor({ sessionId: 'new1', startedAt: '2026-03-09T22:00:00.000Z', endedAt: '2026-03-10T01:00:00.000Z' }));
      await store.push({ ...alice, repoId: OTHER }, payloadFor({ sessionId: 'old9', startedAt: '2026-03-01T09:00:00.000Z', endedAt: '2026-03-01T10:00:00.000Z' }));
    });

    it("deletes every developer's summaries that ended before the cut-off, in that repo only, with their links", async () => {
      await store.addTicketLink(alice, { agent: 'claude-code', sessionId: 'old1' }, 'PROJ-1');
      await store.addTicketLink(alice, { agent: 'claude-code', sessionId: 'new1' }, 'PROJ-2');
      expect(await store.purgeSummariesBefore(REPO, CUTOFF)).toEqual({ summaries: 2, ticketLinks: 1, contextItemsDeleted: 0, contextItemsEdited: 0 });
      expect((await store.list({ repoId: REPO })).map((s) => s.summary.sessionId)).toEqual(['new1']);
      expect((await store.ticketLinks(REPO)).map((l) => l.ticketKey)).toEqual(['PROJ-2']);
      expect((await store.list({ repoId: OTHER })).map((s) => s.summary.sessionId)).toEqual(['old9']);
    });

    it('deletes context items that came only from aged-out summaries, and trims shared ones', async () => {
      await store.applyContextChanges(REPO, {
        ...none,
        added: [contextItem({ id: 'ctx-000000c1', sources: [key('old1'), key('old2')] }), contextItem({ id: 'ctx-000000c2', sources: [key('old1'), key('new1')] })],
      });
      expect(await store.purgeSummariesBefore(REPO, CUTOFF)).toMatchObject({ contextItemsDeleted: 1, contextItemsEdited: 1 });
      expect((await store.contextItems(REPO)).map((i) => [i.id, i.sources])).toEqual([['ctx-000000c2', [key('new1')]]]);
    });

    it('leaves digests alone: they are the stakeholders’ record, and ageing out is not a withdrawal', async () => {
      const sent = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:1', status: 'sent', summaryKeys: [key('old1')] }));
      const report = await store.saveDigest(newDigest({ kind: 'report', status: 'ready', summaryKeys: [key('old2')] }));
      await store.purgeSummariesBefore(REPO, CUTOFF);
      expect(await store.getDigest(REPO, sent.id)).toMatchObject({ status: 'sent', markdown: newDigest().markdown });
      expect(await store.getDigest(REPO, report.id)).toMatchObject({ status: 'ready' });
    });

    it('finds the repos that have a retention period, and nothing to do is fine', async () => {
      expect(await store.retentionRepos()).toEqual([]);
      await store.saveRepoSettings(REPO, { retentionDays: 90 });
      await store.saveRepoSettings(OTHER, { emailTo: ['po@example.com'] });
      expect(await store.retentionRepos()).toEqual([{ repoId: REPO, retentionDays: 90 }]);
      expect(await store.purgeSummariesBefore(REPO, '2000-01-01T00:00:00.000Z')).toEqual({ summaries: 0, ticketLinks: 0, contextItemsDeleted: 0, contextItemsEdited: 0 });
    });
  });
}
