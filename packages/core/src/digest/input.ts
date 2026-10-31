import { createHash } from 'node:crypto';
import { isRedactedSession } from '../redact/session.js';
import type { UploadPayload } from '../shared/payload.js';
import type { StoredSummary } from '../shared/store.js';
import type { TicketReport } from '../shared/ticket-report.js';

// What a digest is written from (DECISIONS.md D49). The only way to get a DigestInput is digestInput(), from a
// ticket report of pushed summaries, which the server validated on push. It keeps the shared narrative and
// leaves out who did the work, session ids and file paths: a digest never judges individual developers.

type Involvement = UploadPayload['aiInvolvement'];

export interface DigestWork {
  /** Days the work ran (UTC), so the model can tell earlier from later (D65). */
  from: string;
  to: string;
  /** The tickets it is linked to; empty when none. */
  tickets: string[];
  goal: string;
  outcome: UploadPayload['outcome'];
  whatWasDone: string;
  decisions: { decision: string; reason: string }[];
  rejectedApproaches: { approach: string; reason: string }[];
  risksOrFollowUps: string[];
  aiInvolvement: Involvement;
}

export interface DigestTicket {
  key: string;
  title: string | null;
  /** The most common AI involvement of the ticket's work; the higher one on a tie. */
  aiInvolvement: Involvement;
  work: DigestWork[];
}

export interface DigestPeriod {
  /** For people: "Sprint 1 (2026-03-02 to 2026-03-15)" or "2026-03-01 to 2026-03-31". */
  label: string;
  from: string | null;
  to: string | null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class DigestInput {
  readonly #brand = true;
  readonly period: DigestPeriod;
  readonly coverage: { summaryCount: number; developerCount: number };
  readonly tickets: readonly DigestTicket[];
  readonly unlinked: readonly DigestWork[];
  /** Every piece of work once, oldest first: what the model reads (D65). */
  readonly timeline: readonly DigestWork[];
  /** sha256 of everything above: the summary-set part of a digest's cache key. */
  readonly hash: string;

  constructor(fields: Omit<DigestInput, 'hash' | typeof Symbol.toStringTag>) {
    this.period = fields.period;
    this.coverage = fields.coverage;
    this.tickets = fields.tickets;
    this.unlinked = fields.unlinked;
    this.timeline = fields.timeline;
    this.hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    deepFreeze(this);
  }

  static isInstance(value: unknown): value is DigestInput {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}
export type { DigestInput };

export const isDigestInput = (value: unknown): value is DigestInput => DigestInput.isInstance(value);

/** Hard check for LLM requests made from a digest. */
export function assertDigestSource(value: unknown): asserts value is DigestInput {
  if (!isDigestInput(value)) throw new Error('Refusing to send digest data that did not come from digestInput().');
}

/** What an LLM request may carry: a redacted session (summaries) or a digest input (digests). */
export function assertLlmSource(value: unknown): void {
  if (!isRedactedSession(value) && !isDigestInput(value)) {
    throw new Error('Refusing to send unredacted session data: expected a RedactedSession from redactSession() or a DigestInput from digestInput().');
  }
}

const work = ({ summary: s }: StoredSummary, tickets: string[]): DigestWork => ({
  from: s.startedAt.slice(0, 10),
  to: s.endedAt.slice(0, 10),
  tickets,
  goal: s.goal,
  outcome: s.outcome,
  whatWasDone: s.whatWasDone,
  decisions: s.decisions.map(({ decision, reason }) => ({ decision, reason })),
  rejectedApproaches: s.rejectedApproaches.map(({ approach, reason }) => ({ approach, reason })),
  risksOrFollowUps: [...s.risksOrFollowUps],
  aiInvolvement: s.aiInvolvement,
});

const LEVELS: Involvement[] = ['light', 'moderate', 'heavy'];
function mostCommon(levels: Involvement[]): Involvement {
  const count = (l: Involvement) => levels.filter((x) => x === l).length;
  return [...LEVELS].reverse().reduce((best, l) => (count(l) > count(best) ? l : best), 'heavy');
}

const day = (iso: string) => iso.slice(0, 10);
const lastDay = (to: string) => (to.endsWith('T00:00:00.000Z') ? day(new Date(Date.parse(to) - 1).toISOString()) : day(to));
const range = (from: string, to: string) => `${day(from)} to ${lastDay(to)}`;

function period(report: TicketReport): DigestPeriod {
  if ('sprint' in report.filter) {
    const name = report.filter.sprint;
    const sprint = report.sprints.find((g) => g.sprint?.name === name)?.sprint;
    return sprint?.from && sprint.to ? { label: `${name} (${range(sprint.from, sprint.to)})`, from: sprint.from, to: sprint.to } : { label: name, from: null, to: null };
  }
  return { label: range(report.filter.from, report.filter.to), from: report.filter.from, to: report.filter.to };
}

const id = (s: StoredSummary) => `${s.summary.agent}/${s.summary.sessionId}`;
const byKey = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const byStart = (a: StoredSummary, b: StoredSummary) => a.summary.startedAt.localeCompare(b.summary.startedAt) || id(a).localeCompare(id(b));

export function digestInput(report: TicketReport): DigestInput {
  const tickets = new Map<string, { title: string | null; summaries: Map<string, StoredSummary> }>();
  const unlinked = new Map<string, StoredSummary>();
  for (const group of report.sprints) {
    for (const t of group.tickets) {
      const entry = tickets.get(t.key) ?? tickets.set(t.key, { title: t.title, summaries: new Map() }).get(t.key)!;
      for (const { summary } of t.summaries) entry.summaries.set(id(summary), summary);
    }
    for (const s of group.unlinked) unlinked.set(id(s), s);
  }
  const keys = [...tickets.keys()].sort(byKey);
  const all = new Map<string, StoredSummary>([...unlinked, ...[...tickets.values()].flatMap((t) => [...t.summaries])]);
  // One DigestWork per summary, shared by the timeline and its tickets.
  const items = new Map([...all].map(([id_, s]) => [id_, work(s, keys.filter((k) => tickets.get(k)!.summaries.has(id_)))]));
  return new DigestInput({
    period: period(report),
    coverage: { summaryCount: report.summaryCount, developerCount: report.developerCount },
    tickets: keys.map((key) => {
      const summaries = [...tickets.get(key)!.summaries.values()].sort(byStart);
      return { key, title: tickets.get(key)!.title, aiInvolvement: mostCommon(summaries.map((s) => s.summary.aiInvolvement)), work: summaries.map((s) => items.get(id(s))!) };
    }),
    unlinked: [...unlinked.values()].sort(byStart).map((s) => items.get(id(s))!),
    timeline: [...all.values()].sort(byStart).map((s) => items.get(id(s))!),
  });
}
