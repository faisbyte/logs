import '~/styles/globals.css';

import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppHeader } from '~/components/app-header';
import { themeScript } from '~/components/theme-script';
import { viewer } from '~/lib/api';
import { PRODUCT } from '~/lib/brand';

export const metadata: Metadata = {
  title: { default: PRODUCT, template: `%s · ${PRODUCT}` },
  description: 'Sprint digests and team context from AI coding sessions.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0b0a' },
    { media: '(prefers-color-scheme: light)', color: '#fafaf7' },
  ],
};

// The three type voices (docs/dashboard-design.md), self-hosted by next/font at build time.
const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
const newsreader = Newsreader({ subsets: ['latin'], variable: '--font-newsreader', style: ['normal', 'italic'] });

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await viewer().catch(() => null);
  return (
    // Readers follow their system theme by default; developers start dark. A stored choice wins for anyone.
    <html
      lang="en"
      data-theme="dark"
      data-default-theme={me?.role === 'reader' ? 'system' : 'dark'}
      className={`${geist.variable} ${geistMono.variable} ${newsreader.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <a href="#main" className="bg-fg text-bg no-print sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
          Skip to content
        </a>
        <AppHeader viewer={me} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-8 outline-none sm:px-6 sm:py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
