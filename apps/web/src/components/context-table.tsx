import type { ContextItem } from '@digest/core';
// The brief module alone: it has no Node imports, so the table can render in the browser too.
import { shortSource } from '@digest/core/brief';
import type { ReactNode } from 'react';
import { StatusPill, toneForItem } from '~/components/status-pill';
import { ITEM_TYPE, TERMS } from '~/lib/terms';

/** A path that may wrap after each slash, never inside a file or folder name. */
const Path = ({ path }: { path: string }) => (
  <span className="block">
    {path.split('/').map((part, i, all) => (
      <span key={i}>
        {part}
        {i < all.length - 1 ? (
          <>
            /<wbr />
          </>
        ) : null}
      </span>
    ))}
  </span>
);

function status(i: ContextItem) {
  if (i.status === 'superseded') return `${TERMS.superseded} by ${i.supersededBy}`;
  // retiredBy 'retraction': every summary it came from was withdrawn (D80).
  if (i.status === 'retired') return i.retiredBy === 'retraction' ? `${TERMS.retired}: its summary was withdrawn` : `${TERMS.retired} by ${i.retiredBy}`;
  return TERMS.active;
}

/** Context items with their type colour, reason, paths, sources, date and status, and an optional action per row. Rows stack on narrow screens. */
export function ContextTable({ items, empty = 'No items yet.', action }: { items: ContextItem[]; empty?: string; action?: (item: ContextItem) => ReactNode }) {
  if (!items.length) {
    return <p className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-6 text-sm">{empty}</p>;
  }
  return (
    <table className="data-table context-table w-full text-sm">
      <caption className="sr-only">Context items</caption>
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Note</th>
          <th scope="col">Paths</th>
          <th scope="col">Sources</th>
          <th scope="col">Date</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} id={i.id}>
            <td data-label="Type">
              <StatusPill tone={toneForItem(i.type)}>{ITEM_TYPE[i.type]}</StatusPill>
            </td>
            <td data-label="Note" className="max-w-xl">
              <p className="text-pretty">{i.text}</p>
              <p className="text-fg-muted mt-0.5 text-pretty">{i.reason}</p>
              <p className="text-fg-subtle mt-1 font-mono text-[11px]">{i.id}</p>
            </td>
            <td data-label="Paths" className="text-fg-muted font-mono text-xs">
              {i.paths.slice(0, 3).map((p) => (
                <Path key={p} path={p} />
              ))}
              {i.paths.length > 3 ? <span className="text-fg-subtle block">+{i.paths.length - 3} more</span> : null}
            </td>
            <td data-label="Sources" className="text-fg-muted font-mono text-xs">
              {i.sources.map((s) => (
                <span key={s} className="block">
                  {shortSource([s])}
                </span>
              ))}
            </td>
            <td data-label="Date" className="text-fg-muted font-mono text-xs">
              <span className="whitespace-nowrap">{i.date}</span>
            </td>
            <td data-label="Status" className="text-fg-muted text-xs">
              <span className="block">{status(i)}</span>
              {action?.(i)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
