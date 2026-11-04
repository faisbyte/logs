import type { StoredSummary, TicketReport } from '@digest/core';
import Link from 'next/link';
import { flaggedTerms, sendTime } from '~/components/digest-preview';
import { StatusPill } from '~/components/status-pill';
import { ticketRows } from '~/components/ticket-table';

export type SessionRow = { key: string; date: string; developer: string; goal: string; tickets: string[]; ai: string; href: string | null };
export type PreviewRow = { id: string; periodLabel: string; previewUntil?: string | null; warnings?: string[] };

const byKey = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const sessionKey = (s: StoredSummary) => `${s.summary.agent}/${s.summary.sessionId}`;

/** The newest approved summaries, each once, with every ticket the report links it to (manual links included). */
export function recentSessions(report: TicketReport, n: number): SessionRow[] {
  const seen = new Map<string, { stored: StoredSummary; tickets: string[] }>();
  const add = (stored: StoredSummary, ticket?: string) => {
    const entry = seen.get(sessionKey(stored)) ?? { stored, tickets: [] };
    if (ticket && !entry.tickets.includes(ticket)) entry.tickets.push(ticket);
    seen.set(sessionKey(stored), entry);
  };
  for (const group of report.sprints) {
    for (const t of group.tickets) for (const s of t.summaries) add(s.summary, t.key);
    for (const s of group.unlinked) add(s);
  }
  return [...seen.values()]
    .sort((a, b) => b.stored.summary.startedAt.localeCompare(a.stored.summary.startedAt))
    .slice(0, n)
    .map(({ stored, tickets }) => {
      const sorted = tickets.sort(byKey);
      return {
        key: sessionKey(stored),
        date: stored.summary.startedAt.slice(0, 10),
        developer: stored.developerName,
        goal: stored.summary.goal,
        tickets: sorted,
        ai: stored.summary.aiInvolvement,
        href: sorted[0] ? `/tickets/${encodeURIComponent(sorted[0])}` : null,
      };
    });
}

/** The tickets with the latest activity, across sprints. */
export function recentTickets(report: TicketReport, n: number) {
  const latest = new Map<string, ReturnType<typeof ticketRows>[number]['tickets'][number]>();
  for (const t of ticketRows(report).flatMap((g) => g.tickets)) if (!latest.has(t.key) || latest.get(t.key)!.last < t.last) latest.set(t.key, t);
  return [...latest.values()].sort((a, b) => b.last.localeCompare(a.last) || byKey(a.key, b.key)).slice(0, n);
}

/** The latest sessions, one row each; a row with a ticket is one link to that ticket's timeline. */
export function RecentSessions({ sessions }: { sessions: SessionRow[] }) {
  if (!sessions.length) {
    return (
      <div className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-6 text-sm">
        <p className="text-fg font-medium">No approved summaries yet.</p>
        <p className="mt-1">A session appears here once its developer has approved and pushed its summary.</p>
      </div>
    );
  }
  return (
    <table className="data-table w-full text-sm">
      <caption className="sr-only">Recent sessions, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Developer</th>
          <th scope="col">Goal</th>
          <th scope="col">Tickets</th>
          <th scope="col">AI involvement</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.key}>
            <td data-label="Date" className="text-fg-muted font-mono text-xs">
              <span className="whitespace-nowrap">{s.date}</span>
            </td>
            <td data-label="Developer" className="text-fg-muted">
              {s.developer}
            </td>
            <td data-label="Goal" className="max-w-md">
              {s.href ? (
                <Link href={s.href} className="row-link text-fg text-pretty underline-offset-4 hover:underline">
                  {s.goal}
                </Link>
              ) : (
                <span className="text-pretty">{s.goal}</span>
              )}
            </td>
            <td data-label="Tickets" className="font-mono text-xs">
              {s.tickets.length ? <span className="text-fg">{s.tickets.join(' ')}</span> : <span className="text-fg-subtle font-sans italic">No ticket</span>}
            </td>
            <td data-label="AI involvement" className="text-fg-muted">
              {s.ai}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const flagged = (p: PreviewRow) => flaggedTerms(p.warnings).length;

/** Digests developers can still read before stakeholders get them (D54), with the terms the jargon check flagged. */
export function PreviewNotice({ previews }: { previews: PreviewRow[] }) {
  if (!previews.length) return null;
  return (
    <section aria-labelledby="preview-heading" className="border-line-strong bg-bg-elev rounded-lg border px-5 py-4">
      <h2 id="preview-heading" className="text-fg-subtle font-mono text-xs tracking-wide uppercase">
        In preview
      </h2>
      <ul className="mt-2 space-y-2 text-sm">
        {previews.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={`/digests/${p.id}`} className="text-fg font-medium underline underline-offset-4">
              {p.periodLabel}
            </Link>
            <span className="text-fg-muted">{p.previewUntil ? `Sends after ${sendTime(p.previewUntil)}` : 'Waiting to send'}</span>
            {flagged(p) ? <StatusPill tone="attention">{`${flagged(p)} flagged ${flagged(p) === 1 ? 'term' : 'terms'}`}</StatusPill> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
