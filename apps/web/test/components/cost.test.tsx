import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { navFor } from '~/components/app-header';
import { CostBreakdown, CostTotals } from '~/components/cost-summary';
import { CostSessions } from '~/components/cost-sessions';
import { usd } from '~/lib/cost-format';
import { costFlag, costReport, costSession } from './fixtures';

// The Cost view (Phase 12, D107).

const actions = () => ({ flag: vi.fn(async () => ({ status: 'ok' as const })), reply: vi.fn(async () => ({ status: 'ok' as const })), settle: vi.fn(async () => ({ status: 'ok' as const })) });

describe('usd', () => {
  it('shows cents, and more than nothing as less than a cent', () => {
    expect([usd(1_250_000), usd(0), usd(4_000), usd(1_234_567_890)]).toEqual(['$1.25', '$0.00', '<$0.01', '$1,234.57']);
    expect(usd(null)).toBe('No price');
  });
});

describe('the Cost link', () => {
  it('is in the nav for anyone who has something to see there, and no one else', () => {
    const labels = (role: 'developer' | 'reader', access: 'all' | 'own' | 'none' | 'off') => navFor(role, access).map((n) => n.label);
    expect(labels('reader', 'all')).toContain('Cost');
    expect(labels('developer', 'own')).toContain('Cost');
    for (const access of ['none', 'off'] as const) expect(labels('reader', access)).toEqual(['Digests', 'Reports']);
    expect(labels('developer', 'off')).not.toContain('Cost');
  });
});

describe('CostTotals', () => {
  it('calls everything an estimate, and says subscription amounts are not money spent', () => {
    render(<CostTotals report={costReport()} />);
    expect(screen.getByText('$3.75')).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
    expect(screen.getByText(/\$1\.25 of this was on subscriptions: an API-equivalent estimate, not money spent\./)).toBeInTheDocument();
  });

  it('leaves the subscription line out when there is none, and says what could not be priced', () => {
    render(<CostTotals report={costReport({ billing: { api: 1, subscription: 0, unknown: 0 }, unpricedRequests: 3 })} />);
    expect(screen.queryByText(/not money spent/)).toBeNull();
    expect(screen.getByText(/3 requests have no price set, so they are not in the total\./)).toBeInTheDocument();
  });
});

describe('CostBreakdown', () => {
  it('lists developers by name with a link to each one’s sessions, and tickets', () => {
    render(<CostBreakdown report={costReport()} hrefFor={(id) => `/cost?developer=${id}`} />);
    const rows = within(screen.getByRole('table', { name: 'Cost by developer' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Alice'), expect.stringContaining('Bob')]);
    expect(screen.getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/cost?developer=bob');
    expect(within(screen.getByRole('table', { name: 'Cost by ticket' })).getByText('Account lockout')).toBeInTheDocument();
  });
});

describe('CostSessions', () => {
  it('links a commit on a known host, and labels where the work was without naming other repos', () => {
    render(<CostSessions sessions={costReport().sessions} scope="all" {...actions()} />);
    const sha = 'a1b2c3d4'.repeat(5);
    expect(screen.getByRole('link', { name: 'Commit a1b2c3d' })).toHaveAttribute('href', `https://github.com/acme/webapp/commit/${sha}`);
    expect(screen.getByText('Shared repo')).toBeInTheDocument();
    expect(screen.getByText('Outside company repos')).toBeInTheDocument();
    expect(screen.getByText('No commit')).toBeInTheDocument();
  });

  it('shows a commit on another host as plain text', () => {
    render(<CostSessions sessions={[costSession({ commits: [{ repoId: 'git.acme.example/webapp', sha: 'b'.repeat(40) }] })]} scope="all" {...actions()} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('bbbbbbb')).toBeInTheDocument();
  });

  it('lets a manager flag a session to discuss, with an optional note', async () => {
    const a = actions();
    render(<CostSessions sessions={[costSession()]} scope="all" {...a} />);
    await userEvent.click(screen.getByRole('button', { name: /^Flag to discuss/ }));
    await userEvent.type(screen.getByLabelText('Note for Alice (optional)'), 'Is this ours?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(a.flag).toHaveBeenCalledWith({ agent: 'claude-code', sessionId: costSession().sessionId, developerId: 'alice', note: 'Is this ours?' });
  });

  it('shows a developer the flag and lets them reply or mark it resolved, but not flag', async () => {
    const a = actions();
    render(<CostSessions sessions={[costSession({ flags: [costFlag()] })]} scope="own" {...a} />);
    expect(screen.getByText('To discuss')).toBeInTheDocument();
    expect(screen.getByText('Is this ours?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Flag to discuss/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Reply/ }));
    await userEvent.type(screen.getByLabelText('Your reply'), 'A spike.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(a.reply).toHaveBeenCalledWith('f-1', 'A spike.');
    await userEvent.click(screen.getByRole('button', { name: /^Mark resolved/ }));
    expect(a.settle).toHaveBeenCalledWith('f-1');
  });

  it('shows the server’s refusal', async () => {
    const a = { ...actions(), flag: vi.fn(async () => ({ status: 'error' as const, message: 'note: contains a secret (github_token)' })) };
    render(<CostSessions sessions={[costSession()]} scope="all" {...a} />);
    await userEvent.click(screen.getByRole('button', { name: /^Flag to discuss/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('note: contains a secret (github_token)');
  });

  it('keeps a settled flag readable, and lets a manager flag again', () => {
    render(<CostSessions sessions={[costSession({ flags: [costFlag({ resolvedAt: '2026-04-09T09:00:00.000Z', resolvedBy: 'Alice' })] })]} scope="all" {...actions()} />);
    expect(screen.getByText('Resolved by Alice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Flag to discuss/ })).toBeInTheDocument();
  });

  it('says when there is nothing to show', () => {
    render(<CostSessions sessions={[]} scope="all" {...actions()} />);
    expect(screen.getByText('No sessions recorded for this period.')).toBeInTheDocument();
  });

  it('never ranks, scores or accuses', () => {
    const { container } = render(
      <>
        <CostTotals report={costReport()} />
        <CostBreakdown report={costReport()} hrefFor={() => '/cost'} />
        <CostSessions sessions={costReport().sessions} scope="all" {...actions()} />
      </>,
    );
    expect(container.textContent).not.toMatch(/\brank|top spender|leaderboard|violation|misuse|personal use|suspicious|score/i);
  });
});
