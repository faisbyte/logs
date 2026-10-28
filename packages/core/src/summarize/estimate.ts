import type { RedactedSession } from '../redact/session.js';
import { chunkTurns, condenseSession, estimateTokens } from './condense.js';
import { chunkMessage, mergeSystemPrompt, systemPrompt } from './prompt.js';
import { estimateCostUsd, type SummarizeSettings } from './settings.js';

// Output per call, including low-effort thinking; replies are a few hundred tokens of JSON.
const OUTPUT_TOKENS_PER_CALL = 1_500;
const MERGE_INPUT_TOKENS_PER_PART = 250;

export interface CostEstimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** What summarising this session would send, before sending it. Errs high (see estimateTokens). */
export function estimateSummaryCost(redacted: RedactedSession, settings: SummarizeSettings): CostEstimate {
  const { metadata, turns, segmentStarts } = condenseSession(redacted);
  const chunks = chunkTurns(turns, settings.chunkTokens, segmentStarts);
  const system = systemPrompt();
  const calls = chunks.map((chunk, i) => ({
    inputTokens: estimateTokens(system + chunkMessage({ metadata, chunk, part: i + 1, parts: chunks.length, earlierDecisions: [] })),
    outputTokens: OUTPUT_TOKENS_PER_CALL,
  }));
  if (chunks.length > 1) calls.push({ inputTokens: estimateTokens(mergeSystemPrompt()) + chunks.length * MERGE_INPUT_TOKENS_PER_PART, outputTokens: OUTPUT_TOKENS_PER_CALL });
  const costs = calls.map((c) => estimateCostUsd(settings.model, c));
  return {
    requests: calls.length,
    inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: calls.reduce((n, c) => n + c.outputTokens, 0),
    costUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0),
  };
}
