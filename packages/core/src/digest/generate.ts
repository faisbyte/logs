import { z } from 'zod';
import { contentProblems } from '../shared/payload.js';
import { estimateTokens } from '../summarize/condense.js';
import { INPUT_SAFETY_MARGIN, OUTPUT_TOKENS_PER_CALL, type CostEstimate } from '../summarize/estimate.js';
import type { LlmClient, LlmMessage, LlmUsage } from '../summarize/llm.js';
import type { Usage } from '../summarize/schema.js';
import { estimateCostUsd } from '../summarize/settings.js';
import type { DigestInput, DigestPeriod } from './input.js';
import { DIGEST_PROMPT_VERSION, digestMessage, digestSystemPrompt } from './prompt.js';

// Writing a stakeholder digest (DECISIONS.md D50): one structured-output call, a faithfulness post-check with
// one retry, Markdown rendered here rather than by the model, and a secret block on the final text.

export const DigestOutputSchema = z.object({
  overview: z.string().min(1),
  tickets: z.array(
    z.object({
      key: z.string(),
      achieved: z.string().min(1),
      aiInvolvement: z.string().min(1),
      keyDecisions: z.array(z.string()),
    }),
  ),
  otherWork: z.string().nullable(),
  risksAndOpenQuestions: z.array(z.string()),
});
export type DigestOutput = z.infer<typeof DigestOutputSchema>;

export interface Digest {
  markdown: string;
  period: DigestPeriod;
  coverage: { summaryCount: number; developerCount: number };
  model: string;
  promptVersion: string;
  /** DigestInput.hash: with period, prompt version and model, the cache key. */
  inputHash: string;
  usage: Usage;
  generatedAt: string;
}

export class DigestError extends Error {
  /** What the failed attempts cost, so it still counts against the monthly cap (D53). */
  usage: Usage | null = null;
}
/** A digest that matched a secret detector. It is never stored or delivered. */
export class DigestBlockedError extends DigestError {}

const MAX_TOKENS = 8_000;
const KEY = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;

const strings = (out: DigestOutput): [string, string][] => [
  ['overview', out.overview],
  ...out.tickets.flatMap((t, i): [string, string][] => [
    [`tickets.${i}.achieved`, t.achieved],
    [`tickets.${i}.aiInvolvement`, t.aiInvolvement],
    ...t.keyDecisions.map((d, j): [string, string] => [`tickets.${i}.keyDecisions.${j}`, d]),
  ]),
  ...(out.otherWork === null ? [] : [['otherWork', out.otherWork] as [string, string]]),
  ...out.risksAndOpenQuestions.map((r, i): [string, string] => [`risksAndOpenQuestions.${i}`, r]),
];

/**
 * Faithfulness checks: exactly the input's tickets, no other ticket keys mentioned, no code, and other work
 * only when there was some. Keys are checked for the input's own project prefixes, so UTF-8 or SHA-256 pass.
 */
