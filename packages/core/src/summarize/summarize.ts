import { isEmptySession } from '../empty.js';
import { assertRedactedSession, type RedactedSession } from '../redact/session.js';
import { chunkSession, condenseSession } from './condense.js';
import type { z } from 'zod';
import type { LlmClient, LlmMessage, LlmUsage } from './llm.js';
import { chunkMessage, mergeMessage, mergeSystemPrompt, PROMPT_VERSION, systemPrompt } from './prompt.js';
import { buildSessionSummary, LlmSummarySchema, MAX_MERGED_ITEMS, MergeSchema, postCheck, type LlmSummary, type Merge, type SessionSummary, type Usage } from './schema.js';
import { estimateCostUsd } from './settings.js';

export class SummarizeError extends Error {}

/** What happened on the way to a summary, for the local usage log: each part's output, the merge's picks, every retry. */
export interface SummaryTrace {
  parts: { part: number; period: number; output: LlmSummary }[];
  merge: Merge | null;
  retries: { call: string; errors: string }[];
}

export interface SummarizeOptions {
  chunkTokens: number;
  now?: () => Date;
  /** Filled in as the session is summarised. */
  trace?: SummaryTrace;
}

/** The calls made for one session: their usage, and the errors behind any retries. */
interface CallLog {
  usages: LlmUsage[];
  retries: SummaryTrace['retries'];
}

// Room for adaptive thinking plus the JSON reply, while staying non-streaming.
const MAX_TOKENS = 16_000;

/** The JSON object in a reply, tolerating stray text around it. */
const extractJson = (text: string) => text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);

function validate<T extends object>(
  schema: z.ZodType<T>,
  text: string,
  stopReason: string | null,
  check: (value: T) => string[],
): { value: T } | { errors: string } {
  if (stopReason === 'max_tokens') return { errors: 'the reply was cut off at the token limit' };
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch {
    return { errors: 'the reply was not valid JSON' };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  const issues = [...postCheck(parsed.data), ...check(parsed.data)];
  return issues.length ? { errors: issues.join('; ') } : { value: parsed.data };
}

/** One reply from the model, validated; retried once with the errors, then a clear failure. */
async function validatedCall<T extends object>(
  llm: LlmClient,
  source: RedactedSession,
  schema: z.ZodType<T>,
  system: string,
  user: string,
  log: CallLog & { call: string },
  check: (value: T) => string[] = () => [],
): Promise<T> {
  const sessionId = source.session.sourceSessionId;
  let messages: LlmMessage[] = [{ role: 'user', content: user }];
  for (let attempt = 1; ; attempt++) {
    const response = await llm.complete({ source, system, messages, schema, maxTokens: MAX_TOKENS });
    log.usages.push(response.usage);
    if (response.stopReason === 'refusal') throw new SummarizeError(`The model refused to summarise ${sessionId}.`);
    const result = validate(schema, response.text, response.stopReason, check);
    if ('value' in result) return result.value;
    if (attempt === 2) throw new SummarizeError(`Summary for ${sessionId} failed validation twice: ${result.errors}`);
    log.retries.push({ call: log.call, errors: result.errors });
    messages = [
      ...messages,
      { role: 'assistant', content: response.text || '(empty reply)' },
      { role: 'user', content: `Your previous reply was not valid: ${result.errors}. Reply again with only the corrected JSON object.` },
    ];
  }
}

function totalUsage(model: string, usages: LlmUsage[]): Usage {
  const costs = usages.map((u) => estimateCostUsd(model, u));
  return {
    inputTokens: usages.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: usages.reduce((n, u) => n + u.outputTokens, 0),
    requests: usages.length,
    costUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0),
  };
}

interface Candidate {
  id: string;
  part: number;
  period: number;
}

/**
 * The merge's picks, topped up so every part that offered candidates keeps at least one, or every work period
 * when more parts offered candidates than the list has slots (DECISIONS.md D32). A top-up beyond the cap replaces
 * the lowest-ranked pick of the best-covered part. Returned in session order.
 */
export function coverParts<T extends Candidate>(ids: readonly string[], candidates: readonly T[], max = MAX_MERGED_ITEMS): T[] {
  const picked = [...new Set(ids)].map((id) => candidates.find((c) => c.id === id)!);
  const unit = new Set(candidates.map((c) => c.part)).size <= max ? (c: T) => c.part : (c: T) => c.period;
  const units = [...new Set(candidates.map(unit))];
  if (units.length <= max) {
    for (const u of units) {
      if (picked.some((c) => unit(c) === u)) continue;
      if (picked.length >= max) {
        const count = (v: number) => picked.filter((c) => unit(c) === v).length;
        const crowded = picked.map(unit).reduce((a, b) => (count(b) > count(a) ? b : a));
        picked.splice(picked.findLastIndex((c) => unit(c) === crowded), 1);
      }
      picked.push(candidates.find((c) => unit(c) === u)!);
    }
  }
  return picked.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
}

interface Decided {
  id: string;
  part: number;
  decision: string;
  reason: string;
}

interface FollowUp {
  id: string;
  part: number;
  text: string;
}

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
/** A reversal counts only when its quote appears in the part that made it (DECISIONS.md D33). */
const quotedIn = (chunk: string, evidence: string) => normalise(evidence).length >= 3 && normalise(chunk).includes(normalise(evidence));

