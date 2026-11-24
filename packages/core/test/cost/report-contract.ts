import { beforeEach, describe, expect, it } from 'vitest';
import { enableCost, recordCommit, removeAccount, saveAccount } from '../../src/cost/ingest.js';
import { costAccess, costCsv, costReport, grantCost, revokeCost, savePrice } from '../../src/cost/report.js';
import type { SharedStore } from '../../src/shared/tickets.js';
import type { Identity } from '../../src/shared/store.js';
import { payloadFor } from '../shared/store-contract.js';
import { costRecord, REPO } from './cost-contract.js';

// The cost view (Phase 12, D107): one set of numbers, for whoever may see them. Tracking only: no ranks, no scores. Run on every store.

export function costReportContract(name: string, make: () => Promise<SharedStore> | SharedStore) {
  describe(`${name}: cost report`, () => {
    const API = 'github.com/acme/api';
    const START = new Date('2026-04-01T00:00:00.000Z');
    const PERIOD = { from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z' };
    const who = (developerId: string, role: Identity['role'], repoId = REPO): Identity => ({ repoId, developerId, developerName: developerId, role });
    const pat = who('pat', 'reader');
    const account = (id: string, repoId = REPO) => ({ repoId, email: `${id}@acme.example`, developerId: id, developerName: id === 'alice' ? 'Alice' : 'Bob', organizationId: null, billing: 'subscription' as const });

    let store: SharedStore;
    beforeEach(async () => {
      store = await make();
      await enableCost(store, REPO, START);
      for (const id of ['alice', 'bob']) await saveAccount(store, account(id));
      await grantCost(store, REPO, 'pat');
    });
    const report = async (as: Identity = pat, period = PERIOD) => {
      const r = await costReport(store, as, period);
      if (r.status !== 'ok') throw new Error(r.status);
      return r.report;
    };

    describe('costAccess', () => {
      it('gives a reader everything only when granted, a developer their own, and nobody anything where tracking is off', async () => {
        expect(await costAccess(store, pat)).toBe('all');
        expect(await costAccess(store, who('kim', 'reader'))).toBe('none');
        expect(await costAccess(store, who('alice', 'developer'))).toBe('own');
        // A developer who happens to share the granted reader's id is still a developer.
        expect(await costAccess(store, who('pat', 'developer'))).toBe('own');
        expect(await costAccess(store, who('pat', 'reader', API))).toBe('off');
        await revokeCost(store, REPO, 'pat');
        expect(await costAccess(store, pat)).toBe('none');
        expect(await costReport(store, pat, PERIOD)).toEqual({ status: 'none' });
      });
    });

    describe('costReport', () => {
      it('totals the period by developer (by name, never by amount), model and place, with one row per session and day', async () => {
        await store.recordUsage([
          costRecord({ key: '1', cacheReadTokens: 10, costMicros: 100_000 }),
          costRecord({ key: '2', cacheReadTokens: 10, at: '2026-04-07T11:00:00.000Z', model: 'claude-haiku-5-5', costMicros: 50_000 }),
          costRecord({ key: '3', cacheReadTokens: 10, at: '2026-04-08T01:00:00.000Z', costMicros: 25_000 }),
          costRecord({ key: '4', developerId: 'bob', developerName: 'Bob', sessionId: 's9', costMicros: 900_000, place: 'outside', repoId: null, billing: 'api' }),
          costRecord({ key: 'out', at: '2026-04-20T00:00:00.000Z' }),
        ]);
        const r = await report();
        expect(r).toMatchObject({
          repoId: REPO,
          ...PERIOD,
          scope: 'all',
          totalMicros: 1_075_000,
          billing: { api: 900_000, subscription: 175_000, unknown: 0 },
          places: { shared: 175_000, company: 0, outside: 900_000, unknown: 0 },
          unpricedRequests: 0,
          developers: [
            { developerId: 'alice', developerName: 'Alice', micros: 175_000, sessions: 1 },
            { developerId: 'bob', developerName: 'Bob', micros: 900_000, sessions: 1 },
          ],
          models: [{ model: 'claude-haiku-5-5', micros: 50_000 }, { model: 'claude-opus-5-5', micros: 1_025_000 }],
        });
        expect(r.sessions.map((s) => [s.date, s.developerId, s.micros])).toEqual([['2026-04-08', 'alice', 25_000], ['2026-04-07', 'alice', 150_000], ['2026-04-07', 'bob', 900_000]]);
        expect(r.sessions[1]).toEqual({
          agent: 'claude-code', sessionId: 's1', developerId: 'alice', developerName: 'Alice', date: '2026-04-07', startedAt: '2026-04-07T10:00:00.000Z', endedAt: '2026-04-07T11:00:00.000Z',
          requests: 2, models: ['claude-haiku-5-5', 'claude-opus-5-5'], inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 600, micros: 150_000, unpricedRequests: 0,
          billing: 'subscription', place: 'shared', repoId: REPO, commits: [], tickets: [], flags: [],
        });
      });

      it('shows a developer exactly the rows a manager sees of them, and no one else’s', async () => {
        await store.recordUsage([costRecord({ key: '1' }), costRecord({ key: '2', developerId: 'bob', developerName: 'Bob' })]);
        const own = await report(who('alice', 'developer'));
        expect(own.scope).toBe('own');
        expect(own.sessions).toEqual((await report()).sessions.filter((s) => s.developerId === 'alice'));
        expect(JSON.stringify(own)).not.toMatch(/bob/i);
        expect((await report(who('zed', 'developer'))).sessions).toEqual([]);
      });

      it('covers only developers registered on this repo', async () => {
        await store.recordUsage([costRecord({ key: '1', developerId: 'carol', developerName: 'Carol' })]);
        expect((await report()).sessions).toEqual([]);
      });

      it('keeps the past cost of a developer whose account was removed', async () => {
        await store.recordUsage([costRecord()]);
        await removeAccount(store, REPO, 'alice@acme.example', new Date('2026-04-09T00:00:00.000Z'));
        expect((await report()).sessions).toHaveLength(1);
      });

      it('labels another team’s repo without naming it, unless the viewer has cost access there too', async () => {
        await store.recordUsage([costRecord({ repoId: API })]);
        let r = await report();
        expect(r.sessions).toMatchObject([{ place: 'company', repoId: null }]);
        expect(JSON.stringify(r)).not.toContain(API);
        await enableCost(store, API, START);
        await grantCost(store, API, 'pat');
        r = await report();
        expect(r.sessions).toMatchObject([{ place: 'shared', repoId: API }]);
      });

      it('shows commit hashes for shared repos only, on the day they were made', async () => {
        const alice = who('alice', 'developer');
        await store.recordUsage([costRecord({ key: '1' }), costRecord({ key: '2', at: '2026-04-08T09:00:00.000Z' })]);
        await recordCommit(store, alice, { agent: 'claude-code', sessionId: 's1', sha: 'a'.repeat(40) }, new Date('2026-04-08T10:00:00.000Z'));
        await recordCommit(store, alice, { agent: 'claude-code', sessionId: 's1', sha: 'b'.repeat(40) }, new Date('2026-04-12T10:00:00.000Z'));
        await store.saveCommit({ repoId: API, agent: 'claude-code', sessionId: 's1', developerId: 'alice', sha: 'c'.repeat(40), at: '2026-04-08T10:00:00.000Z' });
        // Another developer's commit on the same session id never lands on hers.
        await store.saveCommit({ repoId: REPO, agent: 'claude-code', sessionId: 's1', developerId: 'bob', sha: 'd'.repeat(40), at: '2026-04-08T10:00:00.000Z' });
        expect((await report()).sessions.map((s) => [s.date, s.commits.map((c) => c.sha[0])])).toEqual([['2026-04-08', ['a', 'b']], ['2026-04-07', []]]);
      });

      it('places an agent that reports no repo by its approved summary or its commits, and otherwise leaves it unknown', async () => {
        const unknown = { agent: 'codex' as const, place: 'unknown' as const, repoId: null };
        await store.recordUsage([costRecord({ key: '1', ...unknown, sessionId: 'x1' }), costRecord({ key: '2', ...unknown, sessionId: 'x2' }), costRecord({ key: '3', ...unknown, sessionId: 'x3' })]);
        await store.push(who('alice', 'developer'), payloadFor({ agent: 'codex', sessionId: 'x1.p2', ticketRefs: [], ticketSources: {} }));
        await recordCommit(store, who('alice', 'developer'), { agent: 'codex', sessionId: 'x2', sha: 'a'.repeat(40) }, new Date('2026-04-07T10:00:00.000Z'));
        const places = Object.fromEntries((await report()).sessions.map((s) => [s.sessionId, [s.place, s.repoId]]));
        expect(places).toEqual({ x1: ['shared', REPO], x2: ['shared', REPO], x3: ['unknown', null] });
      });

      it('splits a session evenly across its tickets so they add up, and shows the rest as no ticket', async () => {
        const alice = who('alice', 'developer');
        await store.push(alice, payloadFor({ sessionId: 's1', ticketRefs: ['PROJ-1', 'PROJ-2'], ticketSources: {} }));
        await store.push(alice, payloadFor({ sessionId: 's2.p1', ticketRefs: ['PROJ-1'], ticketSources: {} }));
        await store.setTicketTitle(alice, 'PROJ-1', 'Account lockout');
        await store.recordUsage([
          costRecord({ key: '1', costMicros: 101 }),
          costRecord({ key: '2', sessionId: 's2', costMicros: 10 }),
          costRecord({ key: '3', sessionId: 's3', costMicros: 7 }),
          costRecord({ key: '4', sessionId: 's4', costMicros: 5_000, place: 'outside', repoId: null }),
        ]);
        const r = await report();
        expect(r.tickets).toEqual([{ ticket: 'PROJ-1', title: 'Account lockout', micros: 61 }, { ticket: 'PROJ-2', title: null, micros: 50 }, { ticket: null, title: null, micros: 7 }]);
        expect(r.sessions.find((s) => s.sessionId === 's1')!.tickets).toEqual(['PROJ-1', 'PROJ-2']);
      });

      it('never shows what an unapproved or retracted session was about', async () => {
        const alice = who('alice', 'developer');
        await store.push(alice, payloadFor({ sessionId: 's1', ticketRefs: ['PROJ-1'], ticketSources: {} }));
        await store.retract(alice, { agent: 'claude-code', sessionId: 's1' });
        await store.recordUsage([costRecord()]);
        const r = await report();
        expect(r.sessions).toMatchObject([{ tickets: [] }]);
        for (const text of [payloadFor().goal, payloadFor().whatWasDone, 'PROJ-1']) expect(JSON.stringify(r)).not.toContain(text);
      });

      it('prices models whose agent reports no cost from the price in force that day, and counts what it can’t price', async () => {
        const codex = { agent: 'codex' as const, costMicros: null, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 };
        await savePrice(store, { model: 'gpt-test', from: '2026-01-01', inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 0 });
        await savePrice(store, { model: 'gpt-test', from: '2026-04-08', inputPerMTok: 2, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 0 });
        await store.recordUsage([
          costRecord({ key: '1', ...codex, model: 'gpt-test', sessionId: 'a' }),
          costRecord({ key: '2', ...codex, model: 'gpt-test', sessionId: 'b', at: '2026-04-08T00:00:00.000Z' }),
          costRecord({ key: '3', ...codex, model: 'gpt-other', sessionId: 'c' }),
        ]);
        const r = await report();
        expect(Object.fromEntries(r.sessions.map((s) => [s.sessionId, s.micros]))).toEqual({ a: 2_200_000, b: 4_400_000, c: null });
        expect(r).toMatchObject({ totalMicros: 6_600_000, unpricedRequests: 1 });
      });
    });

    describe('costCsv', () => {
      it('has one line per session and day, and can’t start a spreadsheet formula', async () => {
        await store.recordUsage([costRecord({ developerName: '=HYPERLINK("x")' }), costRecord({ key: 'n', sessionId: 's2', costMicros: null, model: 'gpt-x', place: 'outside', repoId: null, at: '2026-04-06T00:00:00.000Z' })]);
        expect(costCsv(await report()).split('\n')).toEqual([
          'date,developer,agent,session,models,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_usd,billing,place,repo,commits,tickets,flagged',
          `2026-04-07,"'=HYPERLINK(""x"")",claude-code,s1,claude-opus-5-5,1,100,50,2000000000000,300,0.250000,subscription,shared,${REPO},,,no`,
          '2026-04-06,Alice,claude-code,s2,gpt-x,1,100,50,2000000000000,300,,subscription,outside,,,,no',
          '',
        ]);
      });
    });
  });
}
