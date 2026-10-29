import { beforeEach, describe, expect, it } from 'vitest';
import type { SharedStore } from '../../src/shared/tickets.js';
import { payloadFor } from './store-contract.js';

// Every TicketStore implementation must pass these (DECISIONS.md D45). Call from each implementation's test file.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const bob = { repoId: REPO, developerId: 'bob', developerName: 'Bob' };
const session = { agent: 'claude-code', sessionId: 'c1a5e001-0000-4000-8000-000000000001' } as const;
const sprint = (name: string, from: string, to: string) => ({ name, from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` });

export function ticketStoreContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: TicketStore contract`, () => {
    let store: SharedStore;
    beforeEach(async () => {
      store = await make();
    });

    describe('manual ticket links', () => {
      beforeEach(async () => {
        await store.push(alice, payloadFor()); // ticketRefs: PROJ-142
      });

      it('lets the developer who pushed a summary link it to another ticket, recording who and when', async () => {
        expect(await store.addTicketLink(alice, session, 'OPS-7')).toEqual({ status: 'created' });
        const [link, ...rest] = await store.ticketLinks(REPO);
        expect(rest).toEqual([]);
        expect(link).toMatchObject({ repoId: REPO, ...session, ticketKey: 'OPS-7', addedBy: 'alice' });
        expect(Date.parse(link!.addedAt)).not.toBeNaN();
      });

      it('is idempotent, and treats a key already in the summary as linked', async () => {
        await store.addTicketLink(alice, session, 'OPS-7');
        expect(await store.addTicketLink(alice, session, 'OPS-7')).toEqual({ status: 'unchanged' });
        expect(await store.addTicketLink(alice, session, 'PROJ-142')).toEqual({ status: 'unchanged' });
        expect((await store.ticketLinks(REPO)).map((l) => l.ticketKey)).toEqual(['OPS-7']);
      });

      it('refuses another developer, an unknown session, and a key that is not a single safe word', async () => {
        const fakeToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
        expect(await store.addTicketLink(bob, session, 'OPS-7')).toMatchObject({ status: 'forbidden' });
        expect(await store.addTicketLink(alice, { ...session, sessionId: 'unknown' }, 'OPS-7')).toMatchObject({ status: 'not-found' });
        expect(await store.addTicketLink({ ...alice, repoId: 'github.com/acme/other' }, session, 'OPS-7')).toMatchObject({ status: 'not-found' });
        for (const bad of ['two words', '', fakeToken, 'x'.repeat(101)]) expect(await store.addTicketLink(alice, session, bad)).toMatchObject({ status: 'rejected' });
        expect(await store.ticketLinks(REPO)).toEqual([]);
      });

      it('removes only the manual link record, never a key inside the summary', async () => {
        await store.addTicketLink(alice, session, 'OPS-7');
        expect(await store.removeTicketLink(bob, session, 'OPS-7')).toMatchObject({ status: 'forbidden' });
        expect(await store.removeTicketLink(alice, session, 'PROJ-142')).toMatchObject({ status: 'in-summary' });
        expect(await store.removeTicketLink(alice, session, 'OPS-7')).toEqual({ status: 'removed' });
        expect(await store.removeTicketLink(alice, session, 'OPS-7')).toMatchObject({ status: 'not-found' });
        expect(await store.ticketLinks(REPO)).toEqual([]);
        expect((await store.list({ repoId: REPO }))[0]!.summary).toEqual(payloadFor());
      });

      it('finds summaries by a manually linked ticket', async () => {
        await store.addTicketLink(alice, session, 'OPS-7');
        expect((await store.list({ repoId: REPO, ticket: 'OPS-7' })).map((s) => s.summary.sessionId)).toEqual([session.sessionId]);
        expect(await store.list({ repoId: REPO, ticket: 'OPS-8' })).toEqual([]);
      });
    });

    describe('sprints', () => {
      it('keeps named date ranges per repo, earliest first, replacing one by name', async () => {
        expect(await store.saveSprint(REPO, sprint('Sprint 2', '2026-03-16', '2026-03-30'))).toEqual({ status: 'saved' });
        await store.saveSprint(REPO, sprint('Sprint 1', '2026-03-02', '2026-03-16'));
        await store.saveSprint('github.com/acme/other', sprint('Other', '2026-01-01', '2026-02-01'));
        await store.saveSprint(REPO, sprint('Sprint 2', '2026-03-16', '2026-03-27'));
        expect(await store.sprints(REPO)).toEqual([sprint('Sprint 1', '2026-03-02', '2026-03-16'), sprint('Sprint 2', '2026-03-16', '2026-03-27')]);
      });

      it('refuses a sprint that overlaps another, or that ends before it starts', async () => {
        await store.saveSprint(REPO, sprint('Sprint 1', '2026-03-02', '2026-03-16'));
        expect(await store.saveSprint(REPO, sprint('Sprint 2', '2026-03-15', '2026-03-30'))).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/overlaps Sprint 1/) });
        expect(await store.saveSprint(REPO, sprint('Sprint 3', '2026-04-10', '2026-04-01'))).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/ends before it starts/) });
        expect((await store.sprints(REPO)).map((s) => s.name)).toEqual(['Sprint 1']);
      });

      it('removes a sprint by name', async () => {
        await store.saveSprint(REPO, sprint('Sprint 1', '2026-03-02', '2026-03-16'));
        expect(await store.removeSprint(REPO, 'Sprint 1')).toBe(true);
        expect(await store.removeSprint(REPO, 'Sprint 1')).toBe(false);
        expect(await store.sprints(REPO)).toEqual([]);
      });
    });

    describe('tracker tickets', () => {
      it('keeps titles and sprint membership per repo, replacing earlier data for the same key', async () => {
        await store.saveTrackerTickets(REPO, [
          { key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 1' },
          { key: 'PROJ-150', title: 'Backlog idea', sprint: null },
        ]);
        await store.saveTrackerTickets(REPO, [{ key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 2' }]);
        await store.saveTrackerTickets('github.com/acme/other', [{ key: 'X-1', title: 'Elsewhere', sprint: null }]);
        expect(await store.trackerTickets(REPO)).toEqual([
          { key: 'PROJ-142', title: 'Rate limit login', sprint: 'Sprint 2' },
          { key: 'PROJ-150', title: 'Backlog idea', sprint: null },
        ]);
      });
    });
  });
}
