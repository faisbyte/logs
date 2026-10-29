import { z } from 'zod';
import { LlmSummarySchema, MergeSchema } from './schema.js';

// Bump on any change to the text below, to the schema or to how parts are merged: it is part of the summary cache key.
export const PROMPT_VERSION = 'summarize-v6';

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
- "reversedDecisions": long sessions arrive in parts, and decisions from earlier parts are listed with ids. Only list a decision here when this part of the transcript explicitly drops, replaces or undoes it; a decision this part doesn't mention or apply is not reversed. Give its id, the reason, and "evidence": a short phrase copied word for word from this part of the transcript where it is dropped. Leave a reversed decision out of every other field. Otherwise return an empty list.
- "resolvedFollowUps": follow-ups from earlier parts are listed with ids too. List the id of each one this part completes or makes moot. Otherwise return an empty list.`;

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
  earlierFollowUps?: { id: string; text: string }[];
}

export function chunkMessage({ metadata, chunk, part, parts, earlierDecisions, earlierFollowUps = [] }: ChunkMessageInput): string {
  const sections = [`Session metadata:\n${metadata}\n\nTranscript (part ${part} of ${parts}):\n${chunk}`];
  if (parts > 1) {
    sections.push(
      'This part is one stretch of a longer session: earlier and later parts cover other work. In "risksOrFollowUps", list only work this part started and left unfinished; never list work as missing just because it is not in this part. "outcome" here is whether the work in this part was finished.',
    );
  }
  if (earlierDecisions.length) {
    const listed = earlierDecisions.map((d) => `${d.id}: ${d.decision}`).join('\n');
    sections.push(`Decisions recorded in earlier parts:\n${listed}\nIf this part explicitly drops, replaces or undoes any of them, list its id in "reversedDecisions" with the reason and a quote, and leave it out of "decisions".`);
  }
  if (earlierFollowUps.length) {
    const listed = earlierFollowUps.map((f) => `${f.id}: ${f.text}`).join('\n');
    sections.push(`Follow-ups recorded in earlier parts:\n${listed}\nIf this part completes or makes any of them moot, list its id in "resolvedFollowUps".`);
  }
  return sections.join('\n\n');
}

const MERGE = `You are merging summaries of consecutive parts of one AI coding session into one summary of the whole session.
Input: each part's goal, what was done and AI involvement, in order and labelled with its work period, then numbered candidate decisions (D), rejected approaches (R) and follow-ups (F) collected from all parts, each labelled with the part it came from.

Return ONLY JSON matching this schema: {schema}

Rules:
- "goal" and "whatWasDone" must cover every work period, weighted by how much work each took, not just the last one.
- "goal": one sentence on what the developer set out to do across the whole session.
- "whatWasDone": 2–5 plain sentences on what changed and why, covering every part from the earliest to the latest.
- "decisionIds", "rejectedApproachIds", "followUpIds": choose at most 6 ids from each candidate list, keeping the most durable and important ones (what a teammate would still need to know later). Include at least one id from each part that has candidates in that list; when more than 6 parts do, at least one from each work period. When several candidates say the same thing, choose only one of them. Use only ids from the matching list.
- "aiInvolvement": light = Q&A/explanations, moderate = AI wrote parts, heavy = AI wrote most of the change.
- Write about the session's work only: never mention the transcript, its parts, the metadata, summarising, or a team log.
- Don't invent anything that isn't in the part summaries. Don't include code, secrets, or redaction placeholders.`;

export function mergeSystemPrompt(): string {
  return MERGE.replace('{schema}', JSON.stringify(z.toJSONSchema(MergeSchema), null, 2));
}

export interface MergeInput {
  /** In session order; `period` is the 1-based work period each part belongs to. */
  parts: { goal: string; whatWasDone: string; aiInvolvement: string; period: number }[];
  /** `part` is the 1-based part each candidate came from. */
  decisions: { id: string; part: number; decision: string; reason: string }[];
  rejectedApproaches: { id: string; part: number; approach: string; reason: string }[];
  followUps: { id: string; part: number; text: string }[];
}

export function mergeMessage({ parts, decisions, rejectedApproaches, followUps }: MergeInput): string {
  const list = (items: string[]) => (items.length ? items.join('\n') : '(none)');
  const periods = Math.max(...parts.map((p) => p.period));
  const header = (p: MergeInput['parts'][number], i: number) => `Part ${i + 1} of ${parts.length}${periods > 1 ? ` (work period ${p.period} of ${periods})` : ''}`;
  return [
    ...parts.map((p, i) => `${header(p, i)}:\nGoal: ${p.goal}\nWhat was done: ${p.whatWasDone}\nAI involvement: ${p.aiInvolvement}`),
    `Candidate decisions:\n${list(decisions.map((d) => `${d.id} (part ${d.part}): ${d.decision} (reason: ${d.reason})`))}`,
    `Candidate rejected approaches:\n${list(rejectedApproaches.map((r) => `${r.id} (part ${r.part}): ${r.approach} (reason: ${r.reason})`))}`,
    `Candidate follow-ups:\n${list(followUps.map((f) => `${f.id} (part ${f.part}): ${f.text}`))}`,
  ].join('\n\n');
}
