import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeLlmClient, InMemorySummaryStore } from '@digest/core';
import { afterEach, describe, expect, it } from 'vitest';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import { createHandler } from '../src/http.js';

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const fakeGithub = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function start(digests: Parameters<typeof createHandler>[1]['digests'] = undefined) {
  const store = new InMemorySummaryStore();
  const logs: string[] = [];
  server = createServer(createHandler(store, { log: (line) => logs.push(line), ...(digests ? { digests } : {}) }));
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

  describe('reports and digests (DECISIONS.md D51, D53)', () => {
    const output = { overview: 'Login is safer.', tickets: [{ key: 'PROJ-142', achieved: 'Repeated attempts are limited.', aiInvolvement: 'AI wrote most of it.', keyDecisions: [] }], otherWork: null, risksAndOpenQuestions: [] };
    const llm = () => new FakeLlmClient(() => JSON.stringify(output), 'claude-sonnet-5-5');
    const body = { repoId: REPO, from: '2026-03-01', to: '2026-04-01' };
    const readerOf = async (store: InMemorySummaryStore) => (await store.issueToken({ repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)' }, 'reader')).token;

    it('lets a reader request a report, then list and read it, without seeing who did the work', async () => {
      const { store, push, call } = await start({ llm: llm(), model: 'claude-sonnet-5-5', defaultCapUsd: 10 });
      await push(payloadFor());
      const reader = await readerOf(store);
      const made = await call('/v1/reports', { method: 'POST', token: reader, body });
      expect(made.status).toBe(200);
      const report = await made.json();
      expect(report).toMatchObject({ status: 'ok', cached: false, digest: { kind: 'report', summaryCount: 1, developerCount: 1, markdown: expect.stringContaining('## PROJ-142') } });
      expect(JSON.stringify(report)).not.toMatch(/alice|Alice/);
      expect((await (await call('/v1/reports', { method: 'POST', token: reader, body })).json()).cached).toBe(true);
      const list = await (await call(`/v1/digests?repoId=${encodeURIComponent(REPO)}`, { token: reader })).json();
      expect(list.digests.map((d: { id: string; markdown?: string }) => [d.id, d.markdown])).toEqual([[report.digest.id, undefined]]);
      const one = await call(`/v1/digests/${report.digest.id}?repoId=${encodeURIComponent(REPO)}`, { token: reader });
      expect((await one.json()).digest.markdown).toBe(report.digest.markdown);
    });

    it('keeps previews from readers but shows them to developers', async () => {
      const { store, call, token } = await start();
      const reader = await readerOf(store);
      const preview = await store.saveDigest({ repoId: REPO, kind: 'scheduled', periodKey: 'week:2026-03-09', periodLabel: 'w', from: null, to: null, inputHash: 'h', promptVersion: 'digest-v1', model: 'm', markdown: '# w\n', summaryCount: 1, developerCount: 1, costUsd: 0, status: 'preview', previewUntil: '2026-03-17T00:00:00.000Z', createdAt: '2026-03-16T00:00:00.000Z' });
      const repo = encodeURIComponent(REPO);
      expect((await (await call(`/v1/digests?repoId=${repo}`, { token: reader })).json()).digests).toEqual([]);
      expect((await call(`/v1/digests/${preview.id}?repoId=${repo}`, { token: reader })).status).toBe(404);
      expect((await (await call(`/v1/digests?repoId=${repo}`, { token })).json()).digests).toMatchObject([{ id: preview.id, status: 'preview' }]);
      expect((await call(`/v1/digests/${preview.id}?repoId=${repo}`, { token })).status).toBe(200);
    });

    it('answers 429 at the cost cap, 503 without an API key, and 400 for a bad period', async () => {
      const capped = await start({ llm: llm(), model: 'claude-sonnet-5-5', defaultCapUsd: 0.000001 });
      await capped.push(payloadFor());
      const refused = await capped.call('/v1/reports', { method: 'POST', token: capped.token, body });
      expect(refused.status).toBe(429);
      expect((await refused.json()).reason).toMatch(/monthly LLM cost cap/);
      await new Promise<void>((done) => server!.close(() => done()));
      const keyless = await start();
      await keyless.push(payloadFor());
      expect((await keyless.call('/v1/reports', { method: 'POST', token: keyless.token, body })).status).toBe(503);
      expect((await keyless.call('/v1/reports', { method: 'POST', token: keyless.token, body: { repoId: REPO, from: '2026-03-01' } })).status).toBe(400);
    });
  });

  it('retracts a pushed summary for its developer only: 200, then already; 403 for another developer or a reader; 404 if unknown (DECISIONS.md D60)', async () => {
    const { store, push, call, token, bobToken } = await start();
    await push(payloadFor());
    const reader = (await store.issueToken({ repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)' }, 'reader')).token;
    const retract = (as: string, sessionId = payloadFor().sessionId) => call('/v1/retractions', { method: 'POST', token: as, body: { repoId: REPO, agent: 'claude-code', sessionId } });
    expect((await retract(bobToken)).status).toBe(403);
    expect((await retract(reader)).status).toBe(403);
    expect((await retract(token, 'unknown')).status).toBe(404);
    const done = await retract(token);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'retracted', retractedAt: expect.any(String) });
    expect(await (await retract(token)).json()).toMatchObject({ status: 'already' });
    expect((await (await call(`/v1/summaries?repoId=${encodeURIComponent(REPO)}`, { token })).json()).summaries).toEqual([]);
  });

  it('sets a ticket title with a developer token (200), refuses readers (403) and bad input (422) (DECISIONS.md D67)', async () => {
    const { store, call, token } = await start();
    const reader = (await store.issueToken({ repoId: REPO, developerId: 'pat', developerName: 'Pat (PO)' }, 'reader')).token;
    const put = (as: string, body: object) => call('/v1/ticket-titles', { method: 'PUT', token: as, body: { repoId: REPO, ...body } });
    expect((await put(token, { ticket: 'LOGS-1', title: 'Session parsing' })).status).toBe(200);
    expect((await put(reader, { ticket: 'LOGS-2', title: 'Secret redaction' })).status).toBe(403);
    expect((await put(token, { ticket: 'LOGS-3', title: '' })).status).toBe(422);
    expect(await store.ticketTitles(REPO)).toMatchObject([{ key: 'LOGS-1', title: 'Session parsing', setBy: 'alice' }]);
  });
});
