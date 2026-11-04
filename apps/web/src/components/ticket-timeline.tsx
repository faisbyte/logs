import type { StoredSummary } from '@digest/core';
import type { ReactNode } from 'react';
import { StatusPill } from '~/components/status-pill';

const OUTCOME = { completed: 'Completed', partial: 'Partial', abandoned: 'Abandoned' } as const;
const day = (iso: string) => iso.slice(0, 10);

/** A list's label, with the digest's small marker: blue for decisions, amber for what was tried and dropped. */
function Label({ marker, children }: { marker?: 'decision' | 'attention'; children: ReactNode }) {
  return (
    <p data-marker={marker} className="mt-4 text-sm font-semibold">
      {marker ? <span className="marker" data-marker={marker} aria-hidden="true" /> : null}
      {children}
    </p>
  );
}

function Entry({ s: stored }: { s: StoredSummary }) {
  const s = stored.summary;
  const when = day(s.startedAt) === day(s.endedAt) ? day(s.startedAt) : `${day(s.startedAt)} to ${day(s.endedAt)}`;
  return (
    <li aria-label={`${when}, ${stored.developerName}`} className="relative pb-8 pl-6 last:pb-0">
      <span aria-hidden="true" className="bg-line-strong absolute top-1.5 left-0 size-2 rounded-full" />
      <div className="text-fg-subtle flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs">
        <span>{when}</span>
        <span className="text-fg-muted font-sans text-sm">{stored.developerName}</span>
        <StatusPill tone="safe">Approved</StatusPill>
        <StatusPill tone="neutral">{OUTCOME[s.outcome]}</StatusPill>
        <span>AI involvement: {s.aiInvolvement}</span>
      </div>
      <h3 className="mt-2 font-semibold text-pretty">{s.goal}</h3>
      <p className="text-fg-muted mt-1 text-sm leading-relaxed text-pretty">{s.whatWasDone}</p>
      {s.decisions.length ? (
        <>
          <Label marker="decision">Decisions</Label>
          <ul className="marker:text-fg-subtle mt-1 list-disc space-y-1 pl-5 text-sm">
            {s.decisions.map((d, i) => (
              <li key={i}>
                {d.decision} <span className="text-fg-muted">{d.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {s.rejectedApproaches.length ? (
        <>
          <Label marker="attention">Tried and dropped</Label>
          <ul className="marker:text-fg-subtle mt-1 list-disc space-y-1 pl-5 text-sm">
            {s.rejectedApproaches.map((r, i) => (
              <li key={i}>
                {r.approach} <span className="text-fg-muted">{r.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {s.risksOrFollowUps.length ? (
        <>
          <Label>Follow-ups</Label>
          <ul className="marker:text-fg-subtle text-fg-muted mt-1 list-disc space-y-1 pl-5 text-sm">
            {s.risksOrFollowUps.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </>
      ) : null}
      {s.filesTouched.length ? (
        <details className="mt-4 text-sm">
          <summary className="text-fg-subtle hover:text-fg cursor-pointer font-mono text-xs">
            {s.filesTouched.length} {s.filesTouched.length === 1 ? 'file' : 'files'} · {s.branch}
          </summary>
          <ul className="text-fg-muted mt-2 space-y-0.5 font-mono text-xs break-all">
            {s.filesTouched.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** Every approved summary for a ticket, oldest first, on a hairline rail. */
export function TicketTimeline({ summaries }: { summaries: StoredSummary[] }) {
  const sorted = [...summaries].sort((a, b) => a.summary.startedAt.localeCompare(b.summary.startedAt));
  return (
    <ol aria-label="Summaries, oldest first" className="border-line ml-1 border-l pl-0">
      {sorted.map((s) => (
        <Entry key={`${s.summary.agent}/${s.summary.sessionId}`} s={s} />
      ))}
    </ol>
  );
}
