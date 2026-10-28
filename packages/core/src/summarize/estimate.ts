import type { RedactedSession } from '../redact/session.js';
import { chunkTurns, condenseSession, estimateTokens } from './condense.js';
import { chunkMessage, mergeSystemPrompt, systemPrompt } from './prompt.js';
import { estimateCostUsd, type SummarizeSettings } from './settings.js';

// Calibrated on the real runs (DECISIONS.md D22): the 2.5 chars/token figure under-counted input by up to 46%
// (v2 shell-command lines tokenize densely; small sessions are dominated by the JSON schema), and one reply used
// 2,349 output tokens. Both margins keep every observed request at least 5% under its estimate.
export const INPUT_SAFETY_MARGIN = 1.6;
export const OUTPUT_TOKENS_PER_CALL = 3_000;
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
  const withMargin = (tokens: number) => Math.ceil(tokens * INPUT_SAFETY_MARGIN);
  const calls = chunks.map((chunk, i) => ({
    inputTokens: withMargin(estimateTokens(system + chunkMessage({ metadata, chunk, part: i + 1, parts: chunks.length, earlierDecisions: [] }))),
    outputTokens: OUTPUT_TOKENS_PER_CALL,
  }));
  if (chunks.length > 1) {
    calls.push({ inputTokens: withMargin(estimateTokens(mergeSystemPrompt()) + chunks.length * MERGE_INPUT_TOKENS_PER_PART), outputTokens: OUTPUT_TOKENS_PER_CALL });
  }
  const costs = calls.map((c) => estimateCostUsd(settings.model, c));
  return {
    requests: calls.length,
    inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: calls.reduce((n, c) => n + c.outputTokens, 0),
    costUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0),
  };
}
