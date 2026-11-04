import { render, screen } from '@testing-library/react';
import { TerminalPanel } from '~/components/terminal-panel';

describe('TerminalPanel', () => {
  it('is a labelled region on the terminal palette, whatever the theme', () => {
    render(<TerminalPanel title="sprintdigest context src/auth">output</TerminalPanel>);
    const region = screen.getByRole('region', { name: 'sprintdigest context src/auth' });
    expect(region).toHaveClass('terminal');
    expect(region).toHaveTextContent('output');
  });
});
