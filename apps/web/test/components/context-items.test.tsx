import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextItems } from '~/components/context-items';
import { item } from './fixtures';

const items = [
  item(),
  item({ id: 'ctx-00000002', type: 'decision', text: 'Failed logins are counted per account.', reason: 'Offices share one address.', paths: ['src/auth/login.ts'] }),
  item({ id: 'ctx-00000003', type: 'convention', text: 'Handlers return ok and reason.', reason: 'Callers branch on it.', paths: ['src/api/handlers.ts'], tickets: [] }),
];
const notes = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => r.id);
const chip = (name: RegExp) => screen.getByRole('button', { name });

describe('ContextItems filters', () => {
  it('filters by type with toggle chips that show their counts, several at once', async () => {
    render(<ContextItems items={items} empty="None." />);
    expect(screen.getByRole('group', { name: 'Filter by type' })).toBeInTheDocument();
    expect(chip(/^Pitfall 1$/)).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip(/^Pitfall/));
    expect(chip(/^Pitfall/)).toHaveAttribute('aria-pressed', 'true');
    expect(notes()).toEqual(['ctx-00000001']);
    await userEvent.click(chip(/^Convention/));
    expect(notes()).toEqual(['ctx-00000001', 'ctx-00000003']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 2 of 3 items');
    await userEvent.click(chip(/^Pitfall/));
    expect(notes()).toEqual(['ctx-00000003']);
  });

  it('searches the text, reason, paths, tickets and id, in any case, together with the chips', async () => {
    render(<ContextItems items={items} empty="None." />);
    const search = screen.getByRole('searchbox', { name: 'Search items' });
    await userEvent.type(search, 'OFFICES');
    expect(notes()).toEqual(['ctx-00000002']);
    await userEvent.clear(search);
    await userEvent.type(search, 'src/auth');
    expect(notes()).toEqual(['ctx-00000001', 'ctx-00000002']);
    await userEvent.click(chip(/^Decision/));
    expect(notes()).toEqual(['ctx-00000002']);
    await userEvent.clear(search);
    await userEvent.type(search, 'ctx-00000003');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when nothing matches, and clears the filters in one go', async () => {
    render(<ContextItems items={items} empty="None." />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search items' }), 'no such thing');
    expect(screen.getByText('No items match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Showing 0 of 3 items');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(notes()).toHaveLength(3);
    expect(screen.getByRole('searchbox', { name: 'Search items' })).toHaveValue('');
  });

  it("shows the tab's own empty state, without filters, when the tab has nothing", () => {
    render(<ContextItems items={[]} empty="Nothing has been superseded yet." />);
    expect(screen.getByText('Nothing has been superseded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('ContextItems retire', () => {
  it('offers Retire only when the list allows it', () => {
    render(<ContextItems items={items} empty="None." />);
    expect(screen.queryByRole('button', { name: /^Retire/ })).toBeNull();
  });

  it('asks before retiring; Cancel or Escape leaves the item and puts focus back on its button', async () => {
    const retire = vi.fn();
    render(<ContextItems items={items} empty="None." retire={retire} />);
    const button = screen.getByRole('button', { name: 'Retire ctx-00000001' });
    await userEvent.click(button);
    const confirm = screen.getByRole('group', { name: 'Retire ctx-00000001?' });
    expect(confirm).toHaveTextContent('For everyone on this repo. It won’t come back on its own.');
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Retire ctx-00000001' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Retire ctx-00000001' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Retire ctx-00000001?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retire ctx-00000001' })).toHaveFocus();
    expect(retire).not.toHaveBeenCalled();
  });

  it('retires on confirmation and says so, the way the CLI does', async () => {
    const retire = vi.fn().mockResolvedValue({ status: 'retired', id: 'ctx-00000002' });
    render(<ContextItems items={items} empty="None." retire={retire} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retire ctx-00000002' }));
    await userEvent.click(screen.getByRole('button', { name: 'Retire item' }));
    expect(retire).toHaveBeenCalledWith('ctx-00000002');
    expect(await screen.findByText('Retired ctx-00000002. It won’t come back on its own.')).toBeInTheDocument();
  });

  it("shows the server's refusal as an alert", async () => {
    const retire = vi.fn().mockResolvedValue({ status: 'error', message: 'reader tokens can read digests and reports only' });
    render(<ContextItems items={items} empty="None." retire={retire} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retire ctx-00000001' }));
    await userEvent.click(screen.getByRole('button', { name: 'Retire item' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('reader tokens can read digests and reports only');
  });
});
