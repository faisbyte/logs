import type { TicketReport } from '@digest/core';
import Link from 'next/link';

export type TicketRowGroup = {
  sprint: string;
  tickets: { key: string; title: string | null; summaries: number; developers: number; last: string }[];
  unlinked: number;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
// aria-labelledby splits on spaces, so an id can't keep the sprint's own name.
const headingId = (sprint: string) => `sprint-${sprint.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** The server's grouped ticket report, flattened into what the table shows. */
export function ticketRows(report: TicketReport): TicketRowGroup[] {
  return report.sprints.map((group) => ({
    sprint: group.sprint?.name ?? 'No sprint',
    tickets: group.tickets.map((t) => ({
      key: t.key,
      title: t.title,
      summaries: t.summaries.length,
      developers: new Set(t.summaries.map((s) => s.summary.developerId)).size,
      last: t.summaries.map((s) => s.summary.summary.endedAt).sort().at(-1)?.slice(0, 10) ?? '',
    })),
    unlinked: group.unlinked.length,
  }));
}

/** Tickets by sprint. Each row is one link to the ticket's timeline. */
export function TicketTable({ groups }: { groups: TicketRowGroup[] }) {
  if (!groups.some((g) => g.tickets.length)) {
    return (
      <div className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-8 text-sm">
        <p className="text-fg font-medium">No tickets yet.</p>
        <p className="mt-1">A ticket appears here once an approved summary carrying its key has been pushed.</p>
      </div>
    );
  }
  return (
    <div className="space-y-10">
      {groups.map((group) => (
        <section key={group.sprint} aria-labelledby={headingId(group.sprint)}>
          <h2 id={headingId(group.sprint)} className="text-fg-subtle font-mono text-xs tracking-wide uppercase">
            {group.sprint}
          </h2>
          {group.tickets.length ? (
            <table className="data-table mt-3 w-full text-sm">
              <caption className="sr-only">Tickets in {group.sprint}</caption>
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Title</th>
                  <th scope="col">Summaries</th>
                  <th scope="col">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {group.tickets.map((t) => (
                  <tr key={t.key}>
                    <td data-label="Ticket">
                      <Link href={`/tickets/${encodeURIComponent(t.key)}`} className="row-link text-fg font-mono font-medium underline-offset-4 hover:underline">
                        {t.key}
                      </Link>
                    </td>
                    <td data-label="Title" className={t.title ? '' : 'text-fg-subtle italic'}>
                      {t.title ?? 'No title'}
                    </td>
                    <td data-label="Summaries" className="text-fg-muted">
                      {count(t.summaries, 'summary', 'summaries')} · {count(t.developers, 'developer', 'developers')}
                    </td>
                    <td data-label="Last activity" className="text-fg-muted font-mono text-xs">
                      {t.last}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {group.unlinked ? <p className="text-fg-muted mt-3 text-sm">{`${count(group.unlinked, 'summary', 'summaries')} in this sprint ${group.unlinked === 1 ? 'is' : 'are'} linked to no ticket.`}</p> : null}
        </section>
      ))}
    </div>
  );
}