/** Distills parts into one summary (DECISIONS.md D24, D27, D32): the model picks at most 6 candidates per list by id. */
async function mergeParts(
  llm: LlmClient,
  redacted: RedactedSession,
  parts: (LlmSummary & { period: number })[],
  decided: Decided[],
  reversed: Map<string, { reason: string; part: number }>,
  openFollowUps: FollowUp[],
  log: CallLog,
  trace: SummaryTrace,
): Promise<LlmSummary> {
  // Exact duplicates keep their first, earliest occurrence.
  const unique = <T>(items: T[], key: (t: T) => string) => items.filter((t, i) => items.findIndex((u) => key(u) === key(t)) === i);
  const periodOf = (part: number) => parts[part - 1]!.period;
  const decisions = decided.filter((d) => !reversed.has(d.id)).map((d) => ({ ...d, period: periodOf(d.part) }));
  const rejectedApproaches = unique(
    [
      ...parts.flatMap((p, i) => p.rejectedApproaches.map((r) => ({ part: i + 1, ...r }))),
      ...decided.filter((d) => reversed.has(d.id)).map((d) => ({ part: reversed.get(d.id)!.part, approach: d.decision, reason: reversed.get(d.id)!.reason })),
    ],
    (r) => r.approach,
  ).map((r, i) => ({ id: `R${i + 1}`, period: periodOf(r.part), ...r }));
  const followUps = openFollowUps.map((f) => ({ ...f, period: periodOf(f.part) }));

  const offered = (ids: string[], from: { id: string }[], field: string) => {
    const known = new Set(from.map((c) => c.id));
    return ids.filter((id) => !known.has(id)).map((id) => `${field}: ${id} was not offered`);
  };
  const check = (m: Merge) => [
    ...offered(m.decisionIds, decisions, 'decisionIds'),
    ...offered(m.rejectedApproachIds, rejectedApproaches, 'rejectedApproachIds'),
    ...offered(m.followUpIds, followUps, 'followUpIds'),
  ];
  const message = mergeMessage({ parts, decisions, rejectedApproaches, followUps });
  const merge = await validatedCall(llm, redacted, MergeSchema, mergeSystemPrompt(), message, { ...log, call: 'merge' }, check);
  trace.merge = merge;

  return {
    goal: merge.goal,
    whatWasDone: merge.whatWasDone,
    aiInvolvement: merge.aiInvolvement,
    // The end state of the session decides the outcome.
    outcome: parts.at(-1)!.outcome,
    decisions: coverParts(merge.decisionIds, decisions).map(({ decision, reason }) => ({ decision, reason })),
    rejectedApproaches: coverParts(merge.rejectedApproachIds, rejectedApproaches).map(({ approach, reason }) => ({ approach, reason })),
    // Not topped up: an early part's open item is often finished by a later one.
    risksOrFollowUps: followUps.filter((f) => merge.followUpIds.includes(f.id)).map((f) => f.text),
    reversedDecisions: [],
    resolvedFollowUps: [],
  };
}

/** Summarises one redacted session into a draft. Only a RedactedSession is accepted (DECISIONS.md D16). */
export async function summarizeSession(redacted: RedactedSession, llm: LlmClient, options: SummarizeOptions): Promise<SessionSummary> {
  assertRedactedSession(redacted);
  const s = redacted.session;
  if (isEmptySession(s as Parameters<typeof isEmptySession>[0])) throw new SummarizeError(`Session ${s.sourceSessionId} is empty; nothing to summarise.`);

  const { metadata, turns, segmentStarts } = condenseSession(redacted);
  const chunks = chunkSession(turns, options.chunkTokens, segmentStarts);
  const trace: SummaryTrace = options.trace ?? { parts: [], merge: null, retries: [] };
  const log: CallLog = { usages: [], retries: trace.retries };
  const system = systemPrompt();

  // Parts are summarised in order; each sees earlier decisions by id and may reverse them (DECISIONS.md D24).
  const decided: Decided[] = [];
  const reversed = new Map<string, { reason: string; part: number }>();
  const followUps: FollowUp[] = [];
  const resolved = new Set<string>();
  const parts: (LlmSummary & { period: number })[] = [];
  for (const [i, { text: chunk, period }] of chunks.entries()) {
    const open = decided.filter((d) => !reversed.has(d.id));
    const pending = followUps.filter((f) => !resolved.has(f.id));
    const message = chunkMessage({
      metadata,
      chunk,
      part: i + 1,
      parts: chunks.length,
      earlierDecisions: open.map(({ id, decision }) => ({ id, decision })),
      earlierFollowUps: pending.map(({ id, text }) => ({ id, text })),
    });
    const part = await validatedCall(llm, redacted, LlmSummarySchema, system, message, { ...log, call: `part ${i + 1} of ${chunks.length}` });
    trace.parts.push({ part: i + 1, period, output: part });
    for (const r of part.reversedDecisions) if (open.some((d) => d.id === r.id) && quotedIn(chunk, r.evidence)) reversed.set(r.id, { reason: r.reason, part: i + 1 });
    for (const id of part.resolvedFollowUps) if (pending.some((f) => f.id === id)) resolved.add(id);
    // Exact duplicates of an open follow-up keep its first, earliest occurrence; a resolved one raised again is new.
    for (const text of part.risksOrFollowUps) if (!followUps.some((f) => f.text === text && !resolved.has(f.id))) followUps.push({ id: `F${followUps.length + 1}`, part: i + 1, text });
    // A decision repeated word for word keeps its first id; one made again after being reversed is new.
    for (const d of part.decisions) if (!decided.some((e) => e.decision === d.decision && !reversed.has(e.id))) decided.push({ id: `D${decided.length + 1}`, part: i + 1, ...d });
    parts.push({ ...part, period });
  }

  const summary = parts.length === 1 ? parts[0]! : await mergeParts(llm, redacted, parts, decided, reversed, followUps.filter((f) => !resolved.has(f.id)), log, trace);

  return buildSessionSummary(summary, redacted, {
    model: llm.model,
    promptVersion: PROMPT_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    usage: totalUsage(llm.model, log.usages),
  });
}
