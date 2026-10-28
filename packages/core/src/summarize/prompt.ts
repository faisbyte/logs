import { z } from 'zod';
import { LlmSummarySchema, MergeSchema } from './schema.js';

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
- Transcript lines: "USER:" is the developer, "ASSISTANT:" is the coding agent, "TOOL <name> <paths>" is a tool call, and "TOOL Bash: <command> (exit N)" is a shell command with its exit status (0 means it succeeded). "(rejected by user)" and "(failed)" mark calls that did not go through, "[user interrupted]" means the developer stopped the agent, and "[resumed after N hours]" marks a new work period. Tool output is not included. Placeholders like [REDACTED:...] hide secrets; never repeat them.
- Sessions can span several tasks and work periods: "goal" and "whatWasDone" must cover all of them, weighted by how much work each took, not just the last one.
- Never contradict the session metadata (branch, dates, files changed, commits made).
- A value or setting chosen with a reason (a threshold, limit, timeout, version, library or config value) is a decision, not a follow-up.
- "goal": one sentence on what the developer set out to do.
- "outcome": "completed" if the goal was met, "partial" if only some of it was done or work was left unfinished, "abandoned" if the task or approach was dropped.
- Write about the session's work only: never mention the transcript, its parts, the metadata, summarising, or a team log.
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

const MERGE = `You are merging summaries of consecutive parts of one AI coding session into one summary of the whole session.
Input: each part's goal, what was done and AI involvement, in order, then numbered candidate decisions (D), rejected approaches (R) and follow-ups (F) collected from all parts.

Return ONLY JSON matching this schema: {schema}

Rules:
- "goal": one sentence on what the developer set out to do across the whole session, not just its last part.
- "whatWasDone": 2–5 plain sentences on what changed and why, covering every part from the earliest to the latest.
- "decisionIds", "rejectedApproachIds", "followUpIds": choose at most 6 ids from each candidate list, keeping the most durable and important ones (what a teammate would still need to know later). When several candidates say the same thing, choose only one of them. Use only ids from the matching list.
- "aiInvolvement": light = Q&A/explanations, moderate = AI wrote parts, heavy = AI wrote most of the change.
- Write about the session's work only: never mention the transcript, its parts, the metadata, summarising, or a team log.
- Don't invent anything that isn't in the part summaries. Don't include code, secrets, or redaction placeholders.`;

export function mergeSystemPrompt(): string {
  return MERGE.replace('{schema}', JSON.stringify(z.toJSONSchema(MergeSchema), null, 2));
}

export interface MergeInput {
  parts: { goal: string; whatWasDone: string; aiInvolvement: string }[];
  decisions: { id: string; decision: string; reason: string }[];
  rejectedApproaches: { id: string; approach: string; reason: string }[];
  followUps: { id: string; text: string }[];
}

export function mergeMessage({ parts, decisions, rejectedApproaches, followUps }: MergeInput): string {
  const list = (items: string[]) => (items.length ? items.join('\n') : '(none)');
  return [
    ...parts.map((p, i) => `Part ${i + 1} of ${parts.length}:\nGoal: ${p.goal}\nWhat was done: ${p.whatWasDone}\nAI involvement: ${p.aiInvolvement}`),
    `Candidate decisions:\n${list(decisions.map((d) => `${d.id}: ${d.decision} (reason: ${d.reason})`))}`,
    `Candidate rejected approaches:\n${list(rejectedApproaches.map((r) => `${r.id}: ${r.approach} (reason: ${r.reason})`))}`,
    `Candidate follow-ups:\n${list(followUps.map((f) => `${f.id}: ${f.text}`))}`,
  ].join('\n\n');
}
