// Opt-in: the same contract against a real Postgres through node-postgres. Use a throwaway database;
// every test empties its tables.
// How to run it against a Docker postgres:16: docs/development.md.
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { summaryStoreContract } from '../../core/test/shared/store-contract.js';
import { digestStoreContract } from '../../core/test/shared/digest-contract.js';
import { ticketStoreContract } from '../../core/test/shared/ticket-contract.js';
import { contextStoreContract } from '../../core/test/shared/context-contract.js';
import { migrate, PostgresSummaryStore } from '../src/postgres-store.js';

const url = process.env.DIGEST_TEST_DATABASE_URL;

describe.skipIf(!url)('real Postgres', () => {
  // Connect in beforeAll, never at collection: vitest still runs a skipped suite's body, and pg with no URL
  // would try localhost:5432.
  let pool: pg.Pool;
  beforeAll(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await migrate(client).finally(() => client.end());
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(() => pool?.end());
  const fresh = async () => {
    await pool.query('truncate summaries, tokens, ticket_links, sprints, tracker_tickets, digests, llm_spend, repo_settings, retractions, ticket_titles, context_items');
    return new PostgresSummaryStore(pool);
  };
  summaryStoreContract('PostgresSummaryStore (node-postgres)', fresh);
  ticketStoreContract('PostgresSummaryStore (node-postgres)', fresh);
  digestStoreContract('PostgresSummaryStore (node-postgres)', fresh);
  contextStoreContract('PostgresSummaryStore (node-postgres)', fresh);
});
