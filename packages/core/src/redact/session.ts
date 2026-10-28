import { AgentSchema, ToolStatusSchema, type ParsedSession } from '../schema.js';
import { createRedactor, type RedactedText } from './text.js';
import type { RedactionCounts, RedactOptions } from './types.js';

// The only way to get a RedactedSession is redactSession() (DECISIONS.md D16). Anything that sends
// session content off the machine (LLM calls, uploads) must take a RedactedSession, never a ParsedSession.

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(['user', 'assistant', 'reasoning', 'tool', 'interruption']);

// Fields whose schema pins them to an enum or timestamp; left as-is only while they hold that format.
const STRUCTURAL: Record<string, (value: string) => boolean> = {
  agent: (v) => AgentSchema.safeParse(v).success,
  kind: (v) => KINDS.has(v),
  status: (v) => ToolStatusSchema.safeParse(v).success,
  timestamp: (v) => ISO_TIMESTAMP.test(v),
  startedAt: (v) => ISO_TIMESTAMP.test(v),
  endedAt: (v) => ISO_TIMESTAMP.test(v),
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class RedactedSession {
  readonly #brand = true;
  readonly session: DeepReadonly<ParsedSession>;
  readonly counts: Readonly<RedactionCounts>;

  constructor(session: ParsedSession, counts: RedactionCounts) {
    this.session = deepFreeze(session);
    this.counts = Object.freeze(counts);
    Object.freeze(this);
  }

  static isInstance(value: unknown): value is RedactedSession {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}
export type { RedactedSession };

export const isRedactedSession = (value: unknown): value is RedactedSession => RedactedSession.isInstance(value);

/** Redacts every string in the session: prompts, replies, tool names/inputs/outputs, paths, branches, cwd, ids. */
export function redactSession(session: ParsedSession, options: RedactOptions = {}): RedactedSession {
  const redact = createRedactor(options);
  const counts: RedactionCounts = {};
  const tally = (result: RedactedText) => {
    for (const [type, n] of Object.entries(result.counts) as [keyof RedactionCounts, number][]) counts[type] = (counts[type] ?? 0) + n;
    return result.text;
  };

  const visit = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') return key && STRUCTURAL[key]?.(value) ? value : tally(redact(value));
    if (Array.isArray(value)) return value.map((v) => visit(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    return value;
  };

  return new RedactedSession(visit(session) as ParsedSession, counts);
}
