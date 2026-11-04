import type { ReactNode } from 'react';

/** Terminal chrome on the terminal palette, which stays dark in both themes, like a real terminal. */
export function TerminalPanel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`terminal overflow-hidden rounded-lg border ${className ?? ''}`}>
      <div className="terminal-bar flex h-9 items-center gap-3 border-b px-3">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="terminal-dot" />
          <span className="terminal-dot" />
          <span className="terminal-dot" />
        </span>
        <span className="terminal-title min-w-0 flex-1 truncate font-mono text-xs">{title}</span>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">{children}</div>
    </section>
  );
}
