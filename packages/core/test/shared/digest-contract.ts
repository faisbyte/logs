import { beforeEach, describe, expect, it } from 'vitest';
import { DigestBlockedError } from '../../src/digest/generate.js';
import type { DigestStore, NewDigest } from '../../src/shared/digests.js';

// Every DigestStore implementation must pass these (DECISIONS.md D52). Call from each implementation's test file.

const REPO = 'github.com/acme/webapp';
// Assembled at runtime so no literal secret sits in the source (fake value).
const fakeToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

export const newDigest = (over: Partial<NewDigest> = {}): NewDigest => ({
  repoId: REPO,
  kind: 'report',
  periodKey: 'sprint:Sprint 1',
  periodLabel: 'Sprint 1 (2026-03-02 to 2026-03-15)',
  from: '2026-03-02T00:00:00.000Z',
  to: '2026-03-16T00:00:00.000Z',
  inputHash: 'a'.repeat(64),
  promptVersion: 'digest-v1',
  model: 'claude-sonnet-5-5',
  markdown: '# AI work update: Sprint 1\n\nAll good.\n',
  summaryCount: 3,
  developerCount: 2,
  costUsd: 0.05,
  status: 'ready',
  previewUntil: null,
  createdAt: '2026-03-16T08:00:00.000Z',
  ...over,
});

export function digestStoreContract(name: string, make: () => Promise<DigestStore> | DigestStore) {
  describe(`${name}: DigestStore contract`, () => {
    let store: DigestStore;
    beforeEach(async () => {
      store = await make();
    });

    describe('digests', () => {
      it('stores a digest with an id and no deliveries yet, and reads it back', async () => {
        const saved = await store.saveDigest(newDigest());
        expect(saved).toMatchObject({ ...newDigest(), id: expect.any(String), deliveries: {}, sentAt: null });
        expect(await store.getDigest(REPO, saved.id)).toEqual(saved);
        expect(await store.getDigest('github.com/acme/other', saved.id)).toBeNull();
      });

      it('finds a cached report by period, input hash, prompt version and model', async () => {
        const saved = await store.saveDigest(newDigest());
        const key = { periodKey: 'sprint:Sprint 1', inputHash: 'a'.repeat(64), promptVersion: 'digest-v1', model: 'claude-sonnet-5-5' };
        expect(await store.findReport(REPO, key)).toEqual(saved);
        for (const miss of [{ inputHash: 'b'.repeat(64) }, { promptVersion: 'digest-v2' }, { model: 'claude-opus-5-5' }, { periodKey: 'sprint:Sprint 2' }]) {
          expect(await store.findReport(REPO, { ...key, ...miss })).toBeNull();
        }
      });

      it('keeps one scheduled digest per period, so a repeated send-due run reuses it', async () => {
        const first = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:2026-03-09' }));
        const again = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:2026-03-09', markdown: '# Other\n' }));
        expect(again).toEqual(first);
        expect(await store.scheduledDigest(REPO, 'week:2026-03-09')).toEqual(first);
        expect(await store.scheduledDigest(REPO, 'week:2026-03-16')).toBeNull();
      });

      it('lists digests newest first, filtered by kind and status', async () => {
        await store.saveDigest(newDigest({ createdAt: '2026-03-16T08:00:00.000Z' }));
        await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:1', status: 'sent', createdAt: '2026-03-17T08:00:00.000Z' }));
        await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:2', status: 'preview', createdAt: '2026-03-18T08:00:00.000Z' }));
        expect((await store.digests(REPO)).map((d) => d.periodKey)).toEqual(['week:2', 'week:1', 'sprint:Sprint 1']);
        expect((await store.digests(REPO, { statuses: ['sent', 'ready'] })).map((d) => d.periodKey)).toEqual(['week:1', 'sprint:Sprint 1']);
        expect((await store.digests(REPO, { kinds: ['scheduled'], statuses: ['preview'] })).map((d) => d.periodKey)).toEqual(['week:2']);
        expect(await store.digests('github.com/acme/other')).toEqual([]);
      });

      it('records each delivery and when the digest was sent', async () => {
        const saved = await store.saveDigest(newDigest({ kind: 'scheduled', periodKey: 'week:1', status: 'preview' }));
        await store.updateDigest(REPO, saved.id, { deliveries: { slack: '2026-03-16T09:00:00.000Z' } });
        await store.updateDigest(REPO, saved.id, { deliveries: { email: '2026-03-16T09:01:00.000Z' }, status: 'sent', sentAt: '2026-03-16T09:01:00.000Z' });
        expect(await store.getDigest(REPO, saved.id)).toMatchObject({ status: 'sent', sentAt: '2026-03-16T09:01:00.000Z', deliveries: { slack: '2026-03-16T09:00:00.000Z', email: '2026-03-16T09:01:00.000Z' } });
      });

      it('refuses to store a digest that matches a secret detector', async () => {
        await expect(store.saveDigest(newDigest({ markdown: `# Update\n\nUses ${fakeToken}.\n` }))).rejects.toThrow(DigestBlockedError);
        expect(await store.digests(REPO)).toEqual([]);
      });
    });

    describe('LLM spend', () => {
      it('adds up what a repo spent since a date', async () => {
        await store.recordSpend(REPO, 0.25, '2026-02-28T23:00:00.000Z');
        await store.recordSpend(REPO, 0.5, '2026-03-02T10:00:00.000Z');
        await store.recordSpend(REPO, 0.125, '2026-03-20T10:00:00.000Z');
        await store.recordSpend('github.com/acme/other', 9, '2026-03-05T10:00:00.000Z');
        expect(await store.spendSince(REPO, '2026-03-01T00:00:00.000Z')).toBeCloseTo(0.625);
        expect(await store.spendSince('github.com/acme/none', '2026-03-01T00:00:00.000Z')).toBe(0);
      });
    });

    describe('repo settings', () => {
      it('has defaults: no schedule, no preview, no delivery, no own cap', async () => {
        expect(await store.repoSettings(REPO)).toEqual({ repoId: REPO, schedule: 'off', weekday: 1, previewHours: 0, emailTo: [], slackWebhookEnv: null, monthlyCapUsd: null, scheduleSince: null });
      });

      it('saves changes, keeping the rest, and lists the repos that have a schedule', async () => {
        await store.saveRepoSettings(REPO, { schedule: 'weekly', weekday: 2, scheduleSince: '2026-03-01T00:00:00.000Z' });
        await store.saveRepoSettings(REPO, { emailTo: ['po@example.com'], slackWebhookEnv: 'SLACK_WEBHOOK_URL', monthlyCapUsd: 2.5, previewHours: 24 });
        await store.saveRepoSettings('github.com/acme/quiet', { emailTo: ['x@example.com'] });
        expect(await store.repoSettings(REPO)).toEqual({ repoId: REPO, schedule: 'weekly', weekday: 2, previewHours: 24, emailTo: ['po@example.com'], slackWebhookEnv: 'SLACK_WEBHOOK_URL', monthlyCapUsd: 2.5, scheduleSince: '2026-03-01T00:00:00.000Z' });
        expect(await store.scheduledRepos()).toEqual([REPO]);
      });
    });
  });
}
