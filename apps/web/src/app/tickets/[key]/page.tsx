import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SectionHeader } from '~/components/section-header';
import { TicketTimeline } from '~/components/ticket-timeline';
import { api, developerOnly } from '~/lib/api';

export const metadata: Metadata = { title: 'Ticket' };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function TicketPage({ params }: { params: Promise<{ key: string }> }) {
  const me = await developerOnly();
  const key = decodeURIComponent((await params).key);
  const [summaries, report] = await Promise.all([api.ticketSummaries(me.repoId, key), api.tickets(me.repoId)]);
  if (!summaries.length) notFound();
  const title = report.sprints.flatMap((g) => g.tickets).find((t) => t.key === key)?.title ?? null;
  const developers = new Set(summaries.map((s) => s.developerId)).size;
  return (
    <div className="max-w-3xl">
      <Link href="/tickets" className="text-fg-muted hover:text-fg font-mono text-xs">
        ← All tickets
      </Link>
      <div className="mt-4">
        <SectionHeader
          index="03"
          label={key}
          title={title ?? key}
          line={`${count(summaries.length, 'approved summary', 'approved summaries')} from ${count(developers, 'developer', 'developers')}, oldest first.`}
        />
      </div>
      <div className="mt-8">
        <TicketTimeline summaries={summaries} />
      </div>
    </div>
  );
}
