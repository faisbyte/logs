import type { UploadPayload } from './payload.js';
import type { StoredDigest } from './digests.js';
import type { LinkOutcome, PreviewsOutcome, PushOutcome, PushTarget, RetractOutcome, SprintsOutcome, TitleOutcome, TicketsOutcome, UnlinkOutcome } from './target.js';
import type { TicketReport } from './ticket-report.js';
import type { Sprint, SummaryRef } from './tickets.js';

// The client side of `sprintdigest push` against a digest server (DECISIONS.md D43). The token travels only in the
// Authorization header and never appears in errors.

const OUTCOMES: Record<number, PushOutcome['status']> = { 201: 'created', 200: 'unchanged', 409: 'conflict', 422: 'rejected', 401: 'unauthorized', 403: 'forbidden' };

const LINK_STATUSES = new Set(['created', 'unchanged', 'removed', 'not-found', 'forbidden', 'rejected', 'in-summary']);

type Body = { status?: string; reason?: string; errors?: string[]; error?: string };

export function httpPushTarget(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): PushTarget {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (path: string, init: { method: string; body?: unknown } = { method: 'GET' }): Promise<[Response, Body]> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new Error(`could not reach the shared store at ${base}.`);
    }
    return [response, (await response.json().catch(() => ({}))) as Body];
  };
  const unexpected = (response: Response, body: Body) => new Error(`the shared store answered ${response.status}: ${body.error ?? 'no details'}`);
  const refused = (response: Response, body: Body) =>
    response.status === 401 || response.status === 403 ? { status: response.status === 401 ? ('unauthorized' as const) : ('forbidden' as const), reason: body.reason ?? body.error ?? `HTTP ${response.status}` } : null;
  const linkChange = async (method: 'POST' | 'DELETE', repoId: string, ref: SummaryRef, ticket: string) => {
    const [response, body] = await call('/v1/ticket-links', { method, body: { repoId, agent: ref.agent, sessionId: ref.sessionId, ticket } });
    if (body.status && LINK_STATUSES.has(body.status)) return (body.reason === undefined ? { status: body.status } : { status: body.status, reason: body.reason }) as LinkOutcome & UnlinkOutcome;
    const no = refused(response, body);
    if (no) return no;
    throw unexpected(response, body);
  };
  return {
    link: (repoId, ref, ticket): Promise<LinkOutcome> => linkChange('POST', repoId, ref, ticket),
    unlink: (repoId, ref, ticket): Promise<UnlinkOutcome> => linkChange('DELETE', repoId, ref, ticket),
    async tickets(repoId, filter): Promise<TicketsOutcome> {
      const params = new URLSearchParams({ repoId, ...filter });
      const [response, body] = await call(`/v1/tickets?${params}`);
      if (response.status === 200) return { status: 'ok', report: body as unknown as TicketReport };
      const no = refused(response, body);
      if (no) return no;
      throw unexpected(response, body);
    },
    async setTicketTitle(repoId, ticket, title): Promise<TitleOutcome> {
      const [response, body] = await call('/v1/ticket-titles', { method: 'PUT', body: { repoId, ticket, title } });
      if (body.status === 'saved') return { status: 'saved' };
      if (body.status === 'rejected' && body.reason) return { status: 'rejected', reason: body.reason };
      const no = refused(response, body);
      if (no) return no;
      throw unexpected(response, body);
    },
    async sprints(repoId): Promise<SprintsOutcome> {
      const [response, body] = await call(`/v1/sprints?${new URLSearchParams({ repoId })}`);
      if (response.status === 200) return { status: 'ok', sprints: (body as unknown as { sprints: Sprint[] }).sprints };
      const no = refused(response, body);
      if (no) return no;
      throw unexpected(response, body);
    },
    async retract(repoId, ref): Promise<RetractOutcome> {
      const [response, body] = await call('/v1/retractions', { method: 'POST', body: { repoId, agent: ref.agent, sessionId: ref.sessionId } });
      const b = body as Body & { retractedAt?: string };
      if ((b.status === 'retracted' || b.status === 'already') && b.retractedAt) return { status: b.status, retractedAt: b.retractedAt };
      if ((b.status === 'not-found' || b.status === 'forbidden') && b.reason) return { status: b.status, reason: b.reason };
      const no = refused(response, body);
      if (no) return no;
      throw unexpected(response, body);
    },
    async previews(repoId): Promise<PreviewsOutcome> {
      const [response, body] = await call(`/v1/digests?${new URLSearchParams({ repoId })}`);
      const no = refused(response, body);
      if (no) return no;
      if (response.status !== 200) throw unexpected(response, body);
      const digests: StoredDigest[] = [];
      for (const d of (body as unknown as { digests: StoredDigest[] }).digests.filter((x) => x.status === 'preview')) {
        const [one, full] = await call(`/v1/digests/${encodeURIComponent(d.id)}?${new URLSearchParams({ repoId })}`);
        if (one.status !== 200) throw unexpected(one, full);
        digests.push((full as unknown as { digest: StoredDigest }).digest);
      }
      return { status: 'ok', digests };
    },
    async push(repoId: string, payload: UploadPayload): Promise<PushOutcome> {
      const [response, body] = await call('/v1/summaries', { method: 'POST', body: { repoId, payload } });
      const status = OUTCOMES[response.status];
      if (status === 'created' || status === 'unchanged') return { status };
      if (status === 'rejected') return { status, errors: body.errors ?? [body.error ?? 'rejected'] };
      if (status) return { status, reason: body.reason ?? body.error ?? `HTTP ${response.status}` };
      throw unexpected(response, body);
    },
  };
}
