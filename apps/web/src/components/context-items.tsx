'use client';

import type { ContextItem, ContextItemType } from '@digest/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ContextTable } from '~/components/context-table';
import type { RetireState } from '~/lib/context-actions';
import { ITEM_TYPE } from '~/lib/terms';

const TYPES = Object.keys(ITEM_TYPE) as ContextItemType[];
const chipClass = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${on ? 'border-fg bg-bg-subtle text-fg' : 'border-line-strong text-fg-muted hover:text-fg'}`;

const matches = (i: ContextItem, q: string) => [i.text, i.reason, i.id, ...i.paths, ...i.tickets].some((t) => t.toLowerCase().includes(q));

/**
 * One status tab's items, with type chips and a text search over them (both in the browser: a tab holds every item in that
 * state). With `retire`, each row can be retired after a confirmation; the server decides whether the viewer may.
 */
export function ContextItems({ items, empty, retire }: { items: ContextItem[]; empty: ReactNode; retire?: (id: string) => Promise<RetireState> }) {
  const [types, setTypes] = useState<ContextItemType[]>([]);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RetireState | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (returnTo) buttons.current.get(returnTo)?.focus();
  }, [returnTo]);

  if (!items.length) return <div className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-6 text-sm">{empty}</div>;

  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => (!types.length || types.includes(i.type)) && (!q || matches(i, q)));
  const toggle = (t: ContextItemType) => setTypes((on) => (on.includes(t) ? on.filter((x) => x !== t) : [...on, t]));
  const close = (id: string) => {
    setConfirming(null);
    setReturnTo(id);
  };
  const confirm = async (id: string) => {
    setPending(true);
    const outcome = await retire!(id);
    setPending(false);
    setConfirming(null);
    setResult(outcome);
  };

  const action = retire
    ? (i: ContextItem) =>
        confirming === i.id ? (
          <div
            role="group"
            aria-label={`Retire ${i.id}?`}
            className="mt-2"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close(i.id);
            }}
          >
            <p className="text-fg">For everyone on this repo. It won’t come back on its own.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={pending} onClick={() => confirm(i.id)} className="bg-fg text-bg rounded-md px-2.5 py-1 font-medium disabled:opacity-60">
                {pending ? 'Retiring…' : 'Retire item'}
              </button>
              <button type="button" ref={cancel} onClick={() => close(i.id)} className="border-line-strong hover:bg-bg-subtle rounded-md border px-2.5 py-1">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            ref={(el) => {
              if (el) buttons.current.set(i.id, el);
              else buttons.current.delete(i.id);
            }}
            aria-label={`Retire ${i.id}`}
            onClick={() => {
              setResult(null);
              setReturnTo(null);
              setConfirming(i.id);
            }}
            className="border-line-strong text-fg hover:bg-bg-subtle mt-2 block rounded-md border px-2.5 py-1"
          >
            Retire
          </button>
        )
    : undefined;

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-1.5">
          {TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={types.includes(t)} onClick={() => toggle(t)} className={chipClass(types.includes(t))}>
              {ITEM_TYPE[t]} <span className="text-fg-subtle font-mono text-xs">{items.filter((i) => i.type === t).length}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <label htmlFor="item-search" className="sr-only">
            Search items
          </label>
          <input
            id="item-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search text, paths, tickets"
            className="border-line-strong bg-bg-elev w-full rounded-md border px-3 py-1.5 text-sm"
          />
        </div>
      </div>
      <div role="status" className="text-fg-subtle mt-3 font-mono text-xs">
        <p>
          Showing {shown.length} of {items.length} items
        </p>
        {result && result.status !== 'error' ? (
          <p className="text-fg mt-1 font-sans text-sm">{result.status === 'retired' ? `Retired ${result.id}. It won’t come back on its own.` : `${result.id} was already retired.`}</p>
        ) : null}
      </div>
      {result?.status === 'error' ? (
        <p role="alert" className="text-amber mt-2 text-sm">{result.message}</p>
      ) : null}
      <div className="mt-3">
        {shown.length ? (
          <ContextTable items={shown} action={action} />
        ) : (
          <div className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-6 text-sm">
            <p>No items match these filters.</p>
            <button
              type="button"
              onClick={() => {
                setTypes([]);
                setQuery('');
              }}
              className="text-fg mt-2 underline underline-offset-4"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </>
  );
}
