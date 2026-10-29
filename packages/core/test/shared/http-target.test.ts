import { describe, expect, it } from 'vitest';
import { httpPushTarget } from '../../src/shared/http-target.js';
import { payloadFor } from './store-contract.js';

const TOKEN = 'dgt_test_token_value_0123456789';
type Call = { url: string; init: RequestInit };

function stub(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, target: httpPushTarget('https://digest.example.com/', TOKEN, fetchImpl) };
}

describe('httpPushTarget', () => {
  it('POSTs the repo id and payload with the token as a bearer header only', async () => {
    const { calls, target } = stub(201, { status: 'created', pushedAt: '2026-10-29T12:00:00.000Z' });
    expect(await target.push('github.com/acme/webapp', payloadFor())).toEqual({ status: 'created' });
    expect(calls[0]!.url).toBe('https://digest.example.com/v1/summaries');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ repoId: 'github.com/acme/webapp', payload: payloadFor() });
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN);
  });

  it.each([
    [200, { status: 'unchanged' }, { status: 'unchanged' }],
    [409, { status: 'conflict', reason: 'immutable' }, { status: 'conflict', reason: 'immutable' }],
    [422, { status: 'rejected', errors: ['goal: x'] }, { status: 'rejected', errors: ['goal: x'] }],
    [401, { status: 'unauthorized', reason: 'unknown or revoked token' }, { status: 'unauthorized', reason: 'unknown or revoked token' }],
    [403, { error: 'this token is for a different repo' }, { status: 'forbidden', reason: 'this token is for a different repo' }],
  ])('maps HTTP %i to a push outcome', async (status, body, expected) => {
    expect(await stub(status, body).target.push('github.com/acme/webapp', payloadFor())).toEqual(expected);
  });

  it('throws a clear error for other answers and unreachable servers, never including the token', async () => {
    await expect(stub(500, { error: 'internal error' }).target.push('r/x', payloadFor())).rejects.toThrow(/answered 500: internal error/);
    const down = httpPushTarget('http://127.0.0.1:9', TOKEN, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const error = await down.push('r/x', payloadFor()).catch((e: Error) => e);
    expect(String(error)).toMatch(/could not reach the shared store at http:\/\/127.0.0.1:9/);
    expect(String(error)).not.toContain(TOKEN);
  });
});
