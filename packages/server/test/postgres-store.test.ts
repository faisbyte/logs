import { afterAll, describe, expect, it } from 'vitest';
import { summaryStoreContract } from '../../core/test/shared/store-contract.js';
import { digestStoreContract } from '../../core/test/shared/digest-contract.js';
import { ticketStoreContract } from '../../core/test/shared/ticket-contract.js';
import { openPGlite } from '../src/pglite.js';
import { migrate, PostgresSummaryStore } from '../src/postgres-store.js';

// One in-process Postgres for the file; each test starts from empty tables.
const db = openPGlite();
const ready = migrate(db);
afterAll(() => db.close());

const fresh = async () => {
  await ready;
  await db.query('truncate summaries, tokens, ticket_links, sprints, tracker_tickets, digests, llm_spend, repo_settings, retractions, ticket_titles');
  return new PostgresSummaryStore(db);
};
summaryStoreContract('PostgresSummaryStore (PGlite)', fresh);
ticketStoreContract('PostgresSummaryStore (PGlite)', fresh);
digestStoreContract('PostgresSummaryStore (PGlite)', fresh);

describe('migrations', () => {
  it('can run again without changing anything', async () => {
    await ready;
    await migrate(db);
    const { rows } = await db.query<{ version: number }>('select version from schema_migrations order by version');
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
