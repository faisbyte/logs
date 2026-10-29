import {
  decidePush,
  hashToken,
  newToken,
  teamReportFrom,
  UploadPayloadSchema,
  type PushIdentity,
  type PushResult,
  type StoredSummary,
  type SummaryQuery,
  type SummaryStore,
  type TeamReport,
  type TokenStore,
} from '@digest/core';

// The Postgres-backed shared store (DECISIONS.md D39, D43). The push rules and query semantics are the shared
// ones from @digest/core, pinned by the same contract tests as the in-memory store.

/** The slice of node-postgres and PGlite this store needs. */
export interface Sql {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const MIGRATIONS: string[][] = [
  [
    `create table summaries (
      repo_id text not null,
      agent text not null,
      session_id text not null,
      developer_id text not null,
      developer_name text not null,
      pushed_at timestamptz not null,
      payload_hash text not null,
      retracted_at timestamptz,
      branch text,
      started_at timestamptz not null,
      ended_at timestamptz not null,
      payload jsonb not null,
      primary key (repo_id, agent, session_id)
    )`,
    'create index summaries_repo_time on summaries (repo_id, started_at)',
    `create table tokens (
      token_hash text primary key,
      repo_id text not null,
      developer_id text not null,
      developer_name text not null,
      issued_at timestamptz not null default now(),
      unique (repo_id, developer_id)
    )`,
  ],
];

/**
 * Applies any migrations not yet recorded in schema_migrations. Safe to run on every start.
 * Needs a single connection (a pg.Client or PGlite, not a pg.Pool): each migration runs in one transaction.
 */
export async function migrate(sql: Sql): Promise<void> {
  await sql.query('create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())');
  const { rows } = await sql.query<{ version: number }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  for (const [i, statements] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (applied.has(version)) continue;
    await sql.query('begin');
    try {
      for (const statement of statements) await sql.query(statement);
      await sql.query('insert into schema_migrations (version) values ($1)', [version]);
      await sql.query('commit');
    } catch (err) {
      await sql.query('rollback');
      throw err;
    }
  }
}

interface SummaryRow {
  repo_id: string;
  developer_id: string;
  developer_name: string;
  pushed_at: Date | string;
  payload_hash: string;
  retracted_at: Date | string | null;
  payload: unknown;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const toStored = (r: SummaryRow): StoredSummary => ({
  repoId: r.repo_id,
  developerId: r.developer_id,
  developerName: r.developer_name,
  pushedAt: iso(r.pushed_at),
  payloadHash: r.payload_hash,
  retractedAt: r.retracted_at === null ? null : iso(r.retracted_at),
  // jsonb reorders keys; parsing restores the schema's order and re-checks what comes back out.
  summary: UploadPayloadSchema.parse(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload),
});

export class PostgresSummaryStore implements SummaryStore, TokenStore {
  readonly #sql: Sql;
  readonly #now: () => Date;

  constructor(sql: Sql, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.#sql = sql;
    this.#now = now;
  }

  async #find(repoId: string, agent: string, sessionId: string): Promise<StoredSummary | undefined> {
    const { rows } = await this.#sql.query<SummaryRow>('select * from summaries where repo_id = $1 and agent = $2 and session_id = $3', [repoId, agent, sessionId]);
    return rows[0] && toStored(rows[0]);
  }

  async push(identity: PushIdentity, payload: unknown): Promise<PushResult> {
    const parsed = UploadPayloadSchema.safeParse(payload);
    const existing = parsed.success ? await this.#find(identity.repoId, parsed.data.agent, parsed.data.sessionId) : undefined;
    const decision = decidePush(identity, payload, () => existing, this.#now());
    if (decision.status !== 'create') return decision;
    const s = decision.stored;
    const { rows } = await this.#sql.query(
      `insert into summaries (repo_id, agent, session_id, developer_id, developer_name, pushed_at, payload_hash, branch, started_at, ended_at, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       on conflict (repo_id, agent, session_id) do nothing returning session_id`,
      [s.repoId, s.summary.agent, s.summary.sessionId, s.developerId, s.developerName, s.pushedAt, s.payloadHash, s.summary.branch, s.summary.startedAt, s.summary.endedAt, JSON.stringify(s.summary)],
    );
    if (rows.length) return { status: 'created', stored: s };
    // Another push of this session won the race: apply the rules against what it stored.
    const winner = await this.#find(s.repoId, s.summary.agent, s.summary.sessionId);
    const again = decidePush(identity, payload, () => winner, this.#now());
    return again.status === 'create' ? { status: 'conflict', reason: 'concurrent push; try again' } : again;
  }

  async list(q: SummaryQuery): Promise<StoredSummary[]> {
    const { rows } = await this.#sql.query<SummaryRow>(
      `select * from summaries
       where repo_id = $1 and retracted_at is null
         and ($2::text is null or branch = $2)
         and ($3::text is null or payload->'ticketRefs' @> jsonb_build_array($3::text))
         and ($4::text is null or developer_id = $4)
         and ($5::timestamptz is null or ended_at >= $5)
         and ($6::timestamptz is null or started_at < $6)
       order by started_at, session_id`,
      [q.repoId, q.branch ?? null, q.ticket ?? null, q.developerId ?? null, q.from ?? null, q.to ?? null],
    );
    return rows.map(toStored);
  }

  async teamReport(query: { repoId: string; from: string; to: string }): Promise<TeamReport> {
    return teamReportFrom(query, await this.list(query));
  }

  async issueToken(identity: PushIdentity): Promise<{ token: string }> {
    const token = newToken();
    await this.#sql.query(
      `insert into tokens (token_hash, repo_id, developer_id, developer_name) values ($1, $2, $3, $4)
       on conflict (repo_id, developer_id) do update set token_hash = excluded.token_hash, developer_name = excluded.developer_name, issued_at = now()`,
      [hashToken(token), identity.repoId, identity.developerId, identity.developerName],
    );
    return { token };
  }

  async authenticate(token: string): Promise<PushIdentity | null> {
    if (!token) return null;
    const { rows } = await this.#sql.query<{ repo_id: string; developer_id: string; developer_name: string }>(
      'select repo_id, developer_id, developer_name from tokens where token_hash = $1',
      [hashToken(token)],
    );
    const r = rows[0];
    return r ? { repoId: r.repo_id, developerId: r.developer_id, developerName: r.developer_name } : null;
  }
}
