import {
  assertDeliverable,
  capRefusal,
  DigestError,
  digestInput,
  storedFields,
  ticketReport,
  writeDigest,
  type DigestDeps,
  type RepoSettings,
  type Sprint,
  type StoredDigest,
  type TicketReportFilter,
} from '@digest/core';
import type { Delivery } from './delivery.js';

// Scheduled digests (DECISIONS.md D54). `digest-server digest send-due`, run by cron, writes each due digest
// once (one per period, D52), holds it for the developer preview window if there is one, then delivers it,
// retrying only the channels that failed. Running it again changes nothing.

export interface DuePeriod {
  periodKey: string;
  filter: TicketReportFilter;
}

const DAY = 86_400_000;
const midnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isoWeekday = (d: Date) => d.getUTCDay() || 7;

/** The periods a repo's schedule says are due by `now`, no earlier than when the schedule was turned on. */
export function duePeriods(settings: RepoSettings, sprints: readonly Sprint[], now: Date): DuePeriod[] {
  const since = settings.scheduleSince ? Date.parse(settings.scheduleSince) : -Infinity;
  if (settings.schedule === 'weekly') {
    const sendDay = midnight(now) - ((isoWeekday(now) - settings.weekday + 7) % 7) * DAY;
    if (sendDay <= since) return [];
    const from = new Date(sendDay - 7 * DAY).toISOString();
    return [{ periodKey: `week:${from.slice(0, 10)}`, filter: { from, to: new Date(sendDay).toISOString() } }];
  }
  if (settings.schedule === 'sprint-end') {
    return sprints.filter((s) => Date.parse(s.to) <= now.getTime() && Date.parse(s.to) > since).map((s) => ({ periodKey: `sprint:${s.name}`, filter: { sprint: s.name } }));
  }
  return [];
}

export interface SendDueDeps extends DigestDeps {
  /** The repo's deliveries (from its settings and the server environment), and what is missing. */
  deliveries: (settings: RepoSettings) => { deliveries: Delivery[]; problems: string[] };
}

export interface SendResult {
  repoId: string;
  periodKey: string;
  result: string;
}

async function deliver(deps: SendDueDeps, digest: StoredDigest, deliveries: Delivery[], now: Date): Promise<string> {
  assertDeliverable(digest.markdown);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const delivery of deliveries) {
    if (digest.deliveries[delivery.channel]) continue;
    try {
      await delivery.send({ subject: `AI work update: ${digest.periodLabel}`, markdown: digest.markdown });
      await deps.store.updateDigest(digest.repoId, digest.id, { deliveries: { [delivery.channel]: now.toISOString() } });
      sent.push(delivery.channel);
    } catch (err) {
      failed.push(`${delivery.channel} failed: ${(err as Error).message}`);
    }
  }
  if (failed.length) return `${sent.length ? `sent to ${sent.join(', ')}; ` : ''}${failed.join('; ')} Will retry on the next run.`;
  await deps.store.updateDigest(digest.repoId, digest.id, { status: 'sent', sentAt: now.toISOString() });
  return `sent to ${sent.join(', ')}`;
}

async function sendPeriod(deps: SendDueDeps, settings: RepoSettings, period: DuePeriod, now: Date): Promise<string> {
  const repoId = settings.repoId;
  let digest = await deps.store.scheduledDigest(repoId, period.periodKey);
  if (digest?.status === 'sent') return 'already sent';
  const { deliveries, problems } = deps.deliveries(settings);
  if (!deliveries.length) return `not sent: ${problems.join('; ')}`;
  if (!digest) {
    const input = digestInput(await ticketReport(deps.store, repoId, period.filter));
    const refusal = await capRefusal(deps, repoId, input, 'this digest');
    if (refusal) return `not written: ${refusal}`;
    try {
      const written = await writeDigest(deps, repoId, input);
      const previewUntil = settings.previewHours > 0 ? new Date(now.getTime() + settings.previewHours * 3_600_000).toISOString() : null;
      digest = await deps.store.saveDigest({ ...storedFields(repoId, written), kind: 'scheduled', periodKey: period.periodKey, status: previewUntil ? 'preview' : 'ready', previewUntil });
    } catch (err) {
      if (err instanceof DigestError) return `not written: ${err.message}`;
      throw err;
    }
  }
  if (digest.status === 'preview' && digest.previewUntil && Date.parse(digest.previewUntil) > now.getTime()) return `in developer preview until ${digest.previewUntil}`;
  return deliver(deps, digest, deliveries, now);
}

/** One pass over every scheduled repo: write, preview and deliver whatever is due. */
export async function sendDue(deps: SendDueDeps): Promise<SendResult[]> {
  const now = (deps.now ?? (() => new Date()))();
  const results: SendResult[] = [];
  for (const repoId of await deps.store.scheduledRepos()) {
    const settings = await deps.store.repoSettings(repoId);
    for (const period of duePeriods(settings, await deps.store.sprints(repoId), now)) {
      results.push({ repoId, periodKey: period.periodKey, result: await sendPeriod(deps, settings, period, now) });
    }
  }
  return results;
}
