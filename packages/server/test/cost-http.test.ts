import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { enableCost, grantCost, InMemorySummaryStore, issueIngestToken, saveAccount } from '@digest/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costRecord } from '../../core/test/cost/cost-contract.js';
import { claudeRequest, logBatch } from '../../core/test/cost/otlp.js';
import { createHandler } from '../src/http.js';
import { RateLimiter } from '../src/rate-limit.js';

// The cost endpoints (Phase 12, D107).

const REPO = 'github.com/acme/webapp';
const repo = encodeURIComponent(REPO);
const START = new Date('2026-04-01T00:00:00.000Z');
const COST = `/v1/cost?repoId=${repo}&from=2026-04-01&to=2026-05-01`;
const ALL = { developerIds: ['alice'], from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' };

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

let store: InMemorySummaryStore;
let logs: string[];
let tokens: Record<'alice' | 'bob' | 'pat' | 'kim' | 'ingest', string>;
let call: (path: string, init?: { method?: string; token?: string; body?: unknown; type?: string; encoding?: string }) => Promise<Response>;

async function start(options: Partial<Parameters<typeof createHandler>[1]> = {}) {
  store = new InMemorySummaryStore();
  logs = [];
  server = createServer(createHandler(store, { log: (l) => logs.push(l), ...options }));
  await new Promise<void>((listening) => server!.listen(0, '127.0.0.1', listening));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  call = (path, init = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), 'content-type': init.type ?? 'application/json', ...(init.encoding ? { 'content-encoding': init.encoding } : {}) },
      ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
    });
  const token = async (id: string, name: string, role: 'developer' | 'reader') => (await store.issueToken({ repoId: REPO, developerId: id, developerName: name }, role)).token;
  tokens = { alice: await token('alice', 'Alice', 'developer'), bob: await token('bob', 'Bob', 'developer'), pat: await token('pat', 'Pat (PO)', 'reader'), kim: await token('kim', 'Kim', 'reader'), ingest: (await issueIngestToken(store, 'laptops', START)).token };
  await enableCost(store, REPO, START);
  for (const [id, name] of [['alice', 'Alice'], ['bob', 'Bob']] as const) await saveAccount(store, { repoId: REPO, email: `${id}@acme.example`, developerId: id, developerName: name, organizationId: null, billing: null });
  await grantCost(store, REPO, 'pat');
}
beforeEach(() => start());
const actions = async () => (await store.auditEvents(REPO)).map((e) => [e.action, e.actorId, e.target, e.detail]);

describe('POST /v1/logs', () => {
  it('records usage sent with a telemetry token, and answers as OTLP expects', async () => {
    const r = await call('/v1/logs', { token: tokens.ingest, body: logBatch(claudeRequest()) });
    expect([r.status, await r.json()]).toEqual([200, {}]);
    expect(await store.usage(ALL)).toHaveLength(1);
  });

  it('keeps no prompt, command, tool output, email or outside repo, even from a machine set up to send them all', async () => {
    const planted = ['please fix the login bug', 'cat ~/.ssh/id_rsa', 'my-novel', 'alice@acme.example', 'acc-1', 'alices-laptop'];
    const body = logBatch(
      claudeRequest({ prompt: planted[0]!, tool_parameters: planted[1]!, 'vcs.repository.url.full': 'https://github.com/alice/my-novel', 'vcs.ref.head.name': 'my-novel-ch2' }),
      { 'event.name': 'user_prompt', prompt: planted[0]!, 'user.email': planted[3]! },
      { 'event.name': 'codex.tool_result', arguments: planted[1]!, output: planted[1]! },
    );
    expect((await call('/v1/logs', { token: tokens.ingest, body })).status).toBe(200);
    const view = await (await call(COST, { token: tokens.pat })).text();
    const kept = JSON.stringify([await store.usage(ALL), await store.auditEvents(REPO)]) + view + logs.join();
    expect(view).toContain('"place":"outside"');
    for (const text of planted) expect(kept).not.toContain(text);
  });

  it('refuses any other credential, so a developer or reader token can’t send usage', async () => {
    for (const token of [undefined, 'dgi_nope', tokens.alice, tokens.pat]) expect((await call('/v1/logs', { ...(token ? { token } : {}), body: logBatch(claudeRequest()) })).status).toBe(401);
    expect(await store.usage(ALL)).toEqual([]);
  });

  it('gives a telemetry token nothing to read', async () => {
    for (const path of [COST, `/v1/summaries?repoId=${repo}`, `/v1/digests?repoId=${repo}`, '/v1/whoami']) expect((await call(path, { token: tokens.ingest })).status).toBe(401);
  });

  it('takes batches larger than other requests, to a limit, and only uncompressed JSON', async () => {
    const big = { resourceLogs: [{ ...logBatch(claudeRequest()).resourceLogs[0]!, padding: 'x'.repeat(1_000_000) }] };
    expect((await call('/v1/logs', { token: tokens.ingest, body: big })).status).toBe(200);
    expect((await call('/v1/logs', { token: tokens.ingest, body: { resourceLogs: [], padding: 'x'.repeat(5_000_000) } })).status).toBe(413);
    expect((await call('/v1/logs', { token: tokens.ingest, body: 'x', type: 'application/x-protobuf' })).status).toBe(415);
    expect((await call('/v1/logs', { token: tokens.ingest, body: 'x', encoding: 'gzip' })).status).toBe(415);
    expect((await call('/v1/logs', { token: tokens.ingest, body: { resourceSpans: [] } })).status).toBe(400);
  });

  it('has its own rate limit, so many agents sharing a token don’t use up the API’s', async () => {
    await new Promise<void>((done) => server!.close(() => done()));
    await start({ rateLimit: new RateLimiter(1), telemetryLimit: new RateLimiter(3) });
    const send = () => call('/v1/logs', { token: tokens.ingest, body: { resourceLogs: [] } });
    expect([(await send()).status, (await send()).status, (await send()).status, (await send()).status]).toEqual([200, 200, 200, 429]);
    expect([(await call(COST, { token: tokens.pat })).status, (await call(COST, { token: tokens.pat })).status]).toEqual([200, 429]);
  });
});

