import { defaultRepoSettings, FakeLlmClient, InMemorySummaryStore, type DigestOutput, type RepoSettings } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import type { Delivery, DeliveryMessage } from '../src/delivery.js';
import { duePeriods, needsAttention, sendDue } from '../src/schedule.js';

// Scheduled digests (DECISIONS.md D54): weekly or at the end of each sprint, sent by an idempotent send-due run.

const REPO = 'github.com/acme/webapp';
const alice = { repoId: REPO, developerId: 'alice', developerName: 'Alice' };
const settings = (over: Partial<RepoSettings>): RepoSettings => ({ ...defaultRepoSettings(REPO), scheduleSince: '2026-03-01T00:00:00.000Z', ...over });
const sprints = [
  { name: 'Sprint 1', from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' },
  { name: 'Sprint 2', from: '2026-03-16T00:00:00.000Z', to: '2026-03-30T00:00:00.000Z' },
];

describe('duePeriods', () => {
  it('weekly: the 7 days before the latest send day', () => {
    expect(duePeriods(settings({ schedule: 'weekly', weekday: 1 }), sprints, new Date('2026-03-18T10:00:00.000Z'))).toEqual([
      { periodKey: 'week:2026-03-09', filter: { from: '2026-03-09T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' } },
    ]);
    expect(duePeriods(settings({ schedule: 'weekly', weekday: 3 }), sprints, new Date('2026-03-18T10:00:00.000Z'))[0]!.periodKey).toBe('week:2026-03-11');
    expect(duePeriods(settings({ schedule: 'weekly', weekday: 1, scheduleSince: '2026-03-17T00:00:00.000Z' }), sprints, new Date('2026-03-18T10:00:00.000Z'))).toEqual([]);
  });

  it('sprint-end: every sprint that ended since the schedule was turned on', () => {
    expect(duePeriods(settings({ schedule: 'sprint-end' }), sprints, new Date('2026-03-18T10:00:00.000Z'))).toEqual([{ periodKey: 'sprint:Sprint 1', filter: { sprint: 'Sprint 1' } }]);
    expect(duePeriods(settings({ schedule: 'sprint-end' }), sprints, new Date('2026-04-01T00:00:00.000Z')).map((p) => p.periodKey)).toEqual(['sprint:Sprint 1', 'sprint:Sprint 2']);
    expect(duePeriods(settings({ schedule: 'sprint-end', scheduleSince: '2026-03-20T00:00:00.000Z' }), sprints, new Date('2026-03-21T00:00:00.000Z'))).toEqual([]);
    expect(duePeriods(settings({ schedule: 'off' }), sprints, new Date('2026-04-01T00:00:00.000Z'))).toEqual([]);
  });
});

const output: DigestOutput = {
  overview: 'Login is safer.',
  tickets: [{ key: 'PROJ-142', achieved: 'Repeated attempts are limited.', aiInvolvement: 'AI wrote most of it.', keyDecisions: [] }],
  otherWork: null,
  risksAndOpenQuestions: [],
};

class FakeDelivery implements Delivery {
  readonly sent: DeliveryMessage[] = [];
  failNext = false;
  constructor(readonly channel: 'slack' | 'email') {}
  async send(message: DeliveryMessage) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error(`${this.channel}: Slack answered 500.`);
    }
    this.sent.push(message);
  }
}

async function setup(over: Partial<RepoSettings> = {}) {
  let clock = new Date('2026-03-16T06:00:00.000Z');
  const now = () => clock;
  const store = new InMemorySummaryStore({ now });
  await store.push(alice, payloadFor());
  for (const s of sprints) await store.saveSprint(REPO, s);
  await store.saveRepoSettings(REPO, { schedule: 'sprint-end', scheduleSince: '2026-03-01T00:00:00.000Z', emailTo: ['po@example.com'], slackWebhookEnv: 'SLACK_WEBHOOK_URL', ...over });
  const llm = new FakeLlmClient(() => JSON.stringify(output), 'claude-sonnet-5-5');
  const slack = new FakeDelivery('slack');
  const email = new FakeDelivery('email');
  const deps = { store, llm, model: 'claude-sonnet-5-5', defaultCapUsd: 10, now, deliveries: () => ({ deliveries: [slack, email], problems: [] }) };
  return { store, llm, slack, email, deps, advance: (hours: number) => (clock = new Date(clock.getTime() + hours * 3_600_000)) };
}

