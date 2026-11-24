import type { Agent } from '../schema.js';
import { linksOf } from '../shared/ticket-report.js';
import type { Identity } from '../shared/store.js';
import type { SharedStore } from '../shared/tickets.js';
import { costEnabled } from './ingest.js';
import type { CostFlag, CostPrice, CostRecord, CostStore } from './store.js';

// The cost view (Phase 12, DECISIONS.md D107). Amounts are estimates, in millionths of a US dollar. A manager or PO with
// cost access sees the developers registered on the repo; a developer sees their own rows, the same ones. Nothing is
// ranked: developers are listed by name.

const grantKey = (repoId: string, readerId: string) => JSON.stringify([repoId, readerId]);
export const grantCost = (store: CostStore, repoId: string, readerId: string) => store.putCostConfig('grant', grantKey(repoId, readerId), { repoId, readerId });
export const revokeCost = (store: CostStore, repoId: string, readerId: string) => store.removeCostConfig('grant', grantKey(repoId, readerId));
export const savePrice = (store: CostStore, price: CostPrice) => store.putCostConfig('price', JSON.stringify([price.model, price.from]), price);

/** off: tracking is off for the repo; none: a reader without cost access. */
export type CostAccess = 'all' | 'own' | 'none' | 'off';

export async function costAccess(store: CostStore, who: Identity): Promise<CostAccess> {
  if (!(await costEnabled(store, who.repoId))) return 'off';
  if (who.role === 'developer') return 'own';
  return (await store.costConfig('grant')).some((g) => g.repoId === who.repoId && g.readerId === who.developerId) ? 'all' : 'none';
}

/** shared: a repo the viewer has cost access to; company: another company repo, not named. */
export type ViewPlace = 'shared' | 'company' | 'outside' | 'unknown';

/** One session on one UTC day. */
export interface CostSession {
  agent: Agent;
  sessionId: string;
  developerId: string;
  developerName: string;
  date: string;
  startedAt: string;
  endedAt: string;
  requests: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when no request could be priced. */
  micros: number | null;
  unpricedRequests: number;
  billing: CostRecord['billing'];
  place: ViewPlace;
  repoId: string | null;
  commits: { repoId: string; sha: string }[];
  /** From approved summaries of this repo only. */
  tickets: string[];
  flags: CostFlag[];
}

export interface CostReport {
  repoId: string;
  from: string;
  to: string;
  scope: 'all' | 'own';
  totalMicros: number;
  billing: { api: number; subscription: number; unknown: number };
  places: Record<ViewPlace, number>;
  unpricedRequests: number;
  developers: { developerId: string; developerName: string; micros: number; sessions: number }[];
  models: { model: string; micros: number }[];
  /** This repo's work by ticket, a session on several split evenly; ticket null is work linked to none. */
  tickets: { ticket: string | null; title: string | null; micros: number }[];
  /** Newest day first, then by developer. */
  sessions: CostSession[];
}

export type CostReportResult = { status: 'ok'; report: CostReport } | { status: 'none' | 'off' };

function pricer(prices: CostPrice[]) {
  return (r: CostRecord): number | null => {
    if (r.costMicros !== null) return r.costMicros;
    const day = r.at.slice(0, 10);
    const price = prices.filter((p) => p.model === r.model && p.from <= day).sort((a, b) => (a.from < b.from ? 1 : -1))[0];
    if (!price) return null;
    // Dollars per million tokens is micro-dollars per token.
    return Math.round(r.inputTokens * price.inputPerMTok + r.outputTokens * price.outputPerMTok + r.cacheReadTokens * price.cacheReadPerMTok + r.cacheWriteTokens * price.cacheWritePerMTok);
  };
}

const byText = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const sessionOf = (x: { agent: string; sessionId: string; developerId: string }) => JSON.stringify([x.agent, x.sessionId, x.developerId]);
const add = <K>(map: Map<K, number>, key: K, n: number) => map.set(key, (map.get(key) ?? 0) + n);

