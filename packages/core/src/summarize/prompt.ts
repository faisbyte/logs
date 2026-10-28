import { z } from 'zod';
import { LlmSummarySchema, NarrativeSchema } from './schema.js';

// Bump on any change to the text below or to the schema: it is part of the summary cache key.
export const PROMPT_VERSION = 'summarize-v2';

// PROJECT_PLAN.md Section 6.1, verbatim apart from {schema}.
const SECTION_6_1 = `You are summarising one AI coding session for a team log.
Input: a redacted, condensed transcript of a developer working with an AI coding agent, plus metadata (branch, files touched).

Return ONLY JSON matching this schema: {schema}

Rules:
- "whatWasDone": 2–5 plain sentences on what changed and why.
- "decisions": only decisions that were actually made, each with its reason.
- "rejectedApproaches": approaches tried or proposed then abandoned, with reasons. These are valuable, so include them.
- "risksOrFollowUps": unfinished work, TODOs, known bugs, things to verify.
- Don't invent anything that isn't in the transcript. If unsure, leave it out.
- Don't include code, secrets, or redaction placeholders.
- "aiInvolvement": light = Q&A/explanations, moderate = AI wrote parts, heavy = AI wrote most of the change.`;

const NOTES = `Notes on the input and the remaining fields:
- Transcript lines: "USER:" is the developer, "ASSISTANT:" is the coding agent, "TOOL <name> <paths>" is a tool call, and "TOOL Bash: <command> (exit N)" is a shell command with its exit status (0 means it succeeded). "(rejected by user)" and "(failed)" mark calls that did not go through, and "[user interrupted]" means the developer stopped the agent. Tool output is not included. Placeholders like [REDACTED:...] hide secrets; never repeat them.
- A value or setting chosen with a reason (a threshold, limit, timeout, version, library or config value) is a decision, not a follow-up.
- "goal": one sentence on what the developer set out to do.
- "outcome": "completed" if the goal was met, "partial" if only some of it was done or work was left unfinished, "abandoned" if the task or approach was dropped.
- "reversedDecisions": long sessions arrive in parts. When decisions from earlier parts are listed with ids and this part reverses or abandons one, give its id and the reason here and leave it out of every other field. Otherwise return an empty list.`;

export function systemPrompt(): string {
  const schema = JSON.stringify(z.toJSONSchema(LlmSummarySchema), null, 2);
  return `${SECTION_6_1.replace('{schema}', schema)}\n\n${NOTES}`;
}

export interface ChunkMessageInput {
  metadata: string;
  chunk: string;
  part: number;
  parts: number;
  earlierDecisions: { id: string; decision: string }[];
}

export function chunkMessage({ metadata, chunk, part, parts, earlierDecisions }: ChunkMessageInput): string {
  const message = `Session metadata:\n${metadata}\n\nTranscript (part ${part} of ${parts}):\n${chunk}`;
  if (earlierDecisions.length === 0) return message;
  const listed = earlierDecisions.map((d) => `${d.id}: ${d.decision}`).join('\n');
  return `${message}\n\nDecisions recorded in earlier parts:\n${listed}\nIf this part reverses or abandons any of them, list its id in "reversedDecisions" with the reason, and leave it out of "decisions".`;
}

const MERGE = `You are merging summaries of consecutive parts of one AI coding session into a single team-log entry.
Input: each part's goal, outcome, what was done and AI involvement, in order, plus the decisions, rejected approaches and follow-ups already merged for the whole session.

Return ONLY JSON matching this schema: {schema}

Rules:
- "goal": one sentence on what the developer set out to do across the whole session.
- "whatWasDone": 2–5 plain sentences on what changed and why, across all parts.
- "outcome": for the session as a whole; the last part matters most.
- "aiInvolvement": light = Q&A/explanations, moderate = AI wrote parts, heavy = AI wrote most of the change.
- Don't invent anything that isn't in the part summaries. Don't include code, secrets, or redaction placeholders.`;

export function mergeSystemPrompt(): string {
  return MERGE.replace('{schema}', JSON.stringify(z.toJSONSchema(NarrativeSchema), null, 2));
}

export interface MergeInput {
  parts: { goal: string; outcome: string; whatWasDone: string; aiInvolvement: string }[];
  decisions: { decision: string; reason: string }[];
  rejectedApproaches: { approach: string; reason: string }[];
  risksOrFollowUps: string[];
}

export function mergeMessage({ parts, decisions, rejectedApproaches, risksOrFollowUps }: MergeInput): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none');
  return [
    ...parts.map((p, i) => `Part ${i + 1} of ${parts.length}:\nGoal: ${p.goal}\nOutcome: ${p.outcome}\nWhat was done: ${p.whatWasDone}\nAI involvement: ${p.aiInvolvement}`),
    `Decisions (whole session):\n${list(decisions.map((d) => `${d.decision} (${d.reason})`))}`,
    `Rejected approaches (whole session):\n${list(rejectedApproaches.map((r) => `${r.approach} (${r.reason})`))}`,
    `Risks and follow-ups (whole session):\n${list(risksOrFollowUps)}`,
  ].join('\n\n');
}
