import { beforeEach, describe, expect, it } from 'vitest';
import { disableCost, enableCost, ingestUsage, issueIngestToken, isIngestToken, recordCommit, removeAccount, revokeIngestToken, saveAccount, savePattern } from '../../src/cost/ingest.js';
import { InMemorySummaryStore } from '../../src/shared/memory-store.js';
import { claudeRequest, codexCompleted, logBatch } from './otlp.js';

// What becomes a cost record (Phase 12, D107): company accounts on repos where the admin turned tracking on, and no repo
// but a company one named.

const REPO = 'github.com/acme/webapp';
const API = 'github.com/acme/api';
const NOW = new Date('2026-04-08T00:00:00.000Z');
const START = new Date('2026-04-01T00:00:00.000Z');
const alice = { repoId: REPO, email: 'Alice@Acme.example', developerId: 'alice', developerName: 'Alice', organizationId: 'org-acme', billing: 'subscription' as const };
const ALL = { developerIds: ['alice', 'bob'], from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' };

let store: InMemorySummaryStore;
beforeEach(async () => {
  store = new InMemorySummaryStore();
  await enableCost(store, REPO, START);
  await saveAccount(store, alice);
});
const send = (...records: Parameters<typeof logBatch>) => ingestUsage(store, logBatch(...records), NOW);

describe('ingestUsage', () => {
  it('records a registered account’s usage under its developer, without the email', async () => {
    expect(await send(claudeRequest())).toEqual({ status: 'ok', recorded: 1 });
    const [record] = await store.usage(ALL);
    expect(record).toMatchObject({ developerId: 'alice', developerName: 'Alice', agent: 'claude-code', costMicros: 250_000, billing: 'subscription', place: 'company', repoId: REPO });
    expect(JSON.stringify(record)).not.toMatch(/acme\.example|org-acme/i);
  });

  it('drops unregistered accounts, and a registered email signed in to another organisation or a personal plan', async () => {
    const personal = claudeRequest({ request_id: 'p' }) as Record<string, string | number>;
    delete personal['organization.id'];
    expect(await send(claudeRequest({ 'user.email': 'alice@home.example' }), claudeRequest({ request_id: 'o', 'organization.id': 'org-personal' }), personal as never)).toEqual({ status: 'ok', recorded: 0 });
    expect(await store.usage(ALL)).toEqual([]);
  });

  it('counts a request sent twice once', async () => {
    await send(claudeRequest());
    expect(await send(claudeRequest(), claudeRequest())).toEqual({ status: 'ok', recorded: 0 });
  });

  it('keeps only that it was outside, for a repo that is not a company one', async () => {
    await send(claudeRequest({ 'vcs.repository.url.full': 'https://github.com/alice/my-novel' }));
    const [record] = await store.usage(ALL);
    expect(record).toMatchObject({ place: 'outside', repoId: null });
    expect(JSON.stringify(record)).not.toContain('novel');
  });

  it('says unknown, not outside, when the agent reports no repo', async () => {
    await saveAccount(store, { repoId: REPO, email: 'bob@acme.example', developerId: 'bob', developerName: 'Bob', organizationId: null, billing: null });
    const local = claudeRequest() as Record<string, string | number>;
    delete local['vcs.repository.url.full'];
    await send(local as never, codexCompleted());
    expect((await store.usage(ALL)).map((r) => [r.agent, r.place, r.billing])).toEqual([['claude-code', 'unknown', 'subscription'], ['codex', 'unknown', 'subscription']]);
  });

  it('names other company repos: exact patterns, a whole organisation, and repos with tracking on', async () => {
    await savePattern(store, 'github.com/acme/*');
    await savePattern(store, 'gitlab.com/acme/infra');
    await enableCost(store, 'github.com/partner/shared', START);
    const urls = ['https://github.com/acme/api', 'https://gitlab.com/acme/infra', 'https://github.com/partner/shared', 'https://github.com/acme-fans/api', 'https://gitlab.com/acme/infra-2', 'https://github.com/acme'];
    await send(...urls.map((u, i) => claudeRequest({ request_id: `r${i}`, 'event.timestamp': `2026-04-07T10:0${i}:00.000Z`, 'vcs.repository.url.full': u })));
    expect((await store.usage(ALL)).map((r) => r.repoId)).toEqual([API, 'gitlab.com/acme/infra', 'github.com/partner/shared', null, null, null]);
  });

  it('records nothing for an account whose repo has tracking off, or that was removed', async () => {
    await disableCost(store, REPO);
    expect(await send(claudeRequest())).toEqual({ status: 'ok', recorded: 0 });
    await enableCost(store, REPO, START);
    await removeAccount(store, REPO, 'alice@acme.example');
    expect(await send(claudeRequest())).toEqual({ status: 'ok', recorded: 0 });
  });

  it('records nothing from before tracking was turned on, or from the future', async () => {
    await enableCost(store, REPO, new Date('2026-04-07T10:00:00.000Z'));
    await disableCost(store, REPO);
    await enableCost(store, REPO, new Date('2026-04-07T10:30:00.000Z'));
    const at = (id: string, time: string) => claudeRequest({ request_id: id, 'event.timestamp': time });
    expect(await send(at('a', '2026-04-07T10:29:59.000Z'), at('b', '2026-04-07T10:30:00.000Z'), at('c', '2026-04-09T00:00:00.000Z'))).toEqual({ status: 'ok', recorded: 1 });
  });

  it('refuses a body that is not a log batch', async () => {
    expect(await ingestUsage(store, { resourceSpans: [] }, NOW)).toEqual({ status: 'invalid' });
  });
});

describe('cost accounts', () => {
  it('keeps one developer per email, and one person per developer id, across repos', async () => {
    await enableCost(store, API, NOW);
    expect(await saveAccount(store, { ...alice, repoId: API })).toEqual({ status: 'saved' });
    expect(await saveAccount(store, { ...alice, repoId: API, developerId: 'alicia' })).toEqual({ status: 'conflict', reason: 'that email is already registered to alice' });
    expect(await saveAccount(store, { ...alice, repoId: API, email: 'a2@acme.example', developerName: 'Alice Other' })).toEqual({ status: 'conflict', reason: 'developer id alice is already Alice; one id must mean one person on this server' });
    expect(await saveAccount(store, { ...alice, email: 'nope' })).toEqual({ status: 'conflict', reason: 'email must be an address' });
    expect(await removeAccount(store, API, 'ALICE@acme.example')).toBe(true);
    expect(await removeAccount(store, API, 'alice@acme.example')).toBe(false);
  });

  it('accepts only repo patterns for one repo or one whole organisation', async () => {
    for (const bad of ['*', 'github.com/*', 'github.com/acme/w*', 'acme', 'github.com/acme/*/x']) expect(await savePattern(store, bad)).toBe(false);
    for (const good of ['github.com/acme/*', 'GitHub.com/Acme/api', 'gitlab.com/acme/team/*']) expect(await savePattern(store, good)).toBe(true);
  });
});

describe('telemetry tokens', () => {
  it('are stored hashed, replaced by label, and end when revoked', async () => {
    const { token } = await issueIngestToken(store, 'laptops', NOW);
    expect(token).toMatch(/^dgi_/);
    expect(JSON.stringify(await store.costConfig('ingest'))).not.toContain(token);
    expect(await isIngestToken(store, token)).toBe(true);
    const next = await issueIngestToken(store, 'laptops', NOW);
    expect(await isIngestToken(store, token)).toBe(false);
    expect(await isIngestToken(store, next.token)).toBe(true);
    expect(await isIngestToken(store, '')).toBe(false);
    expect(await revokeIngestToken(store, 'laptops')).toBe(true);
    expect(await isIngestToken(store, next.token)).toBe(false);
  });
});

describe('recordCommit', () => {
  const identity = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
  const commit = { agent: 'claude-code', sessionId: 's1', sha: 'A'.repeat(40) };

  it('keeps a commit reported by its developer, once', async () => {
    expect(await recordCommit(store, identity, commit, NOW)).toEqual({ status: 'recorded' });
    expect(await recordCommit(store, identity, commit, NOW)).toEqual({ status: 'unchanged' });
    expect(await store.commits({ developerIds: ['alice'] })).toEqual([{ repoId: REPO, developerId: 'alice', agent: 'claude-code', sessionId: 's1', sha: 'a'.repeat(40), at: NOW.toISOString() }]);
  });

  it('refuses anything but a full hash and a session id, and keeps nothing where tracking is off', async () => {
    for (const bad of [{ sha: 'abc' }, { sha: 'fix: the login bug' }, { sessionId: 'some text here' }, { agent: 'other' }]) expect(await recordCommit(store, identity, { ...commit, ...bad }, NOW)).toMatchObject({ status: 'invalid' });
    expect(await recordCommit(store, { ...identity, repoId: API }, commit, NOW)).toEqual({ status: 'off' });
    expect(await store.commits({ developerIds: ['alice'] })).toEqual([]);
  });
});
