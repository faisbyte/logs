import { PRODUCT } from '~/lib/brand';

/** The wordmark, as on the showcase site: a prompt glyph and the name in mono. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 font-mono font-medium ${className ?? ''}`}>
      <span aria-hidden="true" className="text-accent">
        &gt;_
      </span>
      <span>{PRODUCT}</span>
    </span>
  );
}