export async function costReport(store: SharedStore, who: Identity, period: { from: string; to: string }): Promise<CostReportResult> {
  const access = await costAccess(store, who);
  if (access === 'none' || access === 'off') return { status: access };
  return { status: 'ok', report: await build(store, who.repoId, access, who.developerId, period) };
}

/** The repo's total for a period, with no developer in it, for the digest line; null when tracking is off. */
export async function repoCost(store: SharedStore, repoId: string, period: { from: string; to: string }): Promise<number | null> {
  if (!(await costEnabled(store, repoId))) return null;
  const { sessions } = await build(store, repoId, 'all', null, period);
  return sessions.reduce((sum, s) => sum + (s.repoId === repoId ? (s.micros ?? 0) : 0), 0);
}

/** `viewerId` is the reader or developer looking; null for nobody in particular. */
async function build(store: SharedStore, repoId: string, access: 'all' | 'own', viewerId: string | null, { from, to }: { from: string; to: string }): Promise<CostReport> {
  const registered = new Set((await store.costConfig('account')).filter((a) => a.repoId === repoId).map((a) => a.developerId));
  const developerIds = [...registered].filter((id) => access === 'all' || id === viewerId);

  const shared = new Set([repoId]);
  if (access === 'all') {
    const enabled = new Set((await store.costConfig('repo')).map((r) => r.repoId));
    for (const g of await store.costConfig('grant')) if (g.readerId === viewerId && enabled.has(g.repoId)) shared.add(g.repoId);
  }

  const priceOf = pricer(await store.costConfig('price'));
  const commits = (await store.commits({ developerIds })).filter((c) => shared.has(c.repoId));
  const manual = await store.ticketLinks(repoId);
  // Approved, shared summaries only: what a session was about is the developer's to share.
  const tickets = new Map<string, Set<string>>();
  for (const s of await store.list({ repoId })) {
    const key = sessionOf({ agent: s.summary.agent, sessionId: s.summary.sessionId.replace(/\.p\d+$/, ''), developerId: s.developerId });
    const keys = tickets.get(key) ?? tickets.set(key, new Set()).get(key)!;
    for (const link of linksOf(s, manual)) keys.add(link.ticketKey);
  }

  const rows = new Map<string, CostSession>();
  const models = new Map<string, number>();
  for (const r of await store.usage({ developerIds, from, to })) {
    const session = sessionOf(r);
    const committed = commits.find((c) => sessionOf(c) === session)?.repoId;
    let place: ViewPlace = r.place === 'company' ? (shared.has(r.repoId!) ? 'shared' : 'company') : r.place;
    let repo = place === 'shared' ? r.repoId : null;
    if (place === 'unknown' && (tickets.has(session) || committed)) [place, repo] = ['shared', tickets.has(session) ? repoId : committed!];
    const date = r.at.slice(0, 10);
    const key = JSON.stringify([session, date, place, repo]);
    const row =
      rows.get(key) ??
      rows
        .set(key, {
          agent: r.agent, sessionId: r.sessionId, developerId: r.developerId, developerName: r.developerName, date, startedAt: r.at, endedAt: r.at, requests: 0, models: [],
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, micros: null, unpricedRequests: 0, billing: r.billing, place, repoId: repo,
          commits: [], tickets: [...(repo === repoId ? (tickets.get(session) ?? []) : [])].sort(byText), flags: [],
        })
        .get(key)!;
    const micros = priceOf(r);
    row.endedAt = r.at;
    row.requests++;
    if (!row.models.includes(r.model)) row.models = [...row.models, r.model].sort(byText);
    row.inputTokens += r.inputTokens;
    row.outputTokens += r.outputTokens;
    row.cacheReadTokens += r.cacheReadTokens;
    row.cacheWriteTokens += r.cacheWriteTokens;
    if (row.billing !== r.billing) row.billing = null;
    if (micros === null) row.unpricedRequests++;
    else row.micros = (row.micros ?? 0) + micros;
    add(models, r.model, micros ?? 0);
  }
  const sessions = [...rows.values()];

  // A commit goes on its own day's row; made later, on the session's last row.
  for (const c of commits) {
    const own = sessions.filter((s) => sessionOf(s) === sessionOf(c)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const row = own.find((s) => s.date === c.at.slice(0, 10)) ?? own.at(-1);
    row?.commits.push({ repoId: c.repoId, sha: c.sha });
  }
  for (const flag of await store.flags(repoId)) for (const s of sessions) if (sessionOf(s) === sessionOf(flag)) s.flags.push(flag);

  const total = (match: (s: CostSession) => boolean) => sessions.reduce((sum, s) => sum + (match(s) ? (s.micros ?? 0) : 0), 0);
  const perTicket = new Map<string | null, number>();
  for (const s of sessions.filter((x) => x.repoId === repoId)) {
    const keys: (string | null)[] = s.tickets.length ? s.tickets : [null];
    const micros = s.micros ?? 0;
    const share = Math.floor(micros / keys.length);
    keys.forEach((k, i) => add(perTicket, k, i === 0 ? micros - share * (keys.length - 1) : share));
  }
  const titles = new Map((await store.ticketTitles(repoId)).map((t) => [t.key, t.title]));
  for (const t of await store.trackerTickets(repoId)) if (t.title) titles.set(t.key, t.title);

  const people = new Map(sessions.map((s) => [s.developerId, s.developerName]));
  return {
    repoId,
    from,
    to,
    scope: access,
    totalMicros: total(() => true),
    billing: { api: total((s) => s.billing === 'api'), subscription: total((s) => s.billing === 'subscription'), unknown: total((s) => s.billing === null) },
    places: { shared: total((s) => s.place === 'shared'), company: total((s) => s.place === 'company'), outside: total((s) => s.place === 'outside'), unknown: total((s) => s.place === 'unknown') },
    unpricedRequests: sessions.reduce((n, s) => n + s.unpricedRequests, 0),
    developers: [...people]
      .map(([developerId, developerName]) => ({
        developerId,
        developerName,
        micros: total((s) => s.developerId === developerId),
        sessions: new Set(sessions.filter((s) => s.developerId === developerId).map(sessionOf)).size,
      }))
      .sort((a, b) => byText(a.developerName, b.developerName) || byText(a.developerId, b.developerId)),
    models: [...models].map(([model, micros]) => ({ model, micros })).sort((a, b) => byText(a.model, b.model)),
    tickets: [...perTicket]
      .map(([ticket, micros]) => ({ ticket, title: ticket === null ? null : (titles.get(ticket) ?? null), micros }))
      .sort((a, b) => (a.ticket === null ? 1 : b.ticket === null ? -1 : byText(a.ticket, b.ticket))),
    sessions: sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : byText(a.developerName, b.developerName) || a.startedAt.localeCompare(b.startedAt) || byText(a.sessionId, b.sessionId))),
  };
}

/** A CSV cell: quoted when needed, and never readable as a spreadsheet formula. */
function cell(value: string | number): string {
  const text = /^[=+\-@\t\r]/.test(String(value)) ? `'${value}` : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function costCsv(report: CostReport): string {
  const head = 'date,developer,agent,session,models,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_usd,billing,place,repo,commits,tickets,flagged';
  const lines = report.sessions.map((s) =>
    [
      s.date, s.developerName, s.agent, s.sessionId, s.models.join(' '), s.requests, s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens,
      s.micros === null ? '' : (s.micros / 1e6).toFixed(6), s.billing ?? '', s.place, s.repoId ?? '', s.commits.map((c) => c.sha).join(' '), s.tickets.join(' '), s.flags.some((f) => !f.resolvedAt) ? 'yes' : 'no',
    ]
      .map(cell)
      .join(','),
  );
  return `${[head, ...lines].join('\n')}\n`;
}
