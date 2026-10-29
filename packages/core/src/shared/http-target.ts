import type { UploadPayload } from './payload.js';
import type { PushOutcome, PushTarget } from './store.js';

// The client side of `digest push` against a digest server (DECISIONS.md D43). The token travels only in the
// Authorization header and never appears in errors.

const OUTCOMES: Record<number, PushOutcome['status']> = { 201: 'created', 200: 'unchanged', 409: 'conflict', 422: 'rejected', 401: 'unauthorized', 403: 'forbidden' };

export function httpPushTarget(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): PushTarget {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/summaries`;
  return {
    async push(repoId: string, payload: UploadPayload): Promise<PushOutcome> {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ repoId, payload }),
        });
      } catch {
        throw new Error(`could not reach the shared store at ${baseUrl.replace(/\/+$/, '')}.`);
      }
      const body = (await response.json().catch(() => ({}))) as { reason?: string; errors?: string[]; error?: string };
      const status = OUTCOMES[response.status];
      if (status === 'created' || status === 'unchanged') return { status };
      if (status === 'rejected') return { status, errors: body.errors ?? [body.error ?? 'rejected'] };
      if (status) return { status, reason: body.reason ?? body.error ?? `HTTP ${response.status}` };
      throw new Error(`the shared store answered ${response.status}: ${body.error ?? 'no details'}`);
    },
  };
}