describe('GET /v1/cost', () => {
  beforeEach(() => store.recordUsage([costRecord(), costRecord({ key: 'b', developerId: 'bob', developerName: 'Bob', sessionId: 's2' })]));

  it('gives everyone to a granted reader, their own to a developer, and 403 to any other reader', async () => {
    const seen = async (token: string) => ((await (await call(COST, { token })).json()) as { sessions: { developerId: string }[] }).sessions.map((s) => s.developerId);
    expect(await seen(tokens.pat)).toEqual(['alice', 'bob']);
    expect(await seen(tokens.alice)).toEqual(['alice']);
    const refused = await call(COST, { token: tokens.kim });
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'cost access to this repo has not been granted' }]);
    expect((await call(COST)).status).toBe(401);
    expect((await call('/v1/cost?repoId=github.com%2Facme%2Fother&from=2026-04-01&to=2026-05-01', { token: tokens.pat })).status).toBe(403);
  });

  it('takes a sprint or a date range, up to 400 days', async () => {
    await store.saveSprint(REPO, { name: 'Sprint 7', from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z' });
    expect(await (await call(`/v1/cost?repoId=${repo}&sprint=Sprint%207`, { token: tokens.pat })).json()).toMatchObject({ from: '2026-04-06T00:00:00.000Z', sessions: [{}, {}] });
    for (const q of ['sprint=Nope', 'from=2026-04-01', 'from=2026-05-01&to=2026-04-01', 'from=2020-01-01&to=2026-01-01']) expect([q, (await call(`/v1/cost?repoId=${repo}&${q}`, { token: tokens.pat })).status]).toEqual([q, 400]);
  });

  it('answers 404 where tracking is off', async () => {
    await store.removeCostConfig('repo', REPO);
    expect((await call(COST, { token: tokens.pat })).status).toBe(404);
  });

  it('records each look at everyone’s cost in the audit log, but not a developer’s own', async () => {
    await call(COST, { token: tokens.pat });
    await call(COST, { token: tokens.alice });
    await call(COST, { token: tokens.kim });
    expect(await actions()).toEqual([['cost.viewed', 'pat', null, '2026-04-01 up to 2026-05-01']]);
  });

  it('tells whoami what cost access there is', async () => {
    const access = async (token: string) => ((await (await call('/v1/whoami', { token })).json()) as { costAccess: string }).costAccess;
    expect([await access(tokens.pat), await access(tokens.kim), await access(tokens.alice)]).toEqual(['all', 'none', 'own']);
  });
});

describe('commits and flags', () => {
  const sha = 'a'.repeat(40);
  beforeEach(() => store.recordUsage([costRecord()]));
  const flag = (token: string, body: object = {}) => call('/v1/cost/flags', { token, body: { repoId: REPO, agent: 'claude-code', sessionId: 's1', developerId: 'alice', note: 'Is this ours?', ...body } });

  it('takes a commit from a developer token only, and answers with no more than a status', async () => {
    const post = (token: string, body: object = {}) => call('/v1/cost/commits', { token, body: { repoId: REPO, agent: 'claude-code', sessionId: 's1', sha, ...body } });
    const first = await post(tokens.alice);
    expect([first.status, await first.json()]).toEqual([201, { status: 'recorded' }]);
    expect((await post(tokens.alice)).status).toBe(200);
    expect((await post(tokens.pat)).status).toBe(403);
    expect((await post(tokens.alice, { sha: 'nope' })).status).toBe(422);
    expect(await store.commits({ developerIds: ['alice', 'pat'] })).toHaveLength(1);
  });

  it('flags, replies and settles, each in the audit log without its text', async () => {
    const made = (await (await flag(tokens.pat)).json()) as { flag: { id: string } };
    expect((await flag(tokens.alice)).status).toBe(403);
    expect((await flag(tokens.pat, { sessionId: 'nope' })).status).toBe(404);
    const change = (what: string, token: string, text?: string) => call(`/v1/cost/${what}`, { token, body: { repoId: REPO, id: made.flag.id, ...(text ? { text } : {}) } });
    expect((await change('flag-replies', tokens.bob, 'hi')).status).toBe(404);
    expect((await change('flag-replies', tokens.alice)).status).toBe(422);
    expect((await change('flag-replies', tokens.alice, 'A spike.')).status).toBe(200);
    const own = (await (await call(COST, { token: tokens.alice })).json()) as { sessions: { flags: { notes: { text: string }[] }[] }[] };
    expect(own.sessions[0]!.flags[0]!.notes.map((n) => n.text)).toEqual(['Is this ours?', 'A spike.']);
    expect((await change('flag-resolutions', tokens.pat)).status).toBe(200);
    expect((await change('flag-resolutions', tokens.pat)).status).toBe(404);
    expect(await actions()).toEqual([
      ['cost.resolved', 'pat', 'claude-code/s1', null],
      ['cost.replied', 'alice', 'claude-code/s1', null],
      ['cost.flagged', 'pat', 'claude-code/s1', 'alice'],
    ]);
  });
});

