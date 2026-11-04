import type { ReactNode } from 'react';

type Props = {
  index: string;
  label: string;
  title: string;
  line?: ReactNode;
  /** 1 for a page's opening, 2 for a section inside a page. */
  level?: 1 | 2;
  id?: string;
};

/** A section opening, as on the showcase site: a mono label (`02 / TICKETS`), a plain heading, one short line. */
export function SectionHeader({ index, label, title, line, level = 1, id }: Props) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header className="max-w-3xl">
      <p className="text-fg-subtle font-mono text-xs tracking-wide uppercase">
        <span className="text-fg-muted">{index}</span>
        <span aria-hidden="true"> / </span>
        <span className="sr-only">: </span>
        {label}
      </p>
      <Heading id={id} className={`mt-2 font-semibold tracking-tight text-balance ${level === 1 ? 'text-2xl sm:text-3xl' : 'text-xl'}`}>
        {title}
      </Heading>
      {line ? <p className="text-fg-muted mt-2 text-sm text-pretty sm:text-base">{line}</p> : null}
    </header>
  );
}
