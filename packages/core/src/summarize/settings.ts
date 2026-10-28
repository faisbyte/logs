import type { DigestConfig } from '../config.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SummarizeSettings {
  model: string;
  effort: Effort;
  chunkTokens: number;
}

// Claude Haiku 5.5: Anthropic's fast, low-cost model (checked against the live models page, 2026-10-28).
export const DEFAULT_MODEL = 'claude-haiku-5-5';
// Keeps every request under 100K prompt tokens, where Haiku 5.5 is billed at its cheaper rate card.
export const DEFAULT_CHUNK_TOKENS = 60_000;

export function summarizeSettings(config: DigestConfig): SummarizeSettings {
  return {
    model: config.summarize.model ?? DEFAULT_MODEL,
    effort: config.summarize.effort ?? 'low',
    chunkTokens: config.summarize.chunkTokens ?? DEFAULT_CHUNK_TOKENS,
  };
}

interface RateCard {
  /** Applies while one request's prompt is at most this many tokens. */
  maxPromptTokens: number;
  inputPerMTok: number;
  outputPerMTok: number;
}

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (2026-10-28).
const PRICING: Record<string, RateCard[]> = {
  'claude-haiku-5-5': [
    { maxPromptTokens: 100_000, inputPerMTok: 0.1, outputPerMTok: 0.5 },
    { maxPromptTokens: Infinity, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  ],
  'claude-sonnet-5-5': [{ maxPromptTokens: Infinity, inputPerMTok: 2, outputPerMTok: 10 }],
  'claude-opus-5-5': [{ maxPromptTokens: Infinity, inputPerMTok: 4, outputPerMTok: 20 }],
};

/** Cost of one request, or null for a model without a known price. */
export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const card = PRICING[model]?.find((c) => usage.inputTokens <= c.maxPromptTokens);
  if (!card) return null;
  return (usage.inputTokens * card.inputPerMTok + usage.outputTokens * card.outputPerMTok) / 1_000_000;
}
