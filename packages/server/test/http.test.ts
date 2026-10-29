import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemorySummaryStore } from '@digest/core';
import { afterEach, describe, expect, it } from 'vitest';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import { createHandler } from '../src/http.js';

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const fakeGithub = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function start() {
  const store = new InMemorySummaryStore();
  const logs: string[] = [];
  server = createServer(createHandler(store, { log: (line) => logs.push(line) }));
  await new Promise<void>((listening) => server!.listen(0, '127.0.0.1', listening));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (await store.issueToken(alice)).token;
  const call = (path: string, init: { method?: string; token?: string; body?: unknown; raw?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), 'content-type': 'application/json' },
      ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const push = (payload: unknown, as = token, repoId = REPO) => call('/v1/summaries', { method: 'POST', token: as, body: { repoId, payload } });
  const bobToken = (await store.issueToken({ repoId: REPO, developerId: 'bob', developerName: 'Bob' })).token;
  const link = (method: 'POST' | 'DELETE', ticket: unknown, as = token, extra: object = {}) =>
    call('/v1/ticket-links', { method, token: as, body: { repoId: REPO, agent: 'claude-code', sessionId: payloadFor().sessionId, ticket, ...extra } });
  return { store, logs, token, bobToken, call, push, link };
}

describe('digest server HTTP API', () => {
  it('answers a health check', async () => {
    const { call } = await start();
    expect((await call('/healthz')).status).toBe(200);
  });

  it('accepts a push (201), treats a repeat as unchanged (200), and refuses a changed one (409)', async () => {
    const { push } = await start();
    const first = await push(payloadFor());
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ status: 'created', pushedAt: expect.any(String) });
    expect((await push(payloadFor())).status).toBe(200);
    expect((await push(payloadFor({ goal: 'Changed.' }))).status).toBe(409);
  });

  it('refuses a missing or unknown token (401) and another repo (403), storing nothing', async () => {
    const { push, call, store } = await start();
    expect((await call('/v1/summaries', { method: 'POST', body: { repoId: REPO, payload: payloadFor() } })).status).toBe(401);
    expect((await push(payloadFor(), 'dgt_unknown')).status).toBe(401);
    expect((await push(payloadFor(), undefined, 'github.com/acme/other')).status).toBe(403);
    expect(await store.list({ repoId: REPO })).toEqual([]);
  });

  it('rejects invalid payloads (422) with field-level errors that never echo a secret', async () => {
    const { push } = await start();
    const extra = await push({ ...payloadFor(), transcript: [] });
    expect(extra.status).toBe(422);
    const secret = await push({ ...payloadFor(), goal: `Uses ${fakeGithub}` });
    expect(secret.status).toBe(422);
    const body = await secret.text();
    expect(body).toContain('goal: contains a secret (github_token)');
    expect(body).not.toContain(fakeGithub);
  });

  it('rejects bad JSON (400) and oversized bodies (413)', async () => {
    const { call, token } = await start();
    expect((await call('/v1/summaries', { method: 'POST', token, raw: '{ nope' })).status).toBe(400);
    expect((await call('/v1/summaries', { method: 'POST', token, raw: JSON.stringify({ repoId: REPO, payload: 'x'.repeat(300_000) }) })).status).toBe(413);
  });

  it('lists summaries with filters, and gives the combined team report', async () => {
    const { push, call, token } = await start();
    await push(payloadFor({ sessionId: 's1', ticketRefs: ['PROJ-1'] }));
    await push(payloadFor({ sessionId: 's2', ticketRefs: ['PROJ-2'] }));
    const listed = await call(`/v1/summaries?repoId=${encodeURIComponent(REPO)}&ticket=PROJ-2`, { token });
    expect(listed.status).toBe(200);
    expect((await listed.json()).summaries.map((s: { summary: { sessionId: string } }) => s.summary.sessionId)).toEqual(['s2']);
    const report = await call(`/v1/team-report?repoId=${encodeURIComponent(REPO)}&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`, { token });
    expect(await report.json()).toMatchObject({ summaryCount: 2, developerCount: 1 });
  });

  it('validates query parameters and keeps reads to the token’s repo', async () => {
    const { call, token } = await start();
    expect((await call('/v1/summaries', { token })).status).toBe(400);
    expect((await call(`/v1/team-report?repoId=${encodeURIComponent(REPO)}&from=nope&to=2027-01-01T00:00:00.000Z`, { token })).status).toBe(400);
    expect((await call(`/v1/summaries?repoId=github.com%2Facme%2Fother`, { token })).status).toBe(403);
    expect((await call(`/v1/summaries?repoId=${encodeURIComponent(REPO)}`)).status).toBe(401);
  });

  it('answers 404 for unknown routes and 405 for the wrong method', async () => {
    const { call, token } = await start();
    expect((await call('/v1/nope', { token })).status).toBe(404);
    expect((await call('/v1/summaries', { method: 'DELETE', token })).status).toBe(405);
  });

  it('logs method, path and status only: never tokens, query strings or bodies', async () => {
    const { push, call, logs, token } = await start();
    await push(payloadFor());
    await push({ ...payloadFor(), goal: `Uses ${fakeGithub}` });
    await push(payloadFor(), 'dgt_unknown_value_123');
    await call(`/v1/summaries?repoId=${encodeURIComponent(REPO)}&ticket=PROJ-1`, { token });
    expect(logs).toContain('POST /v1/summaries 201');
    const all = logs.join('\n');
    for (const secret of [token, 'dgt_unknown_value_123', fakeGithub, 'PROJ-1', 'Rate limit']) expect(all).not.toContain(secret);
  });

  describe('tickets (DECISIONS.md D45, D46)', () => {
    it('adds a manual link (201, then 200), and refuses another developer (403), an unknown session (404) and a bad key (422)', async () => {
      const { push, link, bobToken } = await start();
      await push(payloadFor());
      expect((await link('POST', 'OPS-7')).status).toBe(201);
      expect((await link('POST', 'OPS-7')).status).toBe(200);
      expect((await link('POST', 'OPS-8', bobToken)).status).toBe(403);
      expect((await link('POST', 'OPS-8', undefined, { sessionId: 'unknown' })).status).toBe(404);
      const bad = await link('POST', `see ${fakeGithub}`);
      expect(bad.status).toBe(422);
      expect(await bad.text()).not.toContain(fakeGithub);
      expect((await link('POST', 'OPS-8', undefined, { agent: 'cursor' })).status).toBe(400);
      expect((await link('POST', 'OPS-8', 'dgt_unknown')).status).toBe(401);
    });

    it('removes a manual link (200) but never a key inside the summary (409)', async () => {
      const { push, link, store } = await start();
      await push(payloadFor());
      await link('POST', 'OPS-7');
      expect((await link('DELETE', 'PROJ-142')).status).toBe(409);
      expect((await link('DELETE', 'OPS-7')).status).toBe(200);
      expect((await link('DELETE', 'OPS-7')).status).toBe(404);
      expect(await store.ticketLinks(REPO)).toEqual([]);
    });

    it('returns summaries grouped by sprint and ticket, for a date range or a sprint name', async () => {
      const { push, call, token, store } = await start();
      await store.saveSprint(REPO, { name: 'Sprint 1', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
      await push(payloadFor());
      const byRange = await call(`/v1/tickets?repoId=${encodeURIComponent(REPO)}&from=2026-03-01&to=2026-04-01`, { token });
      expect(byRange.status).toBe(200);
      const body = await byRange.json();
      expect(body).toMatchObject({ repoId: REPO, summaryCount: 1, sprints: [{ sprint: { name: 'Sprint 1' }, tickets: [{ key: 'PROJ-142', summaries: [{ link: { source: 'branch' } }] }], unlinked: [] }] });
      const bySprint = await call(`/v1/tickets?repoId=${encodeURIComponent(REPO)}&sprint=${encodeURIComponent('Sprint 1')}`, { token });
      expect((await bySprint.json()).summaryCount).toBe(1);
    });

    it('needs either from and to, or a sprint name, and the token for that repo', async () => {
      const { call, token } = await start();
      const repo = encodeURIComponent(REPO);
      expect((await call(`/v1/tickets?repoId=${repo}`, { token })).status).toBe(400);
      expect((await call(`/v1/tickets?repoId=${repo}&from=2026-03-01`, { token })).status).toBe(400);
      expect((await call(`/v1/tickets?repoId=${repo}&from=2026-03-01&to=2026-04-01&sprint=S1`, { token })).status).toBe(400);
      expect((await call(`/v1/tickets?repoId=github.com%2Facme%2Fother&sprint=S1`, { token })).status).toBe(403);
    });

    it('logs only the fixed path for link changes, never the session or ticket', async () => {
      const { push, link, logs } = await start();
      await push(payloadFor());
      await link('POST', 'OPS-7');
      expect(logs.at(-1)).toBe('POST /v1/ticket-links 201');
    });
  });

  it('gives a reader token 403 on every per-session summary endpoint, and on pushes and link changes (DECISIONS.md D51)', async () => {
    const { store, push, call, link } = await start();
    await push(payloadFor());
    const reader = (await store.issueToken({ repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)' }, 'reader')).token;
    const repo = encodeURIComponent(REPO);
    const answers = await Promise.all([
      call(`/v1/summaries?repoId=${repo}`, { token: reader }),
      call(`/v1/team-report?repoId=${repo}&from=2026-01-01&to=2027-01-01`, { token: reader }),
      call(`/v1/tickets?repoId=${repo}&from=2026-01-01&to=2027-01-01`, { token: reader }),
      call('/v1/summaries', { method: 'POST', token: reader, body: { repoId: REPO, payload: payloadFor({ sessionId: 'other' }) } }),
      link('POST', 'OPS-7', reader),
      link('DELETE', 'PROJ-142', reader),
    ]);
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
    for (const r of answers) expect(JSON.stringify(await r.json())).not.toContain('Rate limit');
    expect(await store.list({ repoId: REPO })).toHaveLength(1);
  });
});
