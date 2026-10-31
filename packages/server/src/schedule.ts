import {
  assertDeliverable,
  capRefusal,
  DigestError,
  digestInput,
  reportSummaryKeys,
  storedFields,
  ticketReport,
  writeDigest,
  type DigestDeps,
  type RepoSettings,
  type Sprint,
  type StoredDigest,
  type TicketReportFilter,
  warningText,
} from '@digest/core';
import type { Delivery } from './delivery.js';

// Scheduled digests (DECISIONS.md D54). `sprintdigest-server digest send-due`, run by cron, writes each due digest
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

/** Marks a digest as the corrected version of one that was withdrawn after it was sent (D70). */
export function markCorrected(markdown: string, withdrawn: StoredDigest): string {
  const sent = (withdrawn.sentAt ?? withdrawn.createdAt).slice(0, 10);
  return markdown.replace(/^# AI work update: (.*)\n/, `# AI work update (corrected): $1\n\n_This corrects the update sent on ${sent}: a developer withdrew a summary it included._\n`);
}

async function deliver(deps: SendDueDeps, digest: StoredDigest, deliveries: Delivery[]): Promise<string> {
  assertDeliverable(digest.markdown);
  // Stamped when each send happens: writing the digest first can take a while after the run started.
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const subject = `AI work update${digest.corrects ? ' (corrected)' : ''}: ${digest.periodLabel}`;
  const what = digest.corrects ? 'a corrected version ' : '';
  const sent: string[] = [];
  const failed: string[] = [];
  for (const delivery of deliveries) {
    if (digest.deliveries[delivery.channel]) continue;
    try {
      await delivery.send({ subject, markdown: digest.markdown });
      await deps.store.updateDigest(digest.repoId, digest.id, { deliveries: { [delivery.channel]: now() } });
      sent.push(delivery.channel);
    } catch (err) {
      failed.push(`${delivery.channel} failed: ${(err as Error).message}`);
    }
  }
  if (failed.length) return `${sent.length ? `sent ${what}to ${sent.join(', ')}; ` : ''}${failed.join('; ')} Will retry on the next run.`;
  await deps.store.updateDigest(digest.repoId, digest.id, { status: 'sent', sentAt: now() });
  return `sent ${what}to ${sent.join(', ')}`;
}

async function sendPeriod(deps: SendDueDeps, settings: RepoSettings, period: DuePeriod, now: Date): Promise<string> {
  const repoId = settings.repoId;
  let digest = await deps.store.scheduledDigest(repoId, period.periodKey);
  if (digest?.status === 'sent') return 'already sent';
  const { deliveries, problems } = deps.deliveries(settings);
  if (!deliveries.length) return `not sent: ${problems.join('; ')}`;
  if (!digest) {
    const report = await ticketReport(deps.store, repoId, period.filter);
    const input = digestInput(report);
    const refusal = await capRefusal(deps, repoId, input, 'this digest');
    if (refusal) return `not written: ${refusal}`;
    // A digest withdrawn after a retraction (D60) is replaced by a corrected one, never sent again (D70).
    const withdrawn = (await deps.store.digests(repoId, { kinds: ['scheduled'], statuses: ['withdrawn'] })).find((d) => d.periodKey === period.periodKey);
    try {
      const written = await writeDigest(deps, repoId, input);
      const previewUntil = settings.previewHours > 0 ? new Date(now.getTime() + settings.previewHours * 3_600_000).toISOString() : null;
      const fields = storedFields(repoId, written, reportSummaryKeys(report));
      digest = await deps.store.saveDigest({
        ...fields,
        ...(withdrawn ? { markdown: markCorrected(fields.markdown, withdrawn), corrects: withdrawn.id } : {}),
        kind: 'scheduled',
        periodKey: period.periodKey,
        status: previewUntil ? 'preview' : 'ready',
        previewUntil,
      });
    } catch (err) {
      if (err instanceof DigestError) return `not written: ${err.message}`;
      throw err;
    }
  }
  // A kept warning shows in the result line, and cron still reports success (D71).
  const warning = warningText(digest);
  const withWarning = (result: string) => (warning ? `${result}; warning: ${warning}` : result);
  if (digest.status === 'preview' && digest.previewUntil && Date.parse(digest.previewUntil) > now.getTime()) return withWarning(`in developer preview until ${digest.previewUntil}`);
  return withWarning(await deliver(deps, digest, deliveries));
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

/** Whether a send-due result means something due wasn't delivered, so cron should alert. */
export const needsAttention = (result: string) => !/^(sent |already sent|in developer preview)/.test(result) || result.includes(' failed: ');
