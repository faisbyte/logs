import type { Metadata } from 'next';
import { SectionHeader } from '~/components/section-header';
import { TicketTable, ticketRows } from '~/components/ticket-table';
import { api, developerOnly } from '~/lib/api';

export const metadata: Metadata = { title: 'Tickets' };

export default async function TicketsPage() {
  const me = await developerOnly();
  const report = await api.tickets(me.repoId);
  return (
    <>
      <SectionHeader index="03" label="Tickets" title="Tickets" line="Every ticket with approved AI work, by sprint. Open one for its timeline." />
      <div className="mt-8">
        <TicketTable groups={ticketRows(report)} />
      </div>
    </>
  );
}
