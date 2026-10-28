import { z } from 'zod';
import type { RedactedSession } from '../redact/session.js';
import { AgentSchema } from '../schema.js';

// Strict objects: structured outputs require additionalProperties: false, and the model must not be
// able to add fields (files, tickets, branch, timestamps come from parsed metadata).

const text = z.string().min(1);

export const LlmSummarySchema = z.strictObject({
  goal: text,
  outcome: z.enum(['completed', 'partial', 'abandoned']),
  whatWasDone: text,
  decisions: z.array(z.strictObject({ decision: text, reason: z.string() })),
  rejectedApproaches: z.array(z.strictObject({ approach: text, reason: z.string() })),
  risksOrFollowUps: z.array(text),
  aiInvolvement: z.enum(['light', 'moderate', 'heavy']),
  /** Ids of decisions from earlier parts of a long session that this part reverses. */
  reversedDecisions: z.array(z.strictObject({ id: z.string(), reason: z.string() })),
});
export type LlmSummary = z.infer<typeof LlmSummarySchema>;

/** Merge of a session summarised in parts: a whole-session narrative plus at most 6 candidate ids per list. */
export const MAX_MERGED_ITEMS = 6;
const picks = z.array(z.string()).max(MAX_MERGED_ITEMS);
export const MergeSchema = z.strictObject({
  goal: LlmSummarySchema.shape.goal,
  whatWasDone: LlmSummarySchema.shape.whatWasDone,
  aiInvolvement: LlmSummarySchema.shape.aiInvolvement,
  decisionIds: picks,
  rejectedApproachIds: picks,
  followUpIds: picks,
});
export type Merge = z.infer<typeof MergeSchema>;

/** Checks a schema can't express: no code blocks and no redaction placeholders anywhere. */
export function postCheck(summary: object): string[] {
  const issues: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (value.includes('```')) issues.push(`${path} contains a code block`);
      if (value.includes('[REDACTED:')) issues.push(`${path} contains a redaction placeholder`);
    } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
  };
  visit(summary, '');
  return issues;
}

const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
export const ticketRefsFrom = (branches: readonly string[]) => [...new Set(branches.flatMap((b) => b.match(TICKET) ?? []))];

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  agent: AgentSchema,
  status: z.enum(['draft', 'approved', 'rejected']),
  goal: z.string(),
  outcome: LlmSummarySchema.shape.outcome,
  whatWasDone: z.string(),
  decisions: LlmSummarySchema.shape.decisions,
  rejectedApproaches: LlmSummarySchema.shape.rejectedApproaches,
  risksOrFollowUps: z.array(z.string()),
  aiInvolvement: LlmSummarySchema.shape.aiInvolvement,
  // From parsed metadata, never from the model:
  filesTouched: z.array(z.string()),
  ticketRefs: z.array(z.string()),
  branch: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  editedByDeveloper: z.boolean(),
  approvedAt: z.string().nullable(),
  generatedAt: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  usage: UsageSchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export function buildSessionSummary(
  llm: LlmSummary,
  redacted: RedactedSession,
  meta: { model: string; promptVersion: string; generatedAt: string; usage: Usage },
): SessionSummary {
  const s = redacted.session;
  const rel = (p: string) => (p.startsWith(`${s.cwd}/`) ? p.slice(s.cwd.length + 1) : p);
  return {
    sessionId: s.sourceSessionId,
    agent: s.agent,
    status: 'draft',
    // Copied field by field: nothing else the model returns can reach the summary.
    goal: llm.goal,
    outcome: llm.outcome,
    whatWasDone: llm.whatWasDone,
    decisions: llm.decisions.map(({ decision, reason }) => ({ decision, reason })),
    rejectedApproaches: llm.rejectedApproaches.map(({ approach, reason }) => ({ approach, reason })),
    risksOrFollowUps: [...llm.risksOrFollowUps],
    aiInvolvement: llm.aiInvolvement,
    filesTouched: s.filesTouched.map(rel),
    ticketRefs: ticketRefsFrom(s.gitBranches),
    branch: s.gitBranch,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    editedByDeveloper: false,
    approvedAt: null,
    generatedAt: meta.generatedAt,
    promptVersion: meta.promptVersion,
    model: meta.model,
    usage: meta.usage,
  };
}
