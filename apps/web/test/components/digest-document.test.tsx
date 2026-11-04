import { render, screen, within } from '@testing-library/react';
import { DigestDocument, parseDigest } from '~/components/digest-document';

// The digest Markdown the server writes, rendered as React elements: no HTML is ever injected (DECISIONS.md D93).

const digest = [
  '# AI work update (corrected): Sprint 7 (2026-04-06 to 2026-04-19)',
  '',
  '_This corrects the update sent on 2026-04-20: a developer withdrew a summary it included._',
  '',
  'Sprint 7 delivered the account lockout.',
  '',
  '**AI involvement: moderate for every ticket.** AI wrote parts of the changes.',
  '',
  '## PROJ-201: Account lockout',
  '',
  'Accounts now lock after 5 failed logins.',
  '',
  '**Key decisions:**',
  '',
  '- Accounts unlock automatically after 15 minutes.',
  '- Unlocking only through support was rejected.',
  '',
  '## Risks and open questions',
  '',
  '- The support team has not yet been told.',
  '',
  '_Based on 3 summaries that 2 developers chose to share._',
  '',
].join('\n');

describe('parseDigest', () => {
  it('splits the digest into a title, a correction note, sections and the coverage line', () => {
    const parsed = parseDigest(digest);
    expect(parsed.title).toBe('AI work update (corrected): Sprint 7 (2026-04-06 to 2026-04-19)');
    expect(parsed.corrected).toBe(true);
    expect(parsed.correction).toBe('This corrects the update sent on 2026-04-20: a developer withdrew a summary it included.');
    expect(parsed.coverage).toBe('Based on 3 summaries that 2 developers chose to share.');
    expect(parsed.sections.map((s) => s.heading)).toEqual([null, 'PROJ-201: Account lockout', 'Risks and open questions']);
  });
});

describe('DigestDocument', () => {
  it('renders headings, paragraphs, bold runs and lists, with the coverage line as shown by the server', () => {
    render(<DigestDocument markdown={digest} />);
    expect(screen.getByRole('heading', { level: 2, name: /AI work update \(corrected\)/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'PROJ-201: Account lockout' })).toBeInTheDocument();
    expect(screen.getByText('AI involvement: moderate for every ticket.').tagName).toBe('STRONG');
    const risks = screen.getByRole('heading', { level: 3, name: 'Risks and open questions' }).parentElement!;
    expect(within(risks).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['The support team has not yet been told.']);
    expect(screen.getByText('Based on 3 summaries that 2 developers chose to share.')).toHaveAttribute('data-coverage');
  });

  it('marks a corrected version clearly, above the text', () => {
    render(<DigestDocument markdown={digest} />);
    expect(screen.getByText('Corrected')).toHaveAttribute('data-tone', 'attention');
    expect(screen.getByRole('note')).toHaveTextContent('This corrects the update sent on 2026-04-20');
  });

  it('sets every ticket key in neutral mono, one ticket per block so narrow screens put each on its own line', () => {
    const { container } = render(<DigestDocument markdown={'# T\n\n## LOGS-1: Session parsing · LOGS-2: Secret redaction\n\nText.\n'} />);
    expect([...container.querySelectorAll('h3 [data-ticket]')].map((t) => t.textContent)).toEqual(['LOGS-1: Session parsing', 'LOGS-2: Secret redaction']);
    expect([...container.querySelectorAll('h3 .ticket-key')].map((k) => k.textContent)).toEqual(['LOGS-1', 'LOGS-2']);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('LOGS-1: Session parsing · LOGS-2: Secret redaction');
  });

  it('marks "Key decisions" in blue and "Risks and open questions" in amber, subtly', () => {
    const { container } = render(<DigestDocument markdown={digest} />);
    expect(screen.getByText('Key decisions:').closest('[data-marker]')).toHaveAttribute('data-marker', 'decision');
    expect(screen.getByRole('heading', { level: 3, name: 'Risks and open questions' }).querySelector('.marker')).toHaveAttribute('data-marker', 'attention');
    expect(container.querySelectorAll('.marker')).toHaveLength(2);
  });

  it('shows markup in the text as text, never as HTML', () => {
    const { container } = render(<DigestDocument markdown={'# Title\n\nA <script>alert(1)</script> and <b>bold</b> line.\n'} />);
    expect(container.querySelector('script, b')).toBeNull();
    expect(screen.getByText(/A <script>alert\(1\)<\/script> and <b>bold<\/b> line\./)).toBeInTheDocument();
  });
});
