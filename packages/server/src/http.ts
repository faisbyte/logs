import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentSchema, onDemandReport, READER_REFUSAL, receivePush, ticketReport, type DigestDeps, type SharedStore, type StoredDigest, type SummaryRef, type TicketReportFilter } from '@digest/core';

// The digest server's HTTP API (DECISIONS.md D43). Every request is authenticated by a per-developer, per-repo
// token and may only touch that token's repo. Logs carry method, path and status, never tokens or content.

const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';

function dateParam(params: URLSearchParams, name: string, required: boolean): string | undefined {
  const value = params.get(name) ?? undefined;
  if (value === undefined) {
    if (required) throw new HttpError(400, `${name} is required`);
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) throw new HttpError(400, `${name} must be an ISO date`);
  return new Date(value).toISOString();
}

const PUSH_STATUS = { created: 201, unchanged: 200, conflict: 409, rejected: 422, unauthorized: 401, forbidden: 403 } as const;
const RETRACT_STATUS = { retracted: 200, already: 200, 'not-found': 404, forbidden: 403 } as const;
const LINK_STATUS = { created: 201, unchanged: 200, removed: 200, 'not-found': 404, forbidden: 403, rejected: 422, 'in-summary': 409 } as const;

/** The summary a ticket-link request names. Session and ticket travel in the body, so the logged path stays fixed. */
function linkTarget(body: unknown): { repoId: string; ref: SummaryRef; ticket: unknown } {
  const b = (body ?? {}) as { repoId?: unknown; agent?: unknown; sessionId?: unknown; ticket?: unknown };
  if (typeof b.repoId !== 'string' || !b.repoId) throw new HttpError(400, 'repoId is required');
  const agent = AgentSchema.safeParse(b.agent);
  if (!agent.success) throw new HttpError(400, `agent must be one of ${AgentSchema.options.join(', ')}`);
  if (typeof b.sessionId !== 'string' || !b.sessionId) throw new HttpError(400, 'sessionId is required');
  return { repoId: b.repoId, ref: { agent: agent.data, sessionId: b.sessionId }, ticket: b.ticket };
}

const REPORT_STATUS = { 'cap-reached': 429, unavailable: 503, failed: 502 } as const;

/** from and to (dates or date-times; to is not included), or a sprint name. */
function periodFrom(get: (name: string) => unknown): TicketReportFilter {
  const date = (name: string) => {
    const value = get(name);
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new HttpError(400, `${name} must be an ISO date`);
    return new Date(value).toISOString();
  };
  const sprint = get('sprint');
  const [from, to] = [date('from'), date('to')];
  if (typeof sprint === 'string' && sprint && from === undefined && to === undefined) return { sprint };
  if ((sprint === undefined || sprint === null) && from !== undefined && to !== undefined) return { from, to };
  throw new HttpError(400, 'pass from and to, or sprint');
}

/** The list view leaves the text out. */
const listed = ({ markdown: _, ...rest }: StoredDigest) => rest;

export interface HandlerOptions {
  log?: (line: string) => void;
  /** How the server writes digests; without it, it serves only what it has already written. */
  digests?: Omit<DigestDeps, 'store'>;
}

