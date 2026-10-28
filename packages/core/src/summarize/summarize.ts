import { isEmptySession } from '../empty.js';
import { assertRedactedSession, type RedactedSession } from '../redact/session.js';
import { chunkTurns, condenseSession } from './condense.js';
import type { LlmClient, LlmMessage, LlmUsage } from './llm.js';
import { chunkMessage, PROMPT_VERSION, systemPrompt } from './prompt.js';
import { buildSessionSummary, LlmSummarySchema, postCheck, type LlmSummary, type SessionSummary, type Usage } from './schema.js';
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

function validate(text: string, stopReason: string | null): { summary: LlmSummary } | { errors: string } {
  if (stopReason === 'max_tokens') return { errors: 'the reply was cut off at the token limit' };
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch {
    return { errors: 'the reply was not valid JSON' };
  }
  const parsed = LlmSummarySchema.safeParse(value);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  const issues = postCheck(parsed.data);
  return issues.length ? { errors: issues.join('; ') } : { summary: parsed.data };
}

/** One summary from the model, validated; retried once with the errors, then a clear failure. */
async function validatedCall(llm: LlmClient, source: RedactedSession, system: string, user: string, usages: LlmUsage[]): Promise<LlmSummary> {
  const sessionId = source.session.sourceSessionId;
  let messages: LlmMessage[] = [{ role: 'user', content: user }];
  for (let attempt = 1; ; attempt++) {
    const response = await llm.complete({ source, system, messages, schema: LlmSummarySchema, maxTokens: MAX_TOKENS });
    usages.push(response.usage);
    if (response.stopReason === 'refusal') throw new SummarizeError(`The model refused to summarise ${sessionId}.`);
    const result = validate(response.text, response.stopReason);
    if ('summary' in result) return result.summary;
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

/** Summarises one redacted session into a draft. Only a RedactedSession is accepted (DECISIONS.md D16). */
export async function summarizeSession(redacted: RedactedSession, llm: LlmClient, options: SummarizeOptions): Promise<SessionSummary> {
  assertRedactedSession(redacted);
  const s = redacted.session;
  if (isEmptySession(s as Parameters<typeof isEmptySession>[0])) throw new SummarizeError(`Session ${s.sourceSessionId} is empty; nothing to summarise.`);

  const { metadata, turns } = condenseSession(redacted);
  const chunks = chunkTurns(turns, options.chunkTokens);
  if (chunks.length > 1) throw new SummarizeError('Multi-chunk sessions are not supported yet.');

  const usages: LlmUsage[] = [];
  const system = systemPrompt();
  const summary = await validatedCall(llm, redacted, system, chunkMessage({ metadata, chunk: chunks[0] ?? '', part: 1, parts: 1, earlierDecisions: [] }), usages);

  return buildSessionSummary(summary, redacted, {
    model: llm.model,
    promptVersion: PROMPT_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    usage: totalUsage(llm.model, usages),
  });
}
