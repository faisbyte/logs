// What a developer sees on a digest that readers don't: that it is still in preview (D54), and the terms the jargon check
// flagged and kept after its one retry (D68, D71).

export const sendTime = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** The flagged terms from a digest's kept warnings ("jargon: <term>"). */
export const flaggedTerms = (warnings: readonly string[] = []) => warnings.filter((w) => w.startsWith('jargon: ')).map((w) => w.slice('jargon: '.length));

export function JargonCallout({ warnings }: { warnings: readonly string[] }) {
  const terms = flaggedTerms(warnings);
  if (!terms.length) return null;
  const title = `${terms.length} ${terms.length === 1 ? 'term' : 'terms'} a stakeholder may not know`;
  return (
    <section role="note" aria-labelledby="jargon-heading" className="callout-attention no-print rounded-md border px-4 py-3 text-sm">
      <h2 id="jargon-heading" className="font-semibold">
        {title}
      </h2>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {terms.map((t) => (
          <li key={t} className="border-line-strong bg-bg rounded border px-1.5 py-0.5 font-mono text-xs">
            {t}
          </li>
        ))}
      </ul>
      <p className="text-fg-muted mt-2">The writer was asked once to explain or avoid them, and they were still there, so the digest was kept.</p>
    </section>
  );
}

export function PreviewBanner({ previewUntil }: { previewUntil: string | null }) {
  return (
    <p role="note" className="border-line-strong bg-bg-elev no-print rounded-md border px-4 py-3 text-sm">
      In preview: readers don’t see this yet. {previewUntil ? `It sends after ${sendTime(previewUntil)}.` : 'It sends once the preview ends.'}
    </p>
  );
}
