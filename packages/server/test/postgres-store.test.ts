import { afterAll, describe, expect, it } from 'vitest';
import { summaryStoreContract } from '../../core/test/shared/store-contract.js';
import { digestStoreContract } from '../../core/test/shared/digest-contract.js';
import { ticketStoreContract } from '../../core/test/shared/ticket-contract.js';
import { contextStoreContract } from '../../core/test/shared/context-contract.js';
import { sessionContract } from '../../core/test/shared/session-contract.js';
import { auditContract } from '../../core/test/shared/audit-contract.js';
import { costContract } from '../../core/test/cost/cost-contract.js';
import { costIngestContract } from '../../core/test/cost/ingest-contract.js';
import { costReportContract } from '../../core/test/cost/report-contract.js';
import { costFlagsContract } from '../../core/test/cost/flags-contract.js';
import { dataDeletionContract, retentionContract } from '../../core/test/shared/data-contract.js';
import { openPGlite } from '../src/pglite.js';
import { migrate, PostgresSummaryStore } from '../src/postgres-store.js';

// One in-process Postgres for the file; each test starts from empty tables.
const db = openPGlite();
const ready = migrate(db);
afterAll(() => db.close());

const fresh = async () => {
  await ready;
  await db.query('truncate summaries, tokens, ticket_links, sprints, tracker_tickets, digests, llm_spend, repo_settings, retractions, ticket_titles, context_items, context_runs, sessions, audit_events, cost_usage, cost_commits, cost_flags, cost_config');
  return new PostgresSummaryStore(db);
};
summaryStoreContract('PostgresSummaryStore (PGlite)', fresh);
ticketStoreContract('PostgresSummaryStore (PGlite)', fresh);
digestStoreContract('PostgresSummaryStore (PGlite)', fresh);
contextStoreContract('PostgresSummaryStore (PGlite)', fresh);
sessionContract('PostgresSummaryStore (PGlite)', async (now) => (await fresh(), new PostgresSummaryStore(db, { now })));
dataDeletionContract('PostgresSummaryStore (PGlite)', fresh);
retentionContract('PostgresSummaryStore (PGlite)', fresh);
auditContract('PostgresSummaryStore (PGlite)', fresh);
costContract('PostgresSummaryStore (PGlite)', fresh);
costIngestContract('PostgresSummaryStore (PGlite)', fresh);
costReportContract('PostgresSummaryStore (PGlite)', fresh);
costFlagsContract('PostgresSummaryStore (PGlite)', fresh);

describe('migrations', () => {
  it('can run again without changing anything', async () => {
    await ready;
    await migrate(db);
    const { rows } = await db.query<{ version: number }>('select version from schema_migrations order by version');
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe('transactions on a connection pool', () => {
  // A pg.Pool hands each query to whichever connection is free, so begin and commit through pool.query can land on
  // different connections. A transaction must check out one connection and run every statement on it.
  function fakePool() {
    const log: { conn: string; text: string }[] = [];
    let n = 0;
    const conn = (name: string) => ({ query: async (text: string) => (log.push({ conn: name, text: text.trim().split(/\s+/)[0]!.toLowerCase() }), { rows: [] }) });
    const released: string[] = [];
    return {
      log,
      released,
      pool: {
        query: async (text: string) => conn(`pool-${n++}`).query(text),
        checkout: async () => {
          const name = `client-${n++}`;
          return { ...conn(name), release: () => void released.push(name) };
        },
      },
    };
  }
  const item = { id: 'ctx-0000000a', repoId: 'r', type: 'decision' as const, text: 'Counts are per account.', reason: 'Offices share an address.', paths: ['src/a.ts'], tickets: [], sources: ['claude-code/s1'], date: '2026-04-07', status: 'active' as const, supersededBy: null, retiredBy: null, retiredAt: null, createdAt: '2026-04-08T00:00:00.000Z' };

  it('runs a context change, from begin to commit, on one checked-out connection, then releases it', async () => {
    const { pool, log, released } = fakePool();
    await new PostgresSummaryStore(pool).applyContextChanges('r', { added: [item], merged: [], superseded: [{ id: 'ctx-0000000b', by: 'ctx-0000000a' }] });
    expect(log.map((l) => l.text)).toEqual(['begin', 'insert', 'update', 'commit']);
    expect(new Set(log.map((l) => l.conn)).size).toBe(1);
    expect(log[0]!.conn).toMatch(/^client-/);
    expect(released).toEqual([log[0]!.conn]);
  });
});
