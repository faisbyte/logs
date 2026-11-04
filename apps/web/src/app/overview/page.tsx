import type { Metadata } from 'next';
import Link from 'next/link';
import { DigestTable } from '~/components/digest-table';
import { PreviewNotice, RecentSessions, recentSessions, recentTickets } from '~/components/overview';
import { SectionHeader } from '~/components/section-header';
import { TicketTable } from '~/components/ticket-table';
import { api, developerOnly } from '~/lib/api';

export const metadata: Metadata = { title: 'Overview' };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Part({ id, title, all, children }: { id: string; title: string; all?: { href: string; label: string }; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {all ? (
          <Link href={all.href} className="text-fg-muted hover:text-fg shrink-0 font-mono text-xs">
            {all.label} →
          </Link>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The developer's home: what has been shared lately, the tickets it touched, and the latest digests. */
export default async function OverviewPage() {
  const me = await developerOnly();
  const [report, digests, items] = await Promise.all([api.tickets(me.repoId), api.digests(me.repoId), api.contextItems(me.repoId)]);
  const tickets = new Set(report.sprints.flatMap((g) => g.tickets.map((t) => t.key))).size;
  const active = items.filter((i) => i.status === 'active').length;
  return (
    <>
      <SectionHeader
        index="00"
        label="Overview"
        title="Repo overview"
        line={`${count(report.summaryCount, 'approved summary', 'approved summaries')} from ${count(report.developerCount, 'developer', 'developers')}, on ${count(tickets, 'ticket', 'tickets')}. ${count(active, 'active context item', 'active context items')}.`}
      />
      <p className="text-fg-subtle mt-4 font-mono text-xs">{me.repoId}</p>

      <div className="mt-8">
        <PreviewNotice previews={digests.filter((d) => d.status === 'preview')} />
      </div>

      <Part id="sessions-heading" title="Recent sessions" all={{ href: '/tickets', label: 'All tickets' }}>
        <RecentSessions sessions={recentSessions(report, 5)} />
      </Part>

      <Part id="tickets-heading" title="Recently active tickets" all={{ href: '/tickets', label: 'All tickets' }}>
        <TicketTable groups={[{ sprint: 'Last activity first', tickets: recentTickets(report, 5), unlinked: 0 }]} />
      </Part>

      <Part id="digests-heading" title="Latest digests" all={{ href: '/digests', label: 'All digests' }}>
        <DigestTable digests={digests.slice(0, 3)} />
      </Part>
    </>
  );
}
