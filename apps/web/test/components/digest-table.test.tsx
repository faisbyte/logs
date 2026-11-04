import { render, screen, within } from '@testing-library/react';
import { DigestTable, type DigestRow } from '~/components/digest-table';

const row = (over: Partial<DigestRow> = {}): DigestRow => ({
  id: 'd1',
  kind: 'scheduled',
  periodLabel: 'Sprint 1 (2026-10-28 to 2026-10-30)',
  status: 'sent',
  summaryCount: 3,
  developerCount: 1,
  createdAt: '2026-10-31T05:52:07.048Z',
  sentAt: '2026-10-31T05:52:30.000Z',
  corrects: null,
  ...over,
});

describe('DigestTable', () => {
  it('says plainly when there are no digests yet', () => {
    render(<DigestTable digests={[]} />);
    expect(screen.getByText('No digests yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('lists each digest by period with its kind, status, coverage and date, linking to it', () => {
    render(<DigestTable digests={[row(), row({ id: 'r1', kind: 'report', status: 'ready', periodLabel: '2026-10-01 to 2026-10-31', sentAt: null, summaryCount: 1 })]} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['Sprint 1 (2026-10-28 to 2026-10-30)', 'Scheduled', 'Sent', '3 summaries · 1 developer', '2026-10-31'],
      ['2026-10-01 to 2026-10-31', 'Report', 'Ready', '1 summary · 1 developer', '2026-10-31'],
    ]);
    expect(screen.getByRole('link', { name: 'Sprint 1 (2026-10-28 to 2026-10-30)' })).toHaveAttribute('href', '/digests/d1');
  });

  it('marks corrected and withdrawn digests', () => {
    render(<DigestTable digests={[row({ id: 'c1', corrects: 'd0' }), row({ id: 'd0', status: 'withdrawn' })]} />);
    expect(screen.getByText('Corrected')).toHaveAttribute('data-tone', 'attention');
    expect(screen.getByText('Withdrawn')).toHaveAttribute('data-tone', 'attention');
  });
});
