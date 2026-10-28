// Eval tooling: compares a summary against a hand-written golden (test-only, not shipped).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LlmSummary } from '../../src/summarize/schema.js';

export interface GoldenItem {
  /** Case-insensitive regex alternatives; each must match somewhere in the item's section. */
  mustMention: string[];
}

export interface Golden {
  fixture: string;
  goal: string;
  outcome: LlmSummary['outcome'];
  whatWasDone: string;
  decisions: ({ decision: string; reason: string } & GoldenItem)[];
  rejectedApproaches: ({ approach: string; reason: string } & GoldenItem)[];
  risksOrFollowUps: string[];
  aiInvolvement: LlmSummary['aiInvolvement'];
  /** Things absent from the source: mentioning them means the summary invented something. */
  mustNotMention: string[];
}

export interface GoldenReport {
  missingDecisions: string[];
  missingRejectedApproaches: string[];
  rejectedListedAsDecision: string[];
  forbiddenMentions: string[];
}

type Narrative = Pick<LlmSummary, 'goal' | 'whatWasDone' | 'decisions' | 'rejectedApproaches' | 'risksOrFollowUps'>;

const mentions = (text: string, patterns: string[]) => patterns.every((p) => new RegExp(p, 'i').test(text));
// "…instead of X", "Drop X and use Y": the decision names X only as what it replaced.
const REPLACES = /\b(instead of|rather than|in place of|replac\w*|drop\w*|remov\w*|switch\w* (?:away )?from|abandon\w*|no longer)\b/i;
const adopts = (decision: string, patterns: string[]) => mentions(decision, patterns) && !REPLACES.test(decision);

export function compareToGolden(summary: Narrative, golden: Golden): GoldenReport {
  const decisions = summary.decisions.map((d) => `${d.decision} ${d.reason}`).join('\n');
  const rejected = summary.rejectedApproaches.map((r) => `${r.approach} ${r.reason}`).join('\n');
  const everything = [summary.goal, summary.whatWasDone, decisions, rejected, ...summary.risksOrFollowUps].join('\n');
  return {
    missingDecisions: golden.decisions.filter((d) => !mentions(decisions, d.mustMention)).map((d) => d.decision),
    missingRejectedApproaches: golden.rejectedApproaches.filter((r) => !mentions(rejected, r.mustMention)).map((r) => r.approach),
    rejectedListedAsDecision: golden.rejectedApproaches.filter((r) => summary.decisions.some((d) => adopts(d.decision, r.mustMention))).map((r) => r.approach),
    forbiddenMentions: golden.mustNotMention.filter((w) => new RegExp(w, 'i').test(everything)),
  };
}

const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));
export const goldens = (): Golden[] =>
  readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${GOLDEN_DIR}${f}`, 'utf8')) as Golden);

/** The golden as the model's reply would look (for fake-LLM pipeline tests). */
export const asLlmReply = (g: Golden): LlmSummary => ({
  goal: g.goal,
  outcome: g.outcome,
  whatWasDone: g.whatWasDone,
  decisions: g.decisions.map(({ decision, reason }) => ({ decision, reason })),
  rejectedApproaches: g.rejectedApproaches.map(({ approach, reason }) => ({ approach, reason })),
  risksOrFollowUps: g.risksOrFollowUps,
  aiInvolvement: g.aiInvolvement,
  reversedDecisions: [],
});
