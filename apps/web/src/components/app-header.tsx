import Link from 'next/link';
import { ThemeToggle } from '~/components/theme-toggle';
import { Wordmark } from '~/components/wordmark';
import type { Viewer } from '~/lib/api';
import { signOut } from '~/lib/auth-actions';

/**
 * The views a role can open. Readers get the digest archive and reports only (DECISIONS.md D51); the server enforces it
 * too. The developer views (overview, tickets, context, previews) join this list as they are built.
 */
export const navFor = (_role: Viewer['role']) => [
  { href: '/digests', label: 'Digests' },
  { href: '/reports', label: 'Reports' },
];

export function AppHeader({ viewer }: { viewer: Viewer | null }) {
  return (
    <header className="border-line bg-bg/95 no-print sticky top-0 z-40 border-b backdrop-blur">
      {/* Under 640px: the wordmark and controls on one row, the nav on its own full-width row below. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:h-14 sm:flex-nowrap sm:px-6">
        <Link href="/digests" aria-label="logs, home" className="flex h-12 shrink-0 items-center text-[15px] sm:h-auto">
          <Wordmark />
        </Link>
        {viewer ? (
          <nav aria-label="Main" className="order-last -mx-2 w-full pb-2 sm:order-none sm:mx-0 sm:w-auto sm:min-w-0 sm:flex-1 sm:pb-0">
            <ul className="flex flex-wrap gap-1 text-sm">
              {navFor(viewer.role).map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-fg-muted hover:text-fg hover:bg-bg-subtle block rounded-md px-2.5 py-1.5">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <span className="hidden sm:block sm:flex-1" />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-3 sm:ml-0">
          {viewer ? (
            <span className="text-fg-subtle hidden font-mono text-xs md:inline">
              {viewer.developerName} · {viewer.role}
            </span>
          ) : null}
          <ThemeToggle />
          {viewer ? (
            <form action={signOut}>
              <button type="submit" className="text-fg-muted hover:text-fg rounded-md px-2 py-1.5 text-sm">
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </header>
  );
}