describe('sendDue', () => {
  it('writes and sends a due digest once; a repeat run sends nothing and calls no model', async () => {
    const { store, llm, slack, email, deps } = await setup();
    expect(await sendDue(deps)).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'sent to slack, email' }]);
    expect(slack.sent).toEqual([{ subject: 'AI work update: Sprint 1 (2026-03-02 to 2026-03-15)', markdown: expect.stringContaining('## PROJ-142') }]);
    expect(email.sent).toHaveLength(1);
    expect(await store.scheduledDigest(REPO, 'sprint:Sprint 1')).toMatchObject({ status: 'sent', sentAt: '2026-03-16T06:00:00.000Z', deliveries: { slack: expect.any(String), email: expect.any(String) } });
    expect(await sendDue(deps)).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'already sent' }]);
    expect(llm.requests).toHaveLength(1);
    expect(slack.sent).toHaveLength(1);
  });

  it('with a preview window, lets developers read the digest first and sends it when the window ends', async () => {
    const { store, slack, deps, advance } = await setup({ previewHours: 24 });
    expect(await sendDue(deps)).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'in developer preview until 2026-03-17T06:00:00.000Z' }]);
    expect(await store.digests(REPO, { statuses: ['preview'] })).toHaveLength(1);
    advance(23);
    expect((await sendDue(deps))[0]!.result).toBe('in developer preview until 2026-03-17T06:00:00.000Z');
    expect(slack.sent).toEqual([]);
    advance(2);
    expect((await sendDue(deps))[0]!.result).toBe('sent to slack, email');
    expect(slack.sent).toHaveLength(1);
  });

  it('retries only the channels that failed', async () => {
    const { store, slack, email, deps } = await setup();
    slack.failNext = true;
    expect((await sendDue(deps))[0]!.result).toBe('sent to email; slack failed: slack: Slack answered 500. Will retry on the next run.');
    expect((await store.scheduledDigest(REPO, 'sprint:Sprint 1'))!.status).not.toBe('sent');
    expect((await sendDue(deps))[0]!.result).toBe('sent to slack');
    expect(email.sent).toHaveLength(1);
    expect(slack.sent).toHaveLength(1);
  });

  it('reports missing delivery settings and the cost cap, and writes nothing it can not send', async () => {
    const missing = await setup();
    const noDelivery = { ...missing.deps, deliveries: () => ({ deliveries: [], problems: ['email: set SMTP_URL and DIGEST_EMAIL_FROM on the server'] }) };
    expect(await sendDue(noDelivery)).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'not sent: email: set SMTP_URL and DIGEST_EMAIL_FROM on the server' }]);
    expect(missing.llm.requests).toEqual([]);
    const capped = await setup();
    await capped.store.recordSpend(REPO, 10, '2026-03-05T00:00:00.000Z');
    expect((await sendDue(capped.deps))[0]!.result).toMatch(/^not written: This repo has reached its monthly LLM cost cap/);
    expect(await capped.store.digests(REPO)).toEqual([]);
  });

  it('skips repos without a schedule', async () => {
    const { deps } = await setup({ schedule: 'off' });
    expect(await sendDue(deps)).toEqual([]);
  });

  it('after a retraction, writes a corrected digest and sends it to every channel again, never re-sending the withdrawn one (DECISIONS.md D70)', async () => {
    const { store, slack, email, deps, advance } = await setup();
    await store.push(alice, payloadFor({ sessionId: 'second', ticketRefs: [], branch: 'main', startedAt: '2026-03-05T09:00:00.000Z', endedAt: '2026-03-05T10:00:00.000Z' }));
    await sendDue(deps);
    const first = (await store.digests(REPO))[0]!;
    expect(first).toMatchObject({ status: 'sent', summaryCount: 2 });
    advance(1);
    await store.retract(alice, { agent: 'claude-code', sessionId: 'second' });
    expect((await store.getDigest(REPO, first.id))!.status).toBe('withdrawn');

    expect(await sendDue(deps)).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'sent a corrected version to slack, email' }]);
    const corrected = (await store.digests(REPO, { statuses: ['sent'] }))[0]!;
    expect(corrected).toMatchObject({ corrects: first.id, summaryCount: 1 });
    expect(corrected.markdown).toMatch(/^# AI work update \(corrected\): Sprint 1 \(2026-03-02 to 2026-03-15\)\n\n_This corrects the update sent on 2026-03-16: a developer withdrew a summary it included\._\n/);
    expect(slack.sent.map((m) => m.subject)).toEqual(['AI work update: Sprint 1 (2026-03-02 to 2026-03-15)', 'AI work update (corrected): Sprint 1 (2026-03-02 to 2026-03-15)']);
    expect(email.sent).toHaveLength(2);
    expect((await store.getDigest(REPO, first.id))!.status).toBe('withdrawn');

    expect(await sendDue(deps)).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'already sent' }]);
    expect(slack.sent).toHaveLength(2);
  });

  it('shows a kept jargon warning in the result line and keeps cron reporting success (DECISIONS.md D71)', async () => {
    const { store, deps } = await setup();
    const jargony = { ...output, overview: 'The schema changed.' };
    const llm = new FakeLlmClient(() => JSON.stringify(jargony), 'claude-sonnet-5-5');
    const results = await sendDue({ ...deps, llm });
    expect(results).toEqual([{ repoId: REPO, periodKey: 'sprint:Sprint 1', result: 'sent to slack, email; warning: jargon: schema (still there after one retry, so kept)' }]);
    expect(needsAttention(results[0]!.result)).toBe(false);
    expect(await store.scheduledDigest(REPO, 'sprint:Sprint 1')).toMatchObject({ warnings: ['jargon: schema'], jargonRetried: true });
    expect((await sendDue({ ...deps, llm }))[0]!.result).toBe('already sent');
  });

  it('shows the warning while the digest is in developer preview too', async () => {
    const { deps } = await setup({ previewHours: 24 });
    const llm = new FakeLlmClient(() => JSON.stringify({ ...output, overview: 'The schema changed.' }), 'claude-sonnet-5-5');
    const results = await sendDue({ ...deps, llm });
    expect(results[0]!.result).toBe('in developer preview until 2026-03-17T06:00:00.000Z; warning: jargon: schema (still there after one retry, so kept)');
    expect(needsAttention(results[0]!.result)).toBe(false);
  });

  it('stamps each delivery and sentAt when the send happens, not when the run started', async () => {
    const { store, slack, deps, advance } = await setup();
    const llm = new FakeLlmClient(() => (advance(1), JSON.stringify(output)), 'claude-sonnet-5-5');
    const send = slack.send.bind(slack);
    slack.send = async (message) => (advance(1), send(message));
    await sendDue({ ...deps, llm });
    expect(await store.scheduledDigest(REPO, 'sprint:Sprint 1')).toMatchObject({
      createdAt: '2026-03-16T07:00:00.000Z',
      deliveries: { slack: '2026-03-16T08:00:00.000Z', email: '2026-03-16T08:00:00.000Z' },
      sentAt: '2026-03-16T08:00:00.000Z',
    });
  });

  it('flags for cron only the results where something due was not delivered', () => {
    for (const ok of ['sent to slack, email', 'sent a corrected version to slack', 'already sent', 'in developer preview until 2026-03-17T06:00:00.000Z']) expect(needsAttention(ok)).toBe(false);
    for (const bad of ['sent to email; slack failed: x Will retry on the next run.', 'not sent: email: set SMTP_URL', 'not written: cap']) expect(needsAttention(bad)).toBe(true);
  });
});
