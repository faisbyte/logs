import { randomUUID } from 'node:crypto';
import {
  byFrom,
  checkNewDigest,
  decideLink,
  defaultRepoSettings,
  decidePush,
  decideRetract,
  digestSummaryKey,
  decideSprint,
  decideTitle,
  decideUnlink,
  hashToken,
  newToken,
  teamReportFrom,
  UploadPayloadSchema,
  type DigestKind,
  type DigestPatch,
  type DigestStatus,
  type DigestStore,
  type LinkResult,
  type NewDigest,
  type RepoSettings,
  type ReportKey,
  type Retraction,
  type RetractResult,
  type StoredDigest,
  type ManualTicketLink,
  type Identity,
  type PushIdentity,
  type PushResult,
  type Role,
  type SharedStore,
  type Sprint,
  type SprintResult,
  type SummaryRef,
  type TicketTitle,
  type TitleResult,
  type TrackerTicket,
  type UnlinkResult,
  type StoredSummary,
  type SummaryQuery,
  type TeamReport,
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
  [
    // Phase 6 (DECISIONS.md D45): records next to the summaries, which never change.
    `create table ticket_links (
      repo_id text not null,
      agent text not null,
      session_id text not null,
      ticket_key text not null,
      added_by text not null,
      added_at timestamptz not null,
      primary key (repo_id, agent, session_id, ticket_key),
      foreign key (repo_id, agent, session_id) references summaries (repo_id, agent, session_id)
    )`,
    `create table sprints (
      repo_id text not null,
      name text not null,
      starts_at timestamptz not null,
      ends_at timestamptz not null,
      primary key (repo_id, name)
    )`,
    `create table tracker_tickets (
      repo_id text not null,
      ticket_key text not null,
      title text,
      sprint text,
      updated_at timestamptz not null,
      primary key (repo_id, ticket_key)
    )`,
  ],
  [
    // Two concurrent saves of overlapping sprints can't both win (DECISIONS.md D45). Needs btree_gist for the
    // equality parts of the constraint; it ships with Postgres and with PGlite.
    'create extension if not exists btree_gist',
    `alter table sprints add constraint sprints_no_overlap
      exclude using gist (repo_id with =, name with <>, tstzrange(starts_at, ends_at) with &&)`,
  ],
  [
    // Read-only tokens for stakeholders (DECISIONS.md D51): one token per person, role and repo.
    "alter table tokens add column role text not null default 'developer' check (role in ('developer', 'reader'))",
    'alter table tokens drop constraint tokens_repo_id_developer_id_key',
    'alter table tokens add constraint tokens_repo_role_person unique (repo_id, role, developer_id)',
  ],
  [
    // Phase 7 (DECISIONS.md D52): digests, the LLM spend behind the monthly cap, and per-repo digest settings.
    `create table digests (
      id uuid primary key,
      repo_id text not null,
      kind text not null check (kind in ('report', 'scheduled')),
      period_key text not null,
      period_label text not null,
      period_from timestamptz,
      period_to timestamptz,
      input_hash text not null,
      prompt_version text not null,
      model text not null,
      markdown text not null,
      summary_count integer not null,
      developer_count integer not null,
      cost_usd double precision,
      status text not null check (status in ('ready', 'preview', 'sent')),
      preview_until timestamptz,
      created_at timestamptz not null,
      deliveries jsonb not null default '{}',
      sent_at timestamptz
    )`,
    "create unique index digests_one_per_scheduled_period on digests (repo_id, period_key) where kind = 'scheduled'",
    "create unique index digests_report_cache on digests (repo_id, period_key, input_hash, prompt_version, model) where kind = 'report'",
    'create table llm_spend (repo_id text not null, usd double precision not null, at timestamptz not null)',
    'create index llm_spend_repo_at on llm_spend (repo_id, at)',
    'create table repo_settings (repo_id text primary key, settings jsonb not null)',
  ],
  [
    // Retraction by the pusher (DECISIONS.md D60): its history, and which digests a summary went into.
    `create table retractions (
      repo_id text not null,
      agent text not null,
      session_id text not null,
      developer_id text not null,
      payload_hash text not null,
      retracted_at timestamptz not null
    )`,
    "alter table digests add column summary_keys jsonb not null default '[]'",
    'alter table digests drop constraint digests_status_check',
    "alter table digests add constraint digests_status_check check (status in ('ready', 'preview', 'sent', 'withdrawn'))",
  ],
  [
    // Ticket titles set by hand, for repos without a tracker (DECISIONS.md D67).
    `create table ticket_titles (
      repo_id text not null,
      ticket_key text not null,
      title text not null,
      set_by text not null,
      set_at timestamptz not null,
      primary key (repo_id, ticket_key)
    )`,
  ],
  [
    // A withdrawn scheduled digest no longer holds its period, so a corrected one can follow it (DECISIONS.md D70).
    'alter table digests add column corrects uuid',
    'drop index digests_one_per_scheduled_period',
    "create unique index digests_one_per_scheduled_period on digests (repo_id, period_key) where kind = 'scheduled' and status <> 'withdrawn'",
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

interface DigestRow {
  id: string;
  repo_id: string;
  kind: DigestKind;
  period_key: string;
  period_label: string;
  period_from: Date | string | null;
  period_to: Date | string | null;
  input_hash: string;
  prompt_version: string;
  model: string;
  markdown: string;
  summary_count: number;
  developer_count: number;
  cost_usd: number | null;
  status: DigestStatus;
  preview_until: Date | string | null;
  created_at: Date | string;
  deliveries: Record<string, string> | string;
  sent_at: Date | string | null;
  summary_keys: string[] | string;
  corrects: string | null;
}

const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));
const toDigest = (r: DigestRow): StoredDigest => ({
  repoId: r.repo_id,
  kind: r.kind,
  periodKey: r.period_key,
  periodLabel: r.period_label,
  from: isoOrNull(r.period_from),
  to: isoOrNull(r.period_to),
  inputHash: r.input_hash,
  promptVersion: r.prompt_version,
  model: r.model,
  markdown: r.markdown,
  summaryCount: r.summary_count,
  developerCount: r.developer_count,
  costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
  status: r.status,
  previewUntil: isoOrNull(r.preview_until),
  createdAt: iso(r.created_at),
  id: r.id,
  deliveries: typeof r.deliveries === 'string' ? JSON.parse(r.deliveries) : r.deliveries,
  sentAt: isoOrNull(r.sent_at),
  summaryKeys: typeof r.summary_keys === 'string' ? JSON.parse(r.summary_keys) : r.summary_keys,
  corrects: r.corrects,
});

