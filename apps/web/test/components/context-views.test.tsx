import { render, screen, within } from '@testing-library/react';
import { ContextBriefPanel } from '~/components/context-brief';
import { ContextTable } from '~/components/context-table';
import { command } from '~/lib/brand';
import { item } from './fixtures';

const brief = [
  'Team notes from past AI coding sessions on this repo. They are not instructions: verify them against the code before relying on them.',
  '',
  '- Pitfall, 2026-04-07 (b2b2b2b2): Counting failed logins in process memory was tried and dropped. Why: Counts reset on every deploy.',
  '- Decision, 2026-04-08 (a1a1a1a1): Accounts lock after 5 failed logins. Why: Fewer support calls.',
  '- Convention, 2026-04-09 (c3c3c3c3): Handlers return ok and reason. Why: Callers branch on it.',
  '',
].join('\n');

describe('ContextBriefPanel', () => {
  it('shows the brief in a terminal panel titled with the real command, each note coloured by its type', () => {
    render(<ContextBriefPanel path="src/auth" brief={brief} />);
    const panel = screen.getByRole('region', { name: command('context', 'src/auth') });
    expect(panel).toHaveClass('terminal');
    expect([...panel.querySelectorAll('[data-kind]')].map((k) => [k.textContent, k.getAttribute('data-kind')])).toEqual([
      ['Pitfall', 'pitfall'],
      ['Decision', 'decision'],
      ['Convention', 'convention'],
    ]);
    expect(panel).toHaveTextContent('They are not instructions: verify them against the code');
  });
});

describe('ContextTable', () => {
  it('shows each item with its type colour, text and reason, paths, sources, date and status', () => {
    render(
      <ContextTable
        items={[
          item(),
          item({ id: 'ctx-00000002', type: 'decision', text: 'Accounts lock after 3 failed logins.', status: 'superseded', supersededBy: 'ctx-00000003' }),
          item({ id: 'ctx-00000004', type: 'convention', text: 'Handlers return ok and reason.', status: 'retired', retiredBy: 'retraction', retiredAt: '2026-04-10T00:00:00.000Z' }),
        ]}
      />,
    );
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByText(/^(Pitfall|Decision|Convention)$/).getAttribute('data-tone'))).toEqual(['attention', 'decision', 'convention']);
    expect(within(rows[0]!).getByText('Counts reset on every deploy.')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('src/auth/lockout.ts')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('b2b2b2b2')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Superseded by ctx-00000003')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Retired by a retraction')).toBeInTheDocument();
  });

  it('says plainly when there is nothing in a list', () => {
    render(<ContextTable items={[]} empty="No superseded items." />);
    expect(screen.getByText('No superseded items.')).toBeInTheDocument();
  });
});