export function checkDigest(out: DigestOutput, input: DigestInput): string[] {
  const keys = new Set(input.tickets.map((t) => t.key));
  const projects = new Set([...keys].map((k) => k.split('-')[0]!));
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const t of out.tickets) {
    if (!keys.has(t.key)) errors.push(`tickets: ${t.key} is not in the input`);
    else if (seen.has(t.key)) errors.push(`tickets: ${t.key} has more than one section`);
    seen.add(t.key);
  }
  for (const key of keys) if (!seen.has(key)) errors.push(`tickets: no section for ${key}`);
  for (const [path, text] of strings(out)) {
    if (/```|`[^`]+`/.test(text)) errors.push(`${path}: contains code formatting`);
    for (const [key, project] of text.matchAll(KEY)) if (projects.has(project!) && !keys.has(key)) errors.push(`${path}: mentions ${key}, which is not in the input`);
  }
  if (input.unlinked.length === 0 && out.otherWork !== null) errors.push('otherWork: there is no work without a ticket in the input; use null');
  return errors;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const coverageLine = (c: Digest['coverage']) =>
  `_Based on ${plural(c.summaryCount, 'summary', 'summaries')} that ${plural(c.developerCount, 'developer', 'developers')} chose to share._`;

export function renderDigest(out: DigestOutput | null, input: DigestInput): string {
  const lines = [`# AI work update: ${input.period.label}`, ''];
  if (!out) return [...lines, 'No AI-assisted work was shared for this period.', '', coverageLine(input.coverage), ''].join('\n');
  lines.push(out.overview, '');
  for (const t of input.tickets) {
    const section = out.tickets.find((s) => s.key === t.key)!;
    lines.push(`## ${t.key}${t.title ? `: ${t.title}` : ''}`, '', section.achieved, '', `**AI involvement: ${t.aiInvolvement}.** ${section.aiInvolvement}`, '');
    if (section.keyDecisions.length) lines.push('**Key decisions:**', '', ...section.keyDecisions.map((d) => `- ${d}`), '');
  }
  if (out.otherWork) lines.push('## Other work', '', out.otherWork, '');
  if (out.risksAndOpenQuestions.length) lines.push('## Risks and open questions', '', ...out.risksAndOpenQuestions.map((r) => `- ${r}`), '');
  return [...lines, coverageLine(input.coverage), ''].join('\n');
}

/** The last check before a digest is stored or delivered: the secret detectors, on the whole text (D50). */
export function assertDeliverable(markdown: string): void {
  const problems = contentProblems('digest', markdown);
  if (problems.length) throw new DigestBlockedError(`Digest blocked: ${problems.join('; ')}.`);
}

function parse(text: string, stopReason: string | null, input: DigestInput): { value: DigestOutput } | { errors: string } {
  if (stopReason === 'max_tokens') return { errors: 'the reply was cut off at the token limit' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { errors: 'the reply was not valid JSON' };
  }
  const parsed = DigestOutputSchema.safeParse(value);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  const issues = checkDigest(parsed.data, input);
  return issues.length ? { errors: issues.join('; ') } : { value: parsed.data };
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

function withUsage(error: DigestError, model: string, usages: LlmUsage[]): DigestError {
  error.usage = totalUsage(model, usages);
  return error;
}

export async function generateDigest(input: DigestInput, llm: LlmClient, { now = () => new Date() }: { now?: () => Date } = {}): Promise<Digest> {
  const done = (out: DigestOutput | null, usages: LlmUsage[]): Digest => {
    const markdown = renderDigest(out, input);
    assertDeliverable(markdown);
    return { markdown, period: input.period, coverage: input.coverage, model: llm.model, promptVersion: DIGEST_PROMPT_VERSION, inputHash: input.hash, usage: totalUsage(llm.model, usages), generatedAt: now().toISOString() };
  };
  if (input.tickets.length === 0 && input.unlinked.length === 0) return done(null, []);

  const system = digestSystemPrompt();
  let messages: LlmMessage[] = [{ role: 'user', content: digestMessage(input) }];
  const usages: LlmUsage[] = [];
  for (let attempt = 1; ; attempt++) {
    const response = await llm.complete({ source: input, system, messages, schema: DigestOutputSchema, maxTokens: MAX_TOKENS });
    usages.push(response.usage);
    if (response.stopReason === 'refusal') throw withUsage(new DigestError(`The model refused to write the digest for ${input.period.label}.`), llm.model, usages);
    const result = parse(response.text, response.stopReason, input);
    if ('value' in result) {
      // A secret is blocked outright, never retried: the reply that held it isn't sent back to the model either.
      const secrets = strings(result.value).flatMap(([path, text]) => contentProblems(path, text));
      if (secrets.length) throw withUsage(new DigestBlockedError(`Digest blocked: ${secrets.join('; ')}.`), llm.model, usages);
      return done(result.value, usages);
    }
    if (attempt === 2) throw withUsage(new DigestError(`The digest for ${input.period.label} failed its checks twice: ${result.errors}`), llm.model, usages);
    messages = [
      ...messages,
      { role: 'assistant', content: response.text || '(empty reply)' },
      { role: 'user', content: `Your previous reply was not valid: ${result.errors}. Reply again with only the corrected JSON object.` },
    ];
  }
}

/** What writing this digest would cost, before sending it. Errs high, like the summary estimate (D22). */
export function estimateDigestCost(input: DigestInput, model: string): CostEstimate {
  if (input.tickets.length === 0 && input.unlinked.length === 0) return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const call = { inputTokens: Math.ceil(estimateTokens(digestSystemPrompt() + digestMessage(input)) * INPUT_SAFETY_MARGIN), outputTokens: OUTPUT_TOKENS_PER_CALL };
  return { requests: 1, ...call, costUsd: estimateCostUsd(model, call) };
}
