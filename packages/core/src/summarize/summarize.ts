import { isEmptySession } from '../empty.js';
import { assertRedactedSession, type RedactedSession } from '../redact/session.js';
import { chunkTurns, condenseSession } from './condense.js';
import type { z } from 'zod';
import type { LlmClient, LlmMessage, LlmUsage } from './llm.js';
import { chunkMessage, mergeMessage, mergeSystemPrompt, PROMPT_VERSION, systemPrompt } from './prompt.js';
import { buildSessionSummary, LlmSummarySchema, MergeSchema, postCheck, type LlmSummary, type Merge, type SessionSummary, type Usage } from './schema.js';
import { estimateCostUsd } from './settings.js';

export class SummarizeError extends Error {}

export interface SummarizeOptions {
  chunkTokens: number;
  now?: () => Date;
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
  usages: LlmUsage[],
  check: (value: T) => string[] = () => [],
): Promise<T> {
  const sessionId = source.session.sourceSessionId;
  let messages: LlmMessage[] = [{ role: 'user', content: user }];
  for (let attempt = 1; ; attempt++) {
    const response = await llm.complete({ source, system, messages, schema, maxTokens: MAX_TOKENS });
    usages.push(response.usage);
    if (response.stopReason === 'refusal') throw new SummarizeError(`The model refused to summarise ${sessionId}.`);
    const result = validate(schema, response.text, response.stopReason, check);
    if ('value' in result) return result.value;
    if (attempt === 2) throw new SummarizeError(`Summary for ${sessionId} failed validation twice: ${result.errors}`);
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

/** Distills parts into one summary (DECISIONS.md D24, D27): the model picks at most 6 candidates per list by id. */
async function mergeParts(
  llm: LlmClient,
  redacted: RedactedSession,
  parts: LlmSummary[],
  decided: { id: string; decision: string; reason: string }[],
  reversed: Map<string, string>,
  usages: LlmUsage[],
): Promise<LlmSummary> {
  const unique = <T>(items: T[], key: (t: T) => string) => [...new Map(items.map((t) => [key(t), t])).values()];
  const decisions = decided.filter((d) => !reversed.has(d.id));
  const rejectedApproaches = unique(
    [...parts.flatMap((p) => p.rejectedApproaches), ...decided.filter((d) => reversed.has(d.id)).map((d) => ({ approach: d.decision, reason: reversed.get(d.id)! }))],
    (r) => r.approach,
  ).map((r, i) => ({ id: `R${i + 1}`, ...r }));
  const followUps = unique(parts.flatMap((p) => p.risksOrFollowUps), (f) => f).map((text, i) => ({ id: `F${i + 1}`, text }));

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
  const merge = await validatedCall(llm, redacted, MergeSchema, mergeSystemPrompt(), message, usages, check);

  const pick = <T extends { id: string }>(ids: string[], from: T[]) => unique(ids, (id) => id).map((id) => from.find((c) => c.id === id)!);
  return {
    goal: merge.goal,
    whatWasDone: merge.whatWasDone,
    aiInvolvement: merge.aiInvolvement,
    // The end state of the session decides the outcome.
    outcome: parts.at(-1)!.outcome,
    decisions: pick(merge.decisionIds, decisions).map(({ decision, reason }) => ({ decision, reason })),
    rejectedApproaches: pick(merge.rejectedApproachIds, rejectedApproaches).map(({ approach, reason }) => ({ approach, reason })),
    risksOrFollowUps: pick(merge.followUpIds, followUps).map((f) => f.text),
    reversedDecisions: [],
  };
}

/** Summarises one redacted session into a draft. Only a RedactedSession is accepted (DECISIONS.md D16). */
export async function summarizeSession(redacted: RedactedSession, llm: LlmClient, options: SummarizeOptions): Promise<SessionSummary> {
  assertRedactedSession(redacted);
  const s = redacted.session;
  if (isEmptySession(s as Parameters<typeof isEmptySession>[0])) throw new SummarizeError(`Session ${s.sourceSessionId} is empty; nothing to summarise.`);

  const { metadata, turns } = condenseSession(redacted);
  const chunks = chunkTurns(turns, options.chunkTokens);
  const usages: LlmUsage[] = [];
  const system = systemPrompt();

  // Parts are summarised in order; each sees earlier decisions by id and may reverse them (DECISIONS.md D24).
  const decided: { id: string; decision: string; reason: string }[] = [];
  const reversed = new Map<string, string>();
  const parts: LlmSummary[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const open = decided.filter((d) => !reversed.has(d.id));
    const message = chunkMessage({ metadata, chunk, part: i + 1, parts: chunks.length, earlierDecisions: open.map(({ id, decision }) => ({ id, decision })) });
    const part = await validatedCall(llm, redacted, LlmSummarySchema, system, message, usages);
    for (const r of part.reversedDecisions) if (open.some((d) => d.id === r.id)) reversed.set(r.id, r.reason);
    for (const d of part.decisions) decided.push({ id: `D${decided.length + 1}`, ...d });
    parts.push(part);
  }

  const summary = parts.length === 1 ? parts[0]! : await mergeParts(llm, redacted, parts, decided, reversed, usages);

  return buildSessionSummary(summary, redacted, {
    model: llm.model,
    promptVersion: PROMPT_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    usage: totalUsage(llm.model, usages),
  });
}
