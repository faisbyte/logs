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
