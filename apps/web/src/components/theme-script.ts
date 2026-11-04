export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'logs-theme';

/**
 * Runs in <head> before first paint so the page never flashes the wrong theme. Dark is the default when nothing is
 * stored; "system" follows prefers-color-scheme. The same rule as the showcase site.
 */
export const themeScript = `(function () {
  try {
    var p = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var t = p === "light" || p === "dark" ? p
      : p === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : "dark";
    document.documentElement.dataset.theme = t;
  } catch (e) {}
})();`;
