import { contextBrief } from '@digest/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ContextBriefPanel } from '~/components/context-brief';
import { ContextItems } from '~/components/context-items';
import { SectionHeader } from '~/components/section-header';
import { api, developerOnly } from '~/lib/api';
import { SERVER_CLI } from '~/lib/brand';
import { retireItem } from '~/lib/context-actions';
import { TERMS } from '~/lib/terms';

export const metadata: Metadata = { title: 'Context' };

// What each state means, so an empty tab says why it is empty rather than looking broken.
const TABS = [
  { status: 'active', label: TERMS.active, empty: ['No active items yet.', `Items appear once approved summaries are distilled on the server (${SERVER_CLI} context distill).`] },
  { status: 'superseded', label: TERMS.superseded, empty: ['Nothing has been superseded yet.', 'An item is superseded when a newer decision on the same topic replaces it. The older one is kept here, with a link to what replaced it.'] },
  { status: 'retired', label: TERMS.retired, empty: ['Nothing has been retired yet.', 'An item is retired when a developer marks it wrong, or when every summary it came from is withdrawn. It never comes back on its own.'] },
] as const;

export default async function ContextPage({ searchParams }: { searchParams: Promise<{ path?: string; status?: string }> }) {
  const me = await developerOnly();
  const search = await searchParams;
  const path = (search.path ?? '').trim();
  const tab = TABS.find((t) => t.status === search.status) ?? TABS[0];
  const items = await api.contextItems(me.repoId);
  // The same deterministic selection the CLI runs (D78, D88): no model call.
  const brief = contextBrief(items, path || undefined);
  const shown = items.filter((i) => i.status === tab.status);
  const href = (status: string) => `/context?${new URLSearchParams({ ...(path ? { path } : {}), status })}`;
  return (
    <>
      <SectionHeader index="04" label="Context" title="Team context" line="The decisions, conventions and pitfalls distilled from approved summaries, and the brief an agent gets for a path." />

      <section aria-labelledby="brief-heading" className="mt-8 max-w-4xl">
        <h2 id="brief-heading" className="sr-only">
          The brief for a path
        </h2>
        <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="path" className="text-fg-subtle block font-mono text-xs uppercase">
              Path or ticket
            </label>
            <input id="path" name="path" defaultValue={path} placeholder="e.g. packages/core/src/summarize or LOGS-3" className="border-line-strong bg-bg-elev mt-1 w-full rounded-md border px-3 py-1.5 font-mono text-sm" />
          </div>
          <input type="hidden" name="status" value={tab.status} />
          <button type="submit" className="border-line-strong hover:bg-bg-subtle rounded-md border px-3 py-1.5 text-sm">
            Show the brief
          </button>
        </form>
        <ContextBriefPanel path={path} brief={brief} />
      </section>

      <section aria-labelledby="items-heading" className="mt-10">
        <h2 id="items-heading" className="text-lg font-semibold">
          Items
        </h2>
        <nav aria-label="Item status" className="mt-3">
          <ul className="border-line flex gap-1 border-b text-sm">
            {TABS.map((t) => {
              const n = items.filter((i) => i.status === t.status).length;
              const current = t.status === tab.status;
              return (
                <li key={t.status}>
                  <Link
                    href={href(t.status)}
                    aria-current={current ? 'page' : undefined}
                    className={`-mb-px block border-b-2 px-3 py-2 ${current ? 'border-fg text-fg' : 'text-fg-muted hover:text-fg border-transparent'}`}
                  >
                    {t.label} <span className="text-fg-subtle font-mono text-xs">{n}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="mt-4">
          <ContextItems
            key={tab.status}
            items={shown}
            retire={tab.status === 'active' ? retireItem : undefined}
            empty={
              <>
                <p className="text-fg font-medium">{tab.empty[0]}</p>
                <p className="mt-1">{tab.empty[1]}</p>
              </>
            }
          />
        </div>
      </section>
    </>
  );
}
