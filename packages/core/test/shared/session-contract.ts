import { inspect } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HOURS } from '../../src/shared/store.js';
import type { SharedStore } from '../../src/shared/tickets.js';

// Dashboard sessions (DECISIONS.md D91, option B): a token is exchanged once for a short-lived session id, stored
// only as a hash. Every store implementation must pass these. `make` receives the store's clock.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const HOUR = 3_600_000;

export function sessionContract(name: string, make: (now: () => Date) => Promise<SharedStore> | SharedStore) {
  describe(`${name}: dashboard sessions`, () => {
    let store: SharedStore;
    let clock: Date;
    beforeEach(async () => {
      clock = new Date('2026-11-04T09:00:00.000Z');
      store = await make(() => clock);
    });

    it(`starts a ${SESSION_HOURS}-hour session from a valid token, which then authenticates as the token's identity and role`, async () => {
      const { token } = await store.issueToken(alice, 'reader');
      const started = await store.startSession(token);
      expect(started).toEqual({ session: expect.stringMatching(/^dgs_[A-Za-z0-9_-]{40,}$/), expiresAt: '2026-11-04T21:00:00.000Z', identity: { ...alice, role: 'reader' } });
      expect(await store.authenticateSession(started!.session)).toEqual({ ...alice, role: 'reader' });
      expect(await store.startSession(`${token}x`)).toBeNull();
      expect(await store.startSession('')).toBeNull();
      expect(await store.authenticateSession('dgs_unknown')).toBeNull();
      expect(await store.authenticateSession('')).toBeNull();
    });

    it('ends a session at once on logout, and says when there was none', async () => {
      const { session } = (await store.startSession((await store.issueToken(alice)).token))!;
      expect(await store.endSession(session)).toBe(true);
      expect(await store.authenticateSession(session)).toBeNull();
      expect(await store.endSession(session)).toBe(false);
    });

    it('expires a session after its hours, and ends every session of a token that is re-issued', async () => {
      const first = (await store.issueToken(alice)).token;
      const { session } = (await store.startSession(first))!;
      clock = new Date(clock.getTime() + SESSION_HOURS * HOUR - 1);
      expect(await store.authenticateSession(session)).not.toBeNull();
      clock = new Date(clock.getTime() + 1);
      expect(await store.authenticateSession(session)).toBeNull();

      const live = (await store.startSession(first))!.session;
      await store.issueToken(alice);
      expect(await store.authenticateSession(live)).toBeNull();
    });

    it('stores only a hash of each session id', async () => {
      const { session } = (await store.startSession((await store.issueToken(alice)).token))!;
      expect(inspect(store, { depth: 10, showHidden: true })).not.toContain(session.slice(4));
    });
  });
}
