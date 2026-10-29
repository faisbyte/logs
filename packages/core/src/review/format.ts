import type { SessionSummary } from '../summarize/schema.js';
import { SHARED_FIELDS } from './approval.js';

// How a summary is shown for review: plain text under a one-line header saying what gets shared.

const LABELS: Record<(typeof SHARED_FIELDS)[number], string> = {
  goal: 'goal',
  outcome: 'outcome',
  whatWasDone: 'what was done',
  decisions: 'decisions',
  rejectedApproaches: 'rejected approaches',
  risksOrFollowUps: 'risks and follow-ups',
  aiInvolvement: 'AI involvement',
  filesTouched: 'files touched',
  ticketRefs: 'ticket refs',
  branch: 'branch',
  startedAt: 'dates',
  endedAt: 'dates',
};
const labels = [...new Set(SHARED_FIELDS.map((f) => LABELS[f]))];

export const SHARED_HEADER = `Shared with the team once pushed: ${labels.slice(0, -2).join(', ')}, ${labels.at(-2)} and ${labels.at(-1)}. Never shared: the transcript.`;

/** "2026-03-02 09:00" in the given time zone (the machine's by default). */
export function formatTime(iso: string, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function statusText(s: SessionSummary, timeZone?: string): string {
  if (s.status === 'approved') return `approved ${s.approvedBy === 'auto' ? 'automatically' : 'by the developer'} ${formatTime(s.approvedAt!, timeZone)}${s.editedByDeveloper ? ', edited' : ''}`;
  if (s.status === 'rejected') return 'rejected';
  return s.editedByDeveloper ? 'draft, edited by the developer' : 'draft';
}

const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((i) => `  - ${i}`).join('\n')}` : `${title}: none`);
const because = (reason: string) => (reason ? ` (because: ${reason})` : '');

export function formatSummary(s: SessionSummary, { timeZone }: { timeZone?: string } = {}): string {
  const started = formatTime(s.startedAt, timeZone);
  const ended = formatTime(s.endedAt, timeZone);
  const span = started.slice(0, 10) === ended.slice(0, 10) ? `${started} → ${ended.slice(11)}` : `${started} → ${ended}`;
  return [
    SHARED_HEADER,
    '',
    `${s.sessionId.slice(0, 8)}  ${s.agent}  ${s.branch ?? 'no branch'}  ${span}  ${statusText(s, timeZone)}`,
    '',
    `Goal: ${s.goal}`,
    `Outcome: ${s.outcome}  ·  AI involvement: ${s.aiInvolvement}`,
    `What was done:\n  ${s.whatWasDone}`,
    list('Decisions', s.decisions.map((d) => `${d.decision}${because(d.reason)}`)),
    list('Rejected approaches', s.rejectedApproaches.map((r) => `${r.approach}${because(r.reason)}`)),
    list('Risks and follow-ups', s.risksOrFollowUps),
    `Files touched (${s.filesTouched.length}): ${s.filesTouched.join(', ') || 'none'}`,
    `Ticket refs: ${s.ticketRefs.join(', ') || 'none'}`,
  ].join('\n');
}
