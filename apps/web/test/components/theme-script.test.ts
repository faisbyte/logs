import { THEME_STORAGE_KEY, themeScript } from '~/components/theme-script';

// The theme before first paint: a stored choice wins; otherwise the role's default, set by the server on <html>
// (readers follow the system, developers get dark).
const run = () => new Function(themeScript)();
const prefersLight = (light: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: light, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
};

describe('themeScript', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.defaultTheme;
    prefersLight(true);
  });

  it("uses the role's default when nothing is stored", () => {
    document.documentElement.dataset.defaultTheme = 'system';
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
    document.documentElement.dataset.defaultTheme = 'dark';
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('is dark with no default at all, and a stored choice always wins', () => {
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
    document.documentElement.dataset.defaultTheme = 'system';
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
