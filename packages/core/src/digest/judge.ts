import { z } from 'zod';
import type { LlmClient } from '../summarize/llm.js';
import type { Usage } from '../summarize/schema.js';
import { estimateCostUsd } from '../summarize/settings.js';
import type { DigestInput } from './input.js';
import { digestMessage } from './prompt.js';

// The faithfulness judge for the opt-in digest eval (DECISIONS.md D56). The deterministic checks (D50) catch
// unknown tickets and code; this catches claims the summaries don't support, which only a reader can judge.

export const JudgeSchema = z.object({
  claims: z.array(z.object({ claim: z.string(), supported: z.boolean(), reason: z.string() })),
  resolvedStillListed: z.array(z.object({ item: z.string(), laterWork: z.string() })),
});

export function judgeSystemPrompt(): string {
  return `You check a stakeholder digest against the approved session summaries it was written from.
List every factual claim the digest makes: what was done, decided, rejected, risked or left open, how much AI was involved, and anything about outcomes or timing.
A claim is supported only if the summaries state it or plainly imply it. Rewording and simplifying for a non-technical reader is fine; adding facts, outcomes, causes, numbers or certainty is not.
Skip the coverage line, headings and ticket titles.
The work is listed oldest first (W1, W2, ...).
Reply with a JSON object:
- "claims": each with "claim" (quoted or closely paraphrased from the digest), "supported" (true or false) and "reason" (one sentence, citing the work number when supported).
- "resolvedStillListed": every risk, follow-up or "not yet done" statement in the digest that later work (a higher W number) shows as done, fixed or decided, each with "item" (from the digest) and "laterWork" (which W resolved it, and how). An empty list when there are none.`;
}

export interface JudgeVerdict {
  claimCount: number;
  unsupported: { claim: string; reason: string }[];
  resolvedStillListed: { item: string; laterWork: string }[];
  usage: Usage;
}

export async function judgeDigest(input: DigestInput, markdown: string, llm: LlmClient): Promise<JudgeVerdict> {
  const message = `Session summaries:\n${digestMessage(input)}\n\nDigest to check:\n${markdown}`;
  const response = await llm.complete({ source: input, system: judgeSystemPrompt(), messages: [{ role: 'user', content: message }], schema: JudgeSchema, maxTokens: 8_000 });
  const { claims, resolvedStillListed } = JudgeSchema.parse(JSON.parse(response.text));
  return {
    claimCount: claims.length,
    unsupported: claims.filter((c) => !c.supported).map(({ claim, reason }) => ({ claim, reason })),
    resolvedStillListed,
    usage: { ...response.usage, requests: 1, costUsd: estimateCostUsd(llm.model, response.usage) },
  };
}
