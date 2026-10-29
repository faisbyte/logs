// Opt-in: the same contract against a real Postgres through node-postgres. Use a throwaway database;
// every test truncates the summaries and tokens tables.
// How to run it against a Docker postgres:16: docs/development.md.
import pg from 'pg';
import { afterAll, describe } from 'vitest';
import { summaryStoreContract } from '../../core/test/shared/store-contract.js';
import { migrate, PostgresSummaryStore } from '../src/postgres-store.js';

const url = process.env.DIGEST_TEST_DATABASE_URL;

describe.skipIf(!url)('real Postgres', () => {
  const pool = new pg.Pool({ connectionString: url });
  const ready = (async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await migrate(client).finally(() => client.end());
  })();
  afterAll(() => pool.end());
  summaryStoreContract('PostgresSummaryStore (node-postgres)', async () => {
    await ready;
    await pool.query('truncate summaries, tokens');
    return new PostgresSummaryStore(pool);
  });
});
