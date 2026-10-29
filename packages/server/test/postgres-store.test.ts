import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { summaryStoreContract } from '../../core/test/shared/store-contract.js';
import { migrate, PostgresSummaryStore } from '../src/postgres-store.js';

// One in-process Postgres for the file; each test starts from empty tables.
const db = new PGlite();
const ready = migrate(db);
afterAll(() => db.close());

summaryStoreContract('PostgresSummaryStore (PGlite)', async () => {
  await ready;
  await db.query('truncate summaries, tokens');
  return new PostgresSummaryStore(db);
});

describe('migrations', () => {
  it('can run again without changing anything', async () => {
    await ready;
    await migrate(db);
    const { rows } = await db.query<{ version: number }>('select version from schema_migrations order by version');
    expect(rows.map((r) => r.version)).toEqual([1]);
  });
});
