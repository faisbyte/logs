import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/shared/audit.js';
import type { SharedStore } from '../../src/shared/tickets.js';

// The audit log (Phase 10, DECISIONS.md D100): who viewed or sent what. Every store implementation must pass these.

const REPO = 'github.com/acme/webapp';
const OTHER = 'github.com/acme/other';

export const auditEvent = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  repoId: REPO,
  at: '2026-11-19T10:00:00.000Z',
  actorId: 'pat',
  actorName: 'Pat (PO)',
  actorRole: 'reader',
  action: 'digest.viewed',
  target: 'd-1',
  detail: 'Sprint 1 (2026-03-02 to 2026-03-15)',
  ...over,
});

export function auditContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: audit log`, () => {
    let store: SharedStore;
    beforeEach(async () => {
      store = await make();
    });

    it('keeps each event as recorded and lists a repo’s events newest first', async () => {
      const sent = auditEvent({ at: '2026-11-19T11:00:00.000Z', actorId: 'server', actorName: 'server', actorRole: 'server', action: 'digest.sent', detail: 'email, slack' });
      const issued = auditEvent({ at: '2026-11-18T09:00:00.000Z', actorId: 'admin', actorName: 'admin', actorRole: 'admin', action: 'token.issued', target: 'alice', detail: null });
      for (const e of [auditEvent(), sent, issued, auditEvent({ repoId: OTHER })]) await store.recordAudit(e);
      expect(await store.auditEvents(REPO)).toEqual([sent, auditEvent(), issued]);
      expect(await store.auditEvents(OTHER)).toEqual([auditEvent({ repoId: OTHER })]);
    });

    it('lists only events at or after a time, and at most a number of them', async () => {
      for (const hour of ['08', '09', '10', '11']) await store.recordAudit(auditEvent({ at: `2026-11-19T${hour}:00:00.000Z`, target: `d-${hour}` }));
      expect((await store.auditEvents(REPO, { since: '2026-11-19T09:00:00.000Z' })).map((e) => e.target)).toEqual(['d-11', 'd-10', 'd-09']);
      expect((await store.auditEvents(REPO, { limit: 2 })).map((e) => e.target)).toEqual(['d-11', 'd-10']);
    });

    it('keeps the order of events recorded in the same instant, newest first', async () => {
      for (const t of ['a', 'b', 'c']) await store.recordAudit(auditEvent({ target: t }));
      expect((await store.auditEvents(REPO)).map((e) => e.target)).toEqual(['c', 'b', 'a']);
    });
  });
}
