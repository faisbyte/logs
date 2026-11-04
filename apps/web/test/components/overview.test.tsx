import type { TicketReport } from '@digest/core';
import { render, screen, within } from '@testing-library/react';
import { PreviewNotice, RecentSessions, recentSessions, recentTickets } from '~/components/overview';
import { summary } from './fixtures';

const link = (ticketKey: string) => ({ sessionId: 's', ticketKey, source: 'branch' as const, addedBy: null, addedAt: null });
const shared = summary({ sessionId: 's2', developerName: 'Bob', startedAt: '2026-04-12T09:00:00.000Z', endedAt: '2026-04-12T10:00:00.000Z', goal: 'Show when a locked account can try again.', ticketRefs: ['PROJ-201', 'PROJ-202'], aiInvolvement: 'light' });
const report = {
  repoId: 'github.com/acme/webapp',
  filter: { from: '2000-01-01', to: '2100-01-01' },
  summaryCount: 4,
  developerCount: 2,
  sprints: [
    {
      sprint: { name: 'Sprint 7', from: '2026-04-06T00:00:00.000Z', to: '2026-04-20T00:00:00.000Z' },
      tickets: [
        { key: 'PROJ-201', title: 'Account lockout', summaries: [{ summary: summary(), link: link('PROJ-201') }, { summary: shared, link: link('PROJ-201') }] },
        { key: 'PROJ-202', title: null, summaries: [{ summary: shared, link: link('PROJ-202') }] },
      ],
      unlinked: [summary({ sessionId: 's4', ticketRefs: [], goal: 'Tidy the test helpers.', startedAt: '2026-04-10T09:00:00.000Z', endedAt: '2026-04-10T09:30:00.000Z' })],
    },
    {
      sprint: { name: 'Sprint 6', from: '2026-03-23T00:00:00.000Z', to: '2026-04-06T00:00:00.000Z' },
      tickets: [{ key: 'PROJ-150', title: 'Password reset', summaries: [{ summary: summary({ sessionId: 's0', startedAt: '2026-03-30T09:00:00.000Z', endedAt: '2026-03-30T10:00:00.000Z', ticketRefs: ['PROJ-150'] }), link: link('PROJ-150') }] }],
      unlinked: [],
    },
  ],
} as TicketReport;

describe('recentSessions', () => {
  it('lists each summary once, newest first, with every ticket it touched, the unlinked ones too', () => {
    expect(recentSessions(report, 10).map((s) => [s.date, s.developer, s.tickets, s.href])).toEqual([
      ['2026-04-12', 'Bob', ['PROJ-201', 'PROJ-202'], '/tickets/PROJ-201'],
      ['2026-04-10', 'Alice', [], null],
      ['2026-04-07', 'Alice', ['PROJ-201'], '/tickets/PROJ-201'],
      ['2026-03-30', 'Alice', ['PROJ-150'], '/tickets/PROJ-150'],
    ]);
    expect(recentSessions(report, 2)).toHaveLength(2);
  });
});

describe('recentTickets', () => {
  it('lists the most recently active tickets across sprints, newest first', () => {
    expect(recentTickets(report, 2).map((t) => [t.key, t.last])).toEqual([
      ['PROJ-201', '2026-04-12'],
      ['PROJ-202', '2026-04-12'],
    ]);
    expect(recentTickets(report, 9).map((t) => t.key)).toEqual(['PROJ-201', 'PROJ-202', 'PROJ-150']);
  });
});

describe('RecentSessions', () => {
  it('shows who, when, the goal, its tickets and AI involvement; a ticketed row is one link to its timeline', () => {
    render(<RecentSessions sessions={recentSessions(report, 5)} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('link', { name: 'Show when a locked account can try again.' })).toHaveAttribute('href', '/tickets/PROJ-201');
    expect(within(rows[0]!).getByRole('link')).toHaveClass('row-link');
    expect(rows[0]).toHaveTextContent('PROJ-201 PROJ-202');
    expect(rows[0]).toHaveTextContent('light');
    expect(within(rows[1]!).queryByRole('link')).toBeNull();
    expect(rows[1]).toHaveTextContent('No ticket');
  });

  it('says plainly when nothing has been shared yet', () => {
    render(<RecentSessions sessions={[]} />);
    expect(screen.getByText('No approved summaries yet.')).toBeInTheDocument();
  });
});

describe('PreviewNotice', () => {
  const preview = { id: 'd1', periodLabel: 'Week of 2026-04-20', previewUntil: '2026-04-28T06:00:00.000Z', warnings: ['jargon: API', 'jargon: webhook'] };
  it('lists each digest in preview with when it sends, and how many terms were flagged', () => {
    render(<PreviewNotice previews={[preview, { ...preview, id: 'd2', periodLabel: 'Week of 2026-04-27', warnings: [] }]} />);
    const notice = screen.getByRole('region', { name: 'In preview' });
    expect(within(notice).getByRole('link', { name: 'Week of 2026-04-20' })).toHaveAttribute('href', '/digests/d1');
    expect(notice).toHaveTextContent('Sends after 2026-04-28 06:00 UTC');
    expect(within(notice).getByText('2 flagged terms')).toHaveAttribute('data-tone', 'attention');
    expect(within(notice).getAllByText(/flagged term/)).toHaveLength(1);
  });

  it('is left out when nothing is in preview', () => {
    const { container } = render(<PreviewNotice previews={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
