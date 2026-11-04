import type { ReactNode } from 'react';
import { StatusPill } from '~/components/status-pill';

// The stakeholder digest, read as a memo: set in Newsreader, the one place the serif appears (docs/dashboard-design.md).
// The server renders digests to a small, fixed Markdown shape (DECISIONS.md D50), so this parses that shape into
// React elements. Text is never treated as HTML, whatever it contains.

type Block = { kind: 'p'; text: string } | { kind: 'em'; text: string } | { kind: 'ul'; items: string[] };
export type DigestSection = { heading: string | null; blocks: Block[] };
export type ParsedDigest = { title: string; corrected: boolean; correction: string | null; coverage: string | null; sections: DigestSection[] };

const italic = (text: string) => /^_[^_].*_$/s.exec(text) && text.slice(1, -1);

export function parseDigest(markdown: string): ParsedDigest {
  const chunks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);
  let title = '';
  let correction: string | null = null;
  let coverage: string | null = null;
  const sections: DigestSection[] = [{ heading: null, blocks: [] }];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    if (lines[0]!.startsWith('# ') && !title) {
      title = lines[0]!.slice(2).trim();
      continue;
    }
    if (lines[0]!.startsWith('## ')) {
      sections.push({ heading: lines[0]!.slice(3).trim(), blocks: [] });
      if (lines.length === 1) continue;
      lines.shift();
    }
    const current = sections.at(-1)!;
    if (lines.every((l) => l.startsWith('- '))) {
      current.blocks.push({ kind: 'ul', items: lines.map((l) => l.slice(2).trim()) });
      continue;
    }
    const text = lines.join(' ');
    const em = italic(text);
    if (em && /^This corrects/.test(em)) correction = em;
    else if (em && /^Based on /.test(em)) coverage = em;
    else if (em) current.blocks.push({ kind: 'em', text: em });
    else current.blocks.push({ kind: 'p', text });
  }
  return { title, corrected: /\(corrected\)/i.test(title), correction, coverage, sections: sections.filter((s) => s.heading !== null || s.blocks.length) };
}

/** Bold (`**…**`), italic (`_…_` at word edges) and code spans; everything else is plain text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|(?<![\w])_[^_]+_(?![\w]))/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^_[^_]+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** A ticket heading ("PROJ-201: Account lockout") with the key in mono, as on the showcase site. */
function heading(text: string): ReactNode {
  const match = /^([A-Z][A-Z0-9]{1,9}-\d+(?: · [A-Z][A-Z0-9]{1,9}-\d+)*)(: .*)$/.exec(text);
  if (!match) return text;
  return (
    <>
      <span className="text-accent font-mono text-[0.85em] font-medium">{match[1]}</span>
      {match[2]}
    </>
  );
}

export function DigestDocument({ markdown, caption }: { markdown: string; caption?: ReactNode }) {
  const digest = parseDigest(markdown);
  return (
    <article className="digest border-line bg-bg-elev rounded-lg border">
      {caption ? <div className="border-line text-fg-subtle flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 font-mono text-xs">{caption}</div> : null}
      <div className="text-fg px-5 py-6 font-serif text-[16px] leading-[1.6] sm:px-8 sm:py-8 sm:text-[17px]">
        {digest.corrected ? (
          <p className="mb-3 font-sans">
            <StatusPill tone="attention">Corrected</StatusPill>
          </p>
        ) : null}
        <h2 className="text-[1.4rem] leading-tight font-semibold tracking-tight text-balance sm:text-2xl">{digest.title}</h2>
        {digest.correction ? (
          <p role="note" className="callout-attention mt-4 rounded-md border px-4 py-3 text-[15px] italic">
            {digest.correction}
          </p>
        ) : null}
        {digest.sections.map((section, i) => (
          <section key={i} className={section.heading ? 'mt-7' : 'mt-4'}>
            {section.heading ? <h3 className="text-lg font-semibold">{heading(section.heading)}</h3> : null}
            {section.blocks.map((block, j) =>
              block.kind === 'ul' ? (
                <ul key={j} className="text-fg-muted marker:text-fg-subtle mt-2 list-disc space-y-1.5 pl-5">
                  {block.items.map((item, k) => (
                    <li key={k}>{inline(item)}</li>
                  ))}
                </ul>
              ) : (
                <p key={j} className={`mt-3 ${block.kind === 'em' ? 'italic' : 'text-fg-muted'}`}>
                  {inline(block.text)}
                </p>
              ),
            )}
          </section>
        ))}
        {digest.coverage ? (
          <p data-coverage className="border-line text-fg-subtle mt-7 border-t pt-4 text-[15px] italic">
            {digest.coverage}
          </p>
        ) : null}
      </div>
    </article>
  );
}
