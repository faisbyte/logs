export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'logs-theme';

/** The default when nothing is stored: the server sets it on <html> by role (readers system, developers dark). */
export const defaultPreference = (): ThemePreference => {
  const d = typeof document === 'undefined' ? undefined : document.documentElement.dataset.defaultTheme;
  return d === 'light' || d === 'system' ? d : 'dark';
};

/**
 * Runs in <head> before first paint so the page never flashes the wrong theme. A stored choice always wins; otherwise
 * the role's default; "system" follows prefers-color-scheme.
 */
export const themeScript = `(function () {
  try {
    var root = document.documentElement;
    var p = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || root.dataset.defaultTheme || "dark";
    var t = p === "light" || p === "dark" ? p
      : p === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : "dark";
    root.dataset.theme = t;
  } catch (e) {}
})();`;
