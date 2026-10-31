import { createHash } from 'node:crypto';
import type { StoredSummary } from '../shared/store.js';
import type { ContextItem } from './item.js';

// What a context extraction reads (DECISIONS.md D76): approved summaries the shared store already validated, and
// the repo's existing items. Built only by contextInput(), so an LLM client can check where a request came from,
// as it does for redacted sessions and digest inputs (D16, D49).

/** One summary as the model sees it, labelled S1, S2… oldest first. */
export interface ContextSource {
  label: string;
  /** "agent/sessionId". */
  key: string;
  from: string;
  to: string;
  tickets: string[];
  files: string[];
  goal: string;
  whatWasDone: string;
  decisions: { decision: string; reason: string }[];
  rejectedApproaches: { approach: string; reason: string }[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class ContextInput {
  readonly #brand = true;
  readonly repoId: string | null;
  readonly sources: readonly ContextSource[];
  /** Every existing item, any status: the model sees the active ones, the rest only guard against coming back. */
  readonly existing: readonly ContextItem[];
  readonly hash: string;

  constructor(fields: Omit<ContextInput, 'hash' | typeof Symbol.toStringTag>) {
    this.repoId = fields.repoId;
    this.sources = fields.sources;
    this.existing = fields.existing;
    this.hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    deepFreeze(this);
  }

  static isInstance(value: unknown): value is ContextInput {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}
export type { ContextInput };

export const isContextInput = (value: unknown): value is ContextInput => ContextInput.isInstance(value);

const day = (iso: string) => iso.slice(0, 10);

/** The input for one extraction: the summaries oldest first, and the repo's existing items. */
export function contextInput(summaries: readonly StoredSummary[], existing: readonly ContextItem[] = []): ContextInput {
  const sorted = [...summaries].sort((a, b) => a.summary.startedAt.localeCompare(b.summary.startedAt) || a.summary.sessionId.localeCompare(b.summary.sessionId));
  const sources = sorted.map(({ summary: s }, i): ContextSource => ({
    label: `S${i + 1}`,
    key: `${s.agent}/${s.sessionId}`,
    from: day(s.startedAt),
    to: day(s.endedAt),
    tickets: [...s.ticketRefs],
    files: [...s.filesTouched],
    goal: s.goal,
    whatWasDone: s.whatWasDone,
    decisions: s.decisions.map(({ decision, reason }) => ({ decision, reason })),
    rejectedApproaches: s.rejectedApproaches.map(({ approach, reason }) => ({ approach, reason })),
  }));
  return new ContextInput({ repoId: summaries[0]?.repoId ?? existing[0]?.repoId ?? null, sources, existing: existing.map((i) => structuredClone(i)) });
}
