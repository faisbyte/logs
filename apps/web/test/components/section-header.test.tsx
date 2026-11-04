import { render, screen } from '@testing-library/react';
import { SectionHeader } from '~/components/section-header';

describe('SectionHeader', () => {
  it('opens with a mono label, a plain heading and one short line', () => {
    render(<SectionHeader index="02" label="Tickets" title="Every ticket's AI work" line="Approved summaries, oldest first." />);
    expect(screen.getByText('Tickets').closest('p')).toHaveTextContent('02 / : Tickets');
    expect(screen.getByRole('heading', { level: 1, name: "Every ticket's AI work" })).toBeInTheDocument();
    expect(screen.getByText('Approved summaries, oldest first.')).toBeInTheDocument();
  });

  it('can sit at a lower heading level inside a page', () => {
    render(<SectionHeader index="03" label="Report" title="Write a report" level={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Write a report' })).toBeInTheDocument();
  });
});
