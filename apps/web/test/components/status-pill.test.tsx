import { render, screen } from '@testing-library/react';
import { StatusPill, toneForDigest, toneForItem } from '~/components/status-pill';

// One meaning per accent, everywhere (docs/dashboard-design.md): green approved or safe, amber pitfall, warning or
// needs attention, blue decision, violet convention.
describe('StatusPill', () => {
  it('renders its label with the tone as data, for styling and tests', () => {
    render(<StatusPill tone="safe">Sent</StatusPill>);
    expect(screen.getByText('Sent')).toHaveAttribute('data-tone', 'safe');
  });

  it('maps context item types and digest statuses to the shared accents', () => {
    expect([toneForItem('pitfall'), toneForItem('decision'), toneForItem('convention')]).toEqual(['attention', 'decision', 'convention']);
    expect([toneForDigest('sent'), toneForDigest('withdrawn'), toneForDigest('preview'), toneForDigest('ready')]).toEqual(['safe', 'attention', 'neutral', 'neutral']);
  });
});
