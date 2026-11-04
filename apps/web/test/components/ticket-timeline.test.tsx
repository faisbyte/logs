import { render, screen, within } from '@testing-library/react';
import { TicketTimeline } from '~/components/ticket-timeline';
import { summary } from './fixtures';

const later = summary({ sessionId: 's2', developerName: 'Bob', startedAt: '2026-04-12T09:00:00.000Z', endedAt: '2026-04-12T10:00:00.000Z', goal: 'Show when a locked account can try again.', decisions: [], rejectedApproaches: [], risksOrFollowUps: [] });

describe('TicketTimeline', () => {
  it('shows every approved summary for the ticket, oldest first, with who, when and how much AI', () => {
    render(<TicketTimeline summaries={[later, summary()]} />);
    const entries = within(screen.getByRole('list', { name: 'Summaries, oldest first' })).getAllByRole('listitem', { name: /./ });
    expect(entries.map((e) => e.getAttribute('aria-label'))).toEqual(['2026-04-07, Alice', '2026-04-12, Bob']);
    // Every entry is approved, so that goes without saying.
    expect(within(entries[0]!).queryByText(/approved/i)).toBeNull();
    expect(within(entries[0]!).getByText('AI involvement: heavy')).toBeInTheDocument();
    expect(within(entries[0]!).getByRole('heading', { level: 3, name: 'Lock accounts after repeated failed logins.' })).toBeInTheDocument();
  });

  it('shows only the approval states that differ: edited by the developer (neutral), and auto-approved (needs a look)', () => {
    render(<TicketTimeline summaries={[summary({ editedByDeveloper: true }), summary({ sessionId: 's3', approvedBy: 'auto', startedAt: '2026-04-09T09:00:00.000Z' })]} />);
    const [edited, auto] = within(screen.getByRole('list', { name: 'Summaries, oldest first' })).getAllByRole('listitem', { name: /./ });
    expect(within(edited!).getByText('Edited by developer')).toHaveAttribute('data-tone', 'neutral');
    expect(within(edited!).queryByText('Auto-approved')).toBeNull();
    expect(within(auto!).getByText('Auto-approved')).toHaveAttribute('data-tone', 'attention');
    expect(within(auto!).queryByText('Edited by developer')).toBeNull();
  });

  it('marks decisions in blue and rejected approaches in amber, with follow-ups unmarked', () => {
    render(<TicketTimeline summaries={[summary()]} />);
    expect(screen.getByText('Decisions').closest('[data-marker]')).toHaveAttribute('data-marker', 'decision');
    expect(screen.getByText('Tried and dropped').closest('[data-marker]')).toHaveAttribute('data-marker', 'attention');
    expect(screen.getByText('Follow-ups').closest('[data-marker]')).toBeNull();
    expect(screen.getByText('Count failures per account.').closest('li')).toHaveTextContent('Count failures per account. Why: Offices share one address.');
    expect(screen.getByText('Counting in process memory.')).toBeInTheDocument();
    expect(screen.getByText('Tell support about the lockout.')).toBeInTheDocument();
  });

  it('leaves out empty lists rather than showing empty headings', () => {
    render(<TicketTimeline summaries={[later]} />);
    expect(screen.queryByText('Decisions')).toBeNull();
    expect(screen.queryByText('Tried and dropped')).toBeNull();
  });
});
