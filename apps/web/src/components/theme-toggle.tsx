'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { THEME_STORAGE_KEY, type ThemePreference } from '~/components/theme-script';

const OPTIONS = [
  { value: 'system', label: 'System theme', Icon: Monitor },
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'dark', label: 'Dark theme', Icon: Moon },
] as const;

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return 'dark';
}

function apply(pref: ThemePreference) {
  const resolved = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = resolved;
}

/** Three-way theme switch: system, light, dark. Dark is the default; the choice is remembered. */
export function ThemeToggle() {
  // Starts at the default so the server render and the first client render agree; the stored choice loads after.
  const [pref, setPref] = useState<ThemePreference>('dark');

  useEffect(() => setPref(readPreference()), []);

  useEffect(() => {
    if (pref !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => apply('system');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [pref]);

  function choose(next: ThemePreference) {
    setPref(next);
    apply(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
  }

  return (
    <div role="group" aria-label="Colour theme" className="border-line bg-bg-elev flex items-center rounded-full border p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = pref === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => choose(value)}
            className={`grid size-7 place-items-center rounded-full transition-colors ${active ? 'bg-bg-subtle text-fg' : 'text-fg-subtle hover:text-fg'}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
