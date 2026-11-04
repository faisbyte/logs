import 'server-only';

import type { ContextItem, StoredSummary as SessionRecord, TicketReport } from '@digest/core';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import type { DigestRow } from '~/components/digest-table';
import type { Estimate } from '~/components/report-estimate';

// The dashboard's only way to data: the digest server's HTTP API, called from the dashboard's own server code with the
// session id from an httpOnly cookie (DECISIONS.md D91, D92, D93). The browser never sees a token or a session id, and
// never calls the digest server itself. Roles are enforced by the server; the UI only avoids asking for what it can't see.

export const SESSION_COOKIE = 'logs_session';
const BASE = (process.env.DIGEST_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

export type Role = 'developer' | 'reader';
export type Viewer = { repoId: string; developerId: string; developerName: string; role: Role };
export type Sprint = { name: string; from: string; to: string };
export type StoredDigest = DigestRow & { markdown: string; from: string | null; to: string | null; periodKey: string; previewUntil: string | null; warnings?: string[]; jargonRetried?: boolean };
export type Period = { sprint: string } | { from: string; to: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; session?: string | null } = {}): Promise<T> {
  const session = init.session === undefined ? (await cookies()).get(SESSION_COOKIE)?.value : init.session;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(session ? { authorization: `Session ${session}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(502, 'The logs server is not reachable.');
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!response.ok) throw new ApiError(response.status, body.reason ?? body.error ?? `HTTP ${response.status}`);
  return body;
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** Who is signed in, once per request; null when there is no session or it has ended. */
export const viewer = cache(async (): Promise<Viewer | null> => {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) return null;
  try {
    return await call<Viewer>('/v1/whoami');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
});

/** The signed-in developer, for developer-only views: readers get the plain 404 page, and no developer data is asked for. */
export async function developerOnly(): Promise<Viewer> {
  const me = await viewer();
  if (!me) redirect('/sign-in');
  if (me.role !== 'developer') notFound();
  return me;
}

// Every ticket, any time: the server's ticket report needs a range, so this one covers all of it.
const ALL_TIME = { from: '2000-01-01', to: '2100-01-01' };

export const api = {
  tickets: (repoId: string) => call<TicketReport>(`/v1/tickets?${query({ repoId, ...ALL_TIME })}`),
  ticketSummaries: async (repoId: string, ticket: string) => (await call<{ summaries: SessionRecord[] }>(`/v1/summaries?${query({ repoId, ticket })}`)).summaries,
  contextItems: async (repoId: string) => (await call<{ items: ContextItem[] }>(`/v1/context-items?${query({ repoId })}`)).items,
  startSession: (token: string) => call<{ session: string; expiresAt: string; identity: Viewer }>('/v1/sessions', { method: 'POST', body: { token }, session: null }),
  endSession: (session: string) => call<{ ended: boolean }>('/v1/sessions', { method: 'DELETE', session }),
  digests: async (repoId: string) => (await call<{ digests: DigestRow[] }>(`/v1/digests?${query({ repoId })}`)).digests,
  digest: async (repoId: string, id: string) => (await call<{ digest: StoredDigest }>(`/v1/digests/${encodeURIComponent(id)}?${query({ repoId })}`)).digest,
  sprints: async (repoId: string) => (await call<{ sprints: Sprint[] }>(`/v1/sprints?${query({ repoId })}`)).sprints,
  estimate: (repoId: string, period: Period) => call<Estimate>(`/v1/reports/estimate?${query({ repoId, ...period })}`),
  writeReport: (repoId: string, period: Period) => call<{ status: 'ok'; digest: StoredDigest; cached: boolean }>('/v1/reports', { method: 'POST', body: { repoId, ...period } }),
};
