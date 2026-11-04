import { render, screen, within } from '@testing-library/react';
import { TicketTable, ticketRows } from '~/components/ticket-table';
import { summary } from './fixtures';

const link = { sessionId: 's1', ticketKey: 'PROJ-201', source: 'branch' as const, addedBy: null, addedAt: null };
const report = {
  repoId: 'github.com/acme/webapp',
  filter: { from: '2000-01-01', to: '2100-01-01' },
  summaryCount: 3,
  developerCount: 2,
  sprints: [
    {
      sprint: { name: 'Sprint 7', from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z' },
      tickets: [
        { key: 'PROJ-201', title: 'Account lockout', summaries: [{ summary: summary(), link }, { summary: summary({ sessionId: 's2', developerName: 'Bob', endedAt: '2026-04-12T10:00:00.000Z' }), link }] },
        { key: 'PROJ-202', title: null, summaries: [{ summary: summary({ sessionId: 's3' }), link }] },
      ],
      unlinked: [summary({ sessionId: 's4', ticketRefs: [] })],
    },
  ],
};

describe('TicketTable', () => {
  it('lists every ticket under its sprint, each row one link to its timeline, with counts and last activity', () => {
    render(<TicketTable groups={ticketRows(report)} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Sprint 7' })).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['PROJ-201', 'Account lockout', '2 summaries · 2 developers', '2026-04-12'],
      ['PROJ-202', 'No title', '1 summary · 1 developer', '2026-04-07'],
    ]);
    expect(within(rows[0]!).getAllByRole('link')).toHaveLength(1);
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', '/tickets/PROJ-201');
    expect(screen.getByText('1 summary in this sprint is linked to no ticket.')).toBeInTheDocument();
  });

  it('says so plainly when no summary is linked to a ticket yet', () => {
    render(<TicketTable groups={[]} />);
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument();
  });
});
