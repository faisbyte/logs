import { defaultRepoSettings, FakeLlmClient, InMemorySummaryStore, type DigestOutput, type RepoSettings } from '@digest/core';
import { describe, expect, it } from 'vitest';
import { payloadFor } from '../../core/test/shared/store-contract.js';
import type { Delivery, DeliveryMessage } from '../src/delivery.js';
import { duePeriods, sendDue } from '../src/schedule.js';

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
});
