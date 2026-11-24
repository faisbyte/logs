'use client';

import type { CostFlag, CostSession } from '@digest/core';
import { useState } from 'react';
import { StatusPill } from '~/components/status-pill';
import type { CostActionState } from '~/lib/cost-actions';
import { AGENT, commitUrl, PLACE, usd } from '~/lib/cost-format';

type Target = { agent: string; sessionId: string; developerId: string; note: string };
export type CostActions = {
  flag: (target: Target) => Promise<CostActionState>;
  reply: (id: string, text: string) => Promise<CostActionState>;
  settle: (id: string) => Promise<CostActionState>;
};

const button = 'border-line-strong text-fg hover:bg-bg-subtle rounded-md border px-2.5 py-1 disabled:opacity-60';

/** Runs one action at a time and keeps the server's refusal. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<CostActionState>) => {
    setPending(true);
    const result = await action();
    setPending(false);
    setError(result.status === 'error' ? result.message : null);
    return result.status === 'ok';
  };
  return { pending, error, run };
}

function NoteForm({ id, label, pending, onSend, onCancel }: { id: string; label: string; pending: boolean; onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(text);
      }}
    >
      <label htmlFor={id} className="text-fg-muted block text-xs">
        {label}
      </label>
      <textarea id={id} rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} className="border-line-strong bg-bg-elev mt-1 w-full rounded-md border px-2 py-1 text-sm" />
      <div className="mt-1 flex gap-2">
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const whose = (s: CostSession) => `${s.developerName}, ${s.date}, session ${s.sessionId.slice(0, 8)}`;

function Flag({ flag, session, actions }: { flag: CostFlag; session: CostSession; actions: CostActions }) {
  const [replying, setReplying] = useState(false);
  const { pending, error, run } = useAction();
  return (
    <div className="mb-2">
      {flag.resolvedAt ? <p className="text-fg-subtle text-xs">{`Resolved by ${flag.resolvedBy}`}</p> : <StatusPill tone="attention">To discuss</StatusPill>}
      <ul className="mt-1 space-y-1">
        {flag.notes.map((n, i) => (
          <li key={i} className="text-sm">
            <span className="text-fg-subtle text-xs">{n.name}</span>
            <p className="break-words">{n.text}</p>
          </li>
        ))}
      </ul>
      {flag.resolvedAt ? null : replying ? (
        <NoteForm
          id={`reply-${session.date}-${flag.id}`}
          label="Your reply"
          pending={pending}
          onCancel={() => setReplying(false)}
          onSend={(text) => void run(() => actions.reply(flag.id, text)).then((ok) => ok && setReplying(false))}
        />
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" aria-label={`Reply: ${whose(session)}`} onClick={() => setReplying(true)} className={button}>
            Reply
          </button>
          <button type="button" aria-label={`Mark resolved: ${whose(session)}`} disabled={pending} onClick={() => void run(() => actions.settle(flag.id))} className={button}>
            Mark resolved
          </button>
        </div>
      )}
      {error ? <p role="alert" className="text-amber mt-1 text-sm">{error}</p> : null}
    </div>
  );
}

function Discuss({ session, canFlag, actions }: { session: CostSession; canFlag: boolean; actions: CostActions }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run } = useAction();
  const { agent, sessionId, developerId } = session;
  const key = `${agent}-${sessionId}-${session.date}-${session.place}`;
  return (
    <div>
      {session.flags.map((f) => (
        <Flag key={f.id} flag={f} session={session} actions={actions} />
      ))}
      {!canFlag || session.flags.some((f) => !f.resolvedAt) ? null : open ? (
        <NoteForm
          id={`note-${key}`}
          label={`Note for ${session.developerName} (optional)`}
          pending={pending}
          onCancel={() => setOpen(false)}
          onSend={(note) => void run(() => actions.flag({ agent, sessionId, developerId, note })).then((ok) => ok && setOpen(false))}
        />
      ) : (
        <button type="button" aria-label={`Flag to discuss: ${whose(session)}`} onClick={() => setOpen(true)} className={button}>
          Flag to discuss
        </button>
      )}
      {error ? <p role="alert" className="text-amber mt-1 text-sm">{error}</p> : null}
    </div>
  );
}

/** One row per session and day. A manager can flag one to discuss; the developer sees the same row and can answer. */
export function CostSessions({ sessions, scope, ...actions }: { sessions: CostSession[]; scope: 'all' | 'own' } & CostActions) {
  if (!sessions.length) return <div className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-6 text-sm">No sessions recorded for this period.</div>;
  return (
    <table className="data-table w-full text-sm">
      <caption className="sr-only">Sessions by day, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          {scope === 'all' ? <th scope="col">Developer</th> : null}
          <th scope="col">Session</th>
          <th scope="col">Estimated</th>
          <th scope="col">Where</th>
          <th scope="col">Commits</th>
          <th scope="col">Discuss</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={`${s.agent} ${s.sessionId} ${s.developerId} ${s.date} ${s.place} ${s.repoId}`}>
            <td data-label="Day" className="font-mono text-xs whitespace-nowrap">
              <span>
                {s.date}
                <span className="text-fg-subtle block">{`${s.startedAt.slice(11, 16)} to ${s.endedAt.slice(11, 16)} UTC`}</span>
              </span>
            </td>
            {scope === 'all' ? <td data-label="Developer">{s.developerName}</td> : null}
            <td data-label="Session">
              <span>
                <span className="font-mono text-xs">{s.sessionId.slice(0, 8)}</span>
                <span className="text-fg-subtle block text-xs">{`${AGENT[s.agent]} · ${s.models.join(', ')}`}</span>
                {s.tickets.length ? <span className="text-fg-muted block font-mono text-xs">{s.tickets.join(' ')}</span> : null}
              </span>
            </td>
            <td data-label="Estimated" className="tabular-nums">{usd(s.micros)}</td>
            <td data-label="Where">
              <StatusPill tone="neutral">{PLACE[s.place]}</StatusPill>
            </td>
            <td data-label="Commits" className="font-mono text-xs">
              <span>
                {s.commits.length
                  ? s.commits.map((c) => {
                      const url = commitUrl(c.repoId, c.sha);
                      const short = c.sha.slice(0, 7);
                      return url ? (
                        <a key={c.sha} href={url} rel="noreferrer" aria-label={`Commit ${short}`} className="mr-2 underline underline-offset-4">
                          {short}
                        </a>
                      ) : (
                        <span key={c.sha} className="mr-2">
                          {short}
                        </span>
                      );
                    })
                  : 'No commit'}
              </span>
            </td>
            <td data-label="Discuss">
              <Discuss session={s} canFlag={scope === 'all'} actions={actions} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
