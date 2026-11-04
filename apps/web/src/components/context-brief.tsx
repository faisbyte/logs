import { TerminalPanel } from '~/components/terminal-panel';
import { command } from '~/lib/brand';

const LINE = /^- (Pitfall|Decision|Convention), (\S+) \(([^)]+)\): (.*?)(?: Why: (.*))?$/;

/**
 * The brief an agent would get from `context <path>`, in a terminal panel that stays dark in both themes. Each note's
 * type is coloured with the terminal's own amber, blue and violet, matching the accents' meanings.
 */
export function ContextBriefPanel({ path, brief }: { path: string; brief: string }) {
  const lines = brief.replace(/\n+$/, '').split('\n');
  return (
    <TerminalPanel title={path ? command('context', path) : command('context')}>
      <p className="text-term-muted">
        <span aria-hidden="true">$ </span>
        {path ? command('context', path) : command('context')}
      </p>
      <div className="mt-2 space-y-1.5">
        {lines.map((line, i) => {
          const m = LINE.exec(line);
          if (!m) return line ? <p key={i} className={i === 0 ? 'text-term-muted' : ''}>{line}</p> : <br key={i} />;
          const [, kind, date, source, text, why] = m;
          return (
            <p key={i} className="pl-[2ch] -indent-[2ch]">
              <span className="text-term-muted">- </span>
              <span className="term-kind" data-kind={kind!.toLowerCase()}>
                {kind}
              </span>
              <span className="text-term-muted">
                , {date} ({source}):
              </span>{' '}
              {text}
              {why ? (
                <>
                  {' '}
                  <span className="text-term-muted">Why:</span> {why}
                </>
              ) : null}
            </p>
          );
        })}
      </div>
    </TerminalPanel>
  );
}
