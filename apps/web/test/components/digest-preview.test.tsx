import { render, screen, within } from '@testing-library/react';
import { JargonCallout, PreviewBanner } from '~/components/digest-preview';

describe('JargonCallout', () => {
  it('lists the terms the jargon check flagged, in an amber callout that says why they are still there', () => {
    render(<JargonCallout warnings={['jargon: API', 'jargon: webhook']} />);
    const callout = screen.getByRole('note', { name: '2 terms a stakeholder may not know' });
    expect(callout).toHaveClass('callout-attention');
    expect(within(callout).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['API', 'webhook']);
    expect(within(callout).getByText('API')).toHaveClass('font-mono');
    expect(callout).toHaveTextContent('The writer was asked once to explain or avoid them, and they were still there, so the digest was kept.');
  });

  it('names a single term in the singular', () => {
    render(<JargonCallout warnings={['jargon: schema']} />);
    expect(screen.getByRole('note', { name: '1 term a stakeholder may not know' })).toBeInTheDocument();
  });

  it('shows nothing when nothing was flagged', () => {
    const { container } = render(<JargonCallout warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PreviewBanner', () => {
  it('says readers do not see it yet, and when it sends', () => {
    render(<PreviewBanner previewUntil="2026-04-28T06:00:00.000Z" />);
    expect(screen.getByRole('note')).toHaveTextContent('In preview: readers don’t see this yet. It sends after 2026-04-28 06:00 UTC.');
    expect(screen.getByRole('note')).not.toHaveClass('callout-attention');
  });
});
