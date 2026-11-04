import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { THEME_STORAGE_KEY } from '~/components/theme-script';
import { ThemeToggle } from '~/components/theme-toggle';

const prefersLight = (light: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: light, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
};

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = 'dark';
    prefersLight(false);
  });

  it('is dark by default, and remembers a light, dark or system choice', async () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    await userEvent.click(screen.getByRole('button', { name: 'System theme' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it("applies the role's default when nothing is stored, including when the role changes after sign-in", () => {
    prefersLight(true);
    const { rerender } = render(<ThemeToggle defaultTheme="dark" />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    rerender(<ThemeToggle defaultTheme="system" />);
    expect(screen.getByRole('button', { name: 'System theme' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps a stored choice whatever the role default', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    prefersLight(true);
    render(<ThemeToggle defaultTheme="system" />);
    expect(screen.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