export function createHandler(store: SharedStore, { log = (line: string) => console.log(line), digests = { llm: null, model: 'claude-sonnet-5-5', defaultCapUsd: 10 } }: HandlerOptions = {}) {
  /** The token's identity, required to match the repo being read. */
  const reader = async (req: IncomingMessage, repoId: string) => {
    const identity = await store.authenticate(bearer(req));
    if (!identity) throw new HttpError(401, 'unknown or revoked token');
    if (identity.repoId !== repoId) throw new HttpError(403, 'this token is for a different repo');
    return identity;
  };
  /** Per-session summaries carry developer identity: developer tokens only (DECISIONS.md D51). */
  const developer = async (req: IncomingMessage, repoId: string) => {
    const identity = await reader(req, repoId);
    if (identity.role !== 'developer') throw new HttpError(403, READER_REFUSAL);
    return identity;
  };

  const route = async (req: IncomingMessage, url: URL): Promise<[number, unknown]> => {
    const methods: Record<string, string[]> = {
      '/healthz': ['GET'],
      '/v1/summaries': ['GET', 'POST'],
      '/v1/team-report': ['GET'],
      '/v1/ticket-links': ['POST', 'DELETE'],
      '/v1/retractions': ['POST'],
      '/v1/sprints': ['GET'],
      '/v1/tickets': ['GET'],
      '/v1/reports': ['POST'],
      '/v1/digests': ['GET'],
    };
    const digestId = /^\/v1\/digests\/([^/]+)$/.exec(url.pathname)?.[1];
    const allowed = digestId ? ['GET'] : methods[url.pathname];
    if (!allowed) throw new HttpError(404, 'not found');
    if (!allowed.includes(req.method ?? '')) throw new HttpError(405, `use ${allowed.join(' or ')}`);
    if (url.pathname === '/healthz') return [200, { ok: true }];

    // Digests and reports carry no developer identity: readers may use these (DECISIONS.md D51, D53).
    if (url.pathname === '/v1/reports') {
      const body = (await readJson(req)) as Record<string, unknown> | null;
      const repoId = body?.repoId;
      if (typeof repoId !== 'string' || !repoId) throw new HttpError(400, 'repoId is required');
      await reader(req, repoId);
      const result = await onDemandReport({ ...digests, store }, repoId, periodFrom((name) => body?.[name]));
      return result.status === 'ok' ? [200, result] : [REPORT_STATUS[result.status], result];
    }
    if (url.pathname === '/v1/digests' || digestId) {
      const repoId = url.searchParams.get('repoId');
      if (!repoId) throw new HttpError(400, 'repoId is required');
      const identity = await reader(req, repoId);
      // Previews are for developers only (DECISIONS.md D54).
      const statuses = identity.role === 'developer' ? undefined : (['ready', 'sent'] as const);
      if (!digestId) return [200, { digests: (await store.digests(repoId, statuses ? { statuses: [...statuses] } : {})).map(listed) }];
      const digest = await store.getDigest(repoId, decodeURIComponent(digestId));
      if (!digest || (statuses && !statuses.includes(digest.status as 'ready'))) throw new HttpError(404, 'no such digest');
      return [200, { digest }];
    }

    if (url.pathname === '/v1/sprints') {
      const repoId = url.searchParams.get('repoId');
      if (!repoId) throw new HttpError(400, 'repoId is required');
      await reader(req, repoId);
      return [200, { sprints: await store.sprints(repoId) }];
    }
    if (url.pathname === '/v1/retractions') {
      const { repoId, ref } = linkTarget(await readJson(req));
      const result = await store.retract(await developer(req, repoId), ref);
      return [RETRACT_STATUS[result.status], result];
    }

    if (url.pathname === '/v1/ticket-links') {
      const { repoId, ref, ticket } = linkTarget(await readJson(req));
      const identity = await developer(req, repoId);
      if (req.method === 'DELETE' && typeof ticket !== 'string') throw new HttpError(400, 'ticket is required');
      const result = req.method === 'POST' ? await store.addTicketLink(identity, ref, ticket as string) : await store.removeTicketLink(identity, ref, ticket as string);
      return [LINK_STATUS[result.status], result];
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const repoId = (body as { repoId?: unknown })?.repoId;
      if (typeof repoId !== 'string' || !repoId) throw new HttpError(400, 'repoId is required');
      const result = await receivePush(store, bearer(req), repoId, (body as { payload?: unknown }).payload);
      const response = result.status === 'created' || result.status === 'unchanged' ? { status: result.status, pushedAt: result.stored.pushedAt } : result;
      return [PUSH_STATUS[result.status], response];
    }

    const params = url.searchParams;
    const repoId = params.get('repoId');
    if (!repoId) throw new HttpError(400, 'repoId is required');
    await developer(req, repoId);
    if (url.pathname === '/v1/tickets') {
      const sprint = params.get('sprint');
      const [from, to] = [dateParam(params, 'from', false), dateParam(params, 'to', false)];
      if (sprint !== null ? from !== undefined || to !== undefined : from === undefined || to === undefined) throw new HttpError(400, 'pass from and to, or sprint');
      return [200, await ticketReport(store, repoId, sprint !== null ? { sprint } : { from: from!, to: to! })];
    }
    if (url.pathname === '/v1/team-report') {
      return [200, await store.teamReport({ repoId, from: dateParam(params, 'from', true)!, to: dateParam(params, 'to', true)! })];
    }
    const query = {
      repoId,
      ...(params.get('branch') !== null ? { branch: params.get('branch')! } : {}),
      ...(params.get('ticket') !== null ? { ticket: params.get('ticket')! } : {}),
      ...(params.get('developerId') !== null ? { developerId: params.get('developerId')! } : {}),
      ...(dateParam(params, 'from', false) ? { from: dateParam(params, 'from', false)! } : {}),
      ...(dateParam(params, 'to', false) ? { to: dateParam(params, 'to', false)! } : {}),
    };
    return [200, { summaries: await store.list(query) }];
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://digest.local');
    let status: number;
    let body: unknown;
    try {
      [status, body] = await route(req, url);
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
      body = { error: err instanceof HttpError ? err.message : 'internal error' };
      if (status === 413) req.resume();
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    log(`${req.method} ${url.pathname} ${status}`);
  };
}
