import { z } from 'zod';
import { LlmSummarySchema } from './schema.js';

// Bump on any change to the text below or to the schema: it is part of the summary cache key.
export const PROMPT_VERSION = 'summarize-v1';

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
- Transcript lines: "USER:" is the developer, "ASSISTANT:" is the coding agent, "TOOL <name> <paths>" is a tool call ("(rejected by user)" and "(failed)" mark calls that did not go through), "[user interrupted]" means the developer stopped the agent. Tool output is not included. Placeholders like [REDACTED:...] hide secrets; never repeat them.
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