export class PostgresSummaryStore implements SharedStore, DigestStore {
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
    if (decision.replaces) {
      const { rows } = await this.#sql.query(
        `update summaries set developer_name = $4, pushed_at = $5, payload_hash = $6, branch = $7, started_at = $8, ended_at = $9, payload = $10::jsonb, retracted_at = null
         where repo_id = $1 and agent = $2 and session_id = $3 and developer_id = $11 and retracted_at is not null returning session_id`,
        [s.repoId, s.summary.agent, s.summary.sessionId, s.developerName, s.pushedAt, s.payloadHash, s.summary.branch, s.summary.startedAt, s.summary.endedAt, JSON.stringify(s.summary), s.developerId],
      );
      return rows.length ? { status: 'created', stored: s } : { status: 'conflict', reason: 'concurrent push; try again' };
    }
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

  async retract(identity: PushIdentity, ref: { agent: StoredSummary['summary']['agent']; sessionId: string }): Promise<RetractResult> {
    const stored = await this.#find(identity.repoId, ref.agent, ref.sessionId);
    const decision = decideRetract(identity, stored);
    if (decision.status !== 'retract') return decision;
    const retractedAt = this.#now().toISOString();
    const { rows } = await this.#sql.query(
      'update summaries set retracted_at = $5 where repo_id = $1 and agent = $2 and session_id = $3 and developer_id = $4 and retracted_at is null returning session_id',
      [identity.repoId, ref.agent, ref.sessionId, identity.developerId, retractedAt],
    );
    if (!rows.length) return decideRetract(identity, await this.#find(identity.repoId, ref.agent, ref.sessionId)) as RetractResult;
    await this.#sql.query('insert into retractions (repo_id, agent, session_id, developer_id, payload_hash, retracted_at) values ($1, $2, $3, $4, $5, $6)', [
      identity.repoId,
      ref.agent,
      ref.sessionId,
      identity.developerId,
      stored!.payloadHash,
      retractedAt,
    ]);
    const key = JSON.stringify([digestSummaryKey(ref)]);
    await this.#sql.query("update digests set status = 'withdrawn' where repo_id = $1 and status = 'sent' and summary_keys @> $2::jsonb", [identity.repoId, key]);
    await this.#sql.query("delete from digests where repo_id = $1 and status <> 'withdrawn' and summary_keys @> $2::jsonb", [identity.repoId, key]);
    return { status: 'retracted', retractedAt };
  }

  async retractions(repoId: string): Promise<Retraction[]> {
    const { rows } = await this.#sql.query<{ agent: Retraction['agent']; session_id: string; developer_id: string; payload_hash: string; retracted_at: Date | string }>(
      'select agent, session_id, developer_id, payload_hash, retracted_at from retractions where repo_id = $1 order by retracted_at',
      [repoId],
    );
    return rows.map((r) => ({ repoId, agent: r.agent, sessionId: r.session_id, developerId: r.developer_id, payloadHash: r.payload_hash, retractedAt: iso(r.retracted_at) }));
  }

  async list(q: SummaryQuery): Promise<StoredSummary[]> {
    const { rows } = await this.#sql.query<SummaryRow>(
      `select * from summaries
       where repo_id = $1 and retracted_at is null
         and ($2::text is null or branch = $2)
         and ($3::text is null or payload->'ticketRefs' @> jsonb_build_array($3::text)
              or exists (select 1 from ticket_links l where l.repo_id = summaries.repo_id and l.agent = summaries.agent and l.session_id = summaries.session_id and l.ticket_key = $3))
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

  async issueToken(identity: PushIdentity, role: Role = 'developer'): Promise<{ token: string }> {
    const token = newToken();
    await this.#sql.query(
      `insert into tokens (token_hash, repo_id, developer_id, developer_name, role) values ($1, $2, $3, $4, $5)
       on conflict (repo_id, role, developer_id) do update set token_hash = excluded.token_hash, developer_name = excluded.developer_name, issued_at = now()`,
      [hashToken(token), identity.repoId, identity.developerId, identity.developerName, role],
    );
    return { token };
  }

  async authenticate(token: string): Promise<Identity | null> {
    if (!token) return null;
    const { rows } = await this.#sql.query<{ repo_id: string; developer_id: string; developer_name: string; role: Role }>(
      'select repo_id, developer_id, developer_name, role from tokens where token_hash = $1',
      [hashToken(token)],
    );
    const r = rows[0];
    return r ? { repoId: r.repo_id, developerId: r.developer_id, developerName: r.developer_name, role: r.role } : null;
  }

  async #linked(repoId: string, ref: SummaryRef, ticketKey: string): Promise<boolean> {
    const { rows } = await this.#sql.query('select 1 from ticket_links where repo_id = $1 and agent = $2 and session_id = $3 and ticket_key = $4', [repoId, ref.agent, ref.sessionId, ticketKey]);
    return rows.length > 0;
  }

  async addTicketLink(identity: PushIdentity, ref: SummaryRef, ticketKey: string): Promise<LinkResult> {
    const stored = await this.#find(identity.repoId, ref.agent, ref.sessionId);
    const linked = typeof ticketKey === 'string' && (await this.#linked(identity.repoId, ref, ticketKey));
    const decision = decideLink(identity, stored, ticketKey, linked);
    if (decision.status !== 'create') return decision;
    const { rows } = await this.#sql.query(
      `insert into ticket_links (repo_id, agent, session_id, ticket_key, added_by, added_at) values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing returning ticket_key`,
      [identity.repoId, ref.agent, ref.sessionId, ticketKey, identity.developerId, this.#now().toISOString()],
    );
    return { status: rows.length ? 'created' : 'unchanged' };
  }

  async removeTicketLink(identity: PushIdentity, ref: SummaryRef, ticketKey: string): Promise<UnlinkResult> {
    const stored = await this.#find(identity.repoId, ref.agent, ref.sessionId);
    const decision = decideUnlink(identity, stored, ticketKey, await this.#linked(identity.repoId, ref, ticketKey));
    if (decision.status !== 'remove') return decision;
    await this.#sql.query('delete from ticket_links where repo_id = $1 and agent = $2 and session_id = $3 and ticket_key = $4', [identity.repoId, ref.agent, ref.sessionId, ticketKey]);
    return { status: 'removed' };
  }

  async ticketLinks(repoId: string): Promise<ManualTicketLink[]> {
    const { rows } = await this.#sql.query<{ agent: ManualTicketLink['agent']; session_id: string; ticket_key: string; added_by: string; added_at: Date | string }>(
      'select agent, session_id, ticket_key, added_by, added_at from ticket_links where repo_id = $1 order by added_at, ticket_key',
      [repoId],
    );
    return rows.map((r) => ({ repoId, agent: r.agent, sessionId: r.session_id, ticketKey: r.ticket_key, addedBy: r.added_by, addedAt: iso(r.added_at) }));
  }

  async saveSprint(repoId: string, sprint: Sprint): Promise<SprintResult> {
    const decision = decideSprint(await this.sprints(repoId), sprint);
    if (decision.status !== 'save') return decision;
    const s = decision.sprint;
    try {
      await this.#sql.query(
        `insert into sprints (repo_id, name, starts_at, ends_at) values ($1, $2, $3, $4)
         on conflict (repo_id, name) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at`,
        [repoId, s.name, s.from, s.to],
      );
    } catch (err) {
      // exclusion_violation: an overlapping sprint was saved after the check above.
      if ((err as { code?: string }).code !== '23P01') throw err;
      const again = decideSprint(await this.sprints(repoId), sprint);
      return again.status === 'invalid' ? again : { status: 'invalid', reason: `${s.name} overlaps another sprint` };
    }
    return { status: 'saved' };
  }

  async removeSprint(repoId: string, name: string): Promise<boolean> {
    const { rows } = await this.#sql.query('delete from sprints where repo_id = $1 and name = $2 returning name', [repoId, name]);
    return rows.length > 0;
  }

  async sprints(repoId: string): Promise<Sprint[]> {
    const { rows } = await this.#sql.query<{ name: string; starts_at: Date | string; ends_at: Date | string }>('select name, starts_at, ends_at from sprints where repo_id = $1', [repoId]);
    return rows.map((r) => ({ name: r.name, from: iso(r.starts_at), to: iso(r.ends_at) })).sort(byFrom);
  }

  async saveTrackerTickets(repoId: string, tickets: TrackerTicket[]): Promise<void> {
    for (const t of tickets) {
      await this.#sql.query(
        `insert into tracker_tickets (repo_id, ticket_key, title, sprint, updated_at) values ($1, $2, $3, $4, $5)
         on conflict (repo_id, ticket_key) do update set title = excluded.title, sprint = excluded.sprint, updated_at = excluded.updated_at`,
        [repoId, t.key, t.title, t.sprint, this.#now().toISOString()],
      );
    }
  }

  async trackerTickets(repoId: string): Promise<TrackerTicket[]> {
    const { rows } = await this.#sql.query<{ ticket_key: string; title: string | null; sprint: string | null }>('select ticket_key, title, sprint from tracker_tickets where repo_id = $1', [repoId]);
    return rows.map((r) => ({ key: r.ticket_key, title: r.title, sprint: r.sprint })).sort((a, b) => a.key.localeCompare(b.key));
  }

  async saveDigest(digest: NewDigest): Promise<StoredDigest> {
    checkNewDigest(digest);
    const d = digest;
    const { rows } = await this.#sql.query<DigestRow>(
      `insert into digests (id, repo_id, kind, period_key, period_label, period_from, period_to, input_hash, prompt_version, model,
         markdown, summary_count, developer_count, cost_usd, status, preview_until, created_at, summary_keys, corrects)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)
       on conflict do nothing returning *`,
      [randomUUID(), d.repoId, d.kind, d.periodKey, d.periodLabel, d.from, d.to, d.inputHash, d.promptVersion, d.model, d.markdown, d.summaryCount, d.developerCount, d.costUsd, d.status, d.previewUntil, d.createdAt, JSON.stringify(d.summaryKeys ?? []), d.corrects ?? null],
    );
    if (rows[0]) return toDigest(rows[0]);
    // The scheduled period or cached report already exists: keep that one.
    const existing = d.kind === 'scheduled' ? await this.scheduledDigest(d.repoId, d.periodKey) : await this.findReport(d.repoId, d);
    if (!existing) throw new Error('digest insert conflicted, but no matching digest was found');
    return existing;
  }

  async getDigest(repoId: string, id: string): Promise<StoredDigest | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.#sql.query<DigestRow>('select * from digests where repo_id = $1 and id = $2', [repoId, id]);
    return rows[0] ? toDigest(rows[0]) : null;
  }

  async findReport(repoId: string, key: ReportKey): Promise<StoredDigest | null> {
    const { rows } = await this.#sql.query<DigestRow>(
      "select * from digests where repo_id = $1 and kind = 'report' and period_key = $2 and input_hash = $3 and prompt_version = $4 and model = $5",
      [repoId, key.periodKey, key.inputHash, key.promptVersion, key.model],
    );
    return rows[0] ? toDigest(rows[0]) : null;
  }

  async scheduledDigest(repoId: string, periodKey: string): Promise<StoredDigest | null> {
    const { rows } = await this.#sql.query<DigestRow>("select * from digests where repo_id = $1 and kind = 'scheduled' and period_key = $2 and status <> 'withdrawn'", [repoId, periodKey]);
    return rows[0] ? toDigest(rows[0]) : null;
  }

  async digests(repoId: string, filter: { kinds?: DigestKind[]; statuses?: DigestStatus[] } = {}): Promise<StoredDigest[]> {
    const { rows } = await this.#sql.query<DigestRow>(
      `select * from digests where repo_id = $1
         and ($2::text[] is null or kind = any($2::text[]))
         and ($3::text[] is null or status = any($3::text[]))
       order by created_at desc, id desc`,
      [repoId, filter.kinds ?? null, filter.statuses ?? null],
    );
    return rows.map(toDigest);
  }

  async updateDigest(repoId: string, id: string, patch: DigestPatch): Promise<void> {
    await this.#sql.query(
      `update digests set
         status = coalesce($3, status),
         sent_at = coalesce($4, sent_at),
         preview_until = coalesce($5, preview_until),
         deliveries = deliveries || $6::jsonb
       where repo_id = $1 and id = $2`,
      [repoId, id, patch.status ?? null, patch.sentAt ?? null, patch.previewUntil ?? null, JSON.stringify(patch.deliveries ?? {})],
    );
  }

  async recordSpend(repoId: string, usd: number, at: string): Promise<void> {
    await this.#sql.query('insert into llm_spend (repo_id, usd, at) values ($1, $2, $3)', [repoId, usd, at]);
  }

  async spendSince(repoId: string, since: string): Promise<number> {
    const { rows } = await this.#sql.query<{ total: number | string | null }>('select sum(usd) as total from llm_spend where repo_id = $1 and at >= $2', [repoId, since]);
    return Number(rows[0]?.total ?? 0);
  }

  async repoSettings(repoId: string): Promise<RepoSettings> {
    const { rows } = await this.#sql.query<{ settings: RepoSettings | string }>('select settings from repo_settings where repo_id = $1', [repoId]);
    const stored = rows[0] ? (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings) : {};
    return { ...defaultRepoSettings(repoId), ...stored, repoId };
  }

  async saveRepoSettings(repoId: string, patch: Partial<Omit<RepoSettings, 'repoId'>>): Promise<RepoSettings> {
    const next = { ...(await this.repoSettings(repoId)), ...patch, repoId };
    await this.#sql.query(
      'insert into repo_settings (repo_id, settings) values ($1, $2::jsonb) on conflict (repo_id) do update set settings = excluded.settings',
      [repoId, JSON.stringify(next)],
    );
    return next;
  }

  async scheduledRepos(): Promise<string[]> {
    const { rows } = await this.#sql.query<{ repo_id: string }>("select repo_id from repo_settings where settings->>'schedule' <> 'off' order by repo_id");
    return rows.map((r) => r.repo_id);
  }

  async setTicketTitle(identity: PushIdentity, ticketKey: string, title: string): Promise<TitleResult> {
    const decision = decideTitle(ticketKey, title);
    if (decision.status !== 'save') return decision;
    await this.#sql.query(
      `insert into ticket_titles (repo_id, ticket_key, title, set_by, set_at) values ($1, $2, $3, $4, $5)
       on conflict (repo_id, ticket_key) do update set title = excluded.title, set_by = excluded.set_by, set_at = excluded.set_at`,
      [identity.repoId, ticketKey, decision.title, identity.developerId, this.#now().toISOString()],
    );
    return { status: 'saved' };
  }

  async ticketTitles(repoId: string): Promise<TicketTitle[]> {
    const { rows } = await this.#sql.query<{ ticket_key: string; title: string; set_by: string; set_at: Date | string }>('select ticket_key, title, set_by, set_at from ticket_titles where repo_id = $1', [repoId]);
    return rows.map((r) => ({ key: r.ticket_key, title: r.title, setBy: r.set_by, setAt: iso(r.set_at) })).sort((a, b) => a.key.localeCompare(b.key));
  }
}
