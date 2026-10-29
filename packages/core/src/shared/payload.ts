import { z } from 'zod';
import { createRedactor } from '../redact/text.js';
import type { PlaceholderType } from '../redact/types.js';
import { LlmSummarySchema, TicketSourceSchema } from '../summarize/schema.js';
import { AgentSchema } from '../schema.js';

// What a push carries (DECISIONS.md D34, D40): exactly uploadPayload()'s output. The receiving side validates
// it with this same schema and refuses anything else, as a second line of defence after the client.

const text = (max: number) => z.string().min(1).max(max);
const reason = z.string().max(1_000);
const list = <T extends z.ZodType>(item: T, max = 50) => z.array(item).max(max);

export const UploadPayloadSchema = z
  .strictObject({
  sessionId: text(200),
  agent: AgentSchema,
  editedByDeveloper: z.boolean(),
  approvedAt: z.iso.datetime(),
  approvedBy: z.enum(['developer', 'auto']),
  goal: text(1_000),
  outcome: LlmSummarySchema.shape.outcome,
  whatWasDone: text(3_000),
  decisions: list(z.strictObject({ decision: text(1_000), reason })),
  rejectedApproaches: list(z.strictObject({ approach: text(1_000), reason })),
  risksOrFollowUps: list(text(1_000)),
  aiInvolvement: LlmSummarySchema.shape.aiInvolvement,
  filesTouched: list(text(500), 1_000),
  ticketRefs: list(text(100)),
  /** Optional so pushes from clients older than Phase 6 still validate. */
  ticketSources: z.record(text(100), TicketSourceSchema).default({}),
  branch: text(500).nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
})
  .superRefine((p, ctx) => {
    for (const key of Object.keys(p.ticketSources)) {
      if (!p.ticketRefs.includes(key)) ctx.addIssue({ code: 'custom', path: ['ticketSources'], message: `${key} is not in ticketRefs` });
    }
  });
export type UploadPayload = z.infer<typeof UploadPayloadSchema>;

// Markers of session content rather than a summary: condensed-transcript lines and raw JSONL events.
const TRANSCRIPT = [/^(USER|ASSISTANT):/m, /^TOOL \S/m, /"(type|role)"\s*:\s*"(user|assistant|tool_use|tool_result|response_item|event_msg|session_meta)"/];
// Secrets only: PII and paths depend on the developer's own settings, which the receiving side can't know.
const NOT_SECRETS = new Set<PlaceholderType>(['email', 'phone', 'username', 'home_dir', 'deny_list']);
const detect = createRedactor({ pii: { email: false, phone: false }, home: false });

function strings(value: unknown, path: string[] = []): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path: path.join('.'), text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, String(i)]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
}

export type PushValidation = { ok: true; payload: UploadPayload } | { ok: false; errors: string[] };

/** Validates an incoming push. Errors name the field and the problem, never the matched value. */
export function validatePush(input: unknown): PushValidation {
  const parsed = UploadPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(payload)'}: ${i.message}`) };
  const errors: string[] = [];
  for (const { path, text } of strings(parsed.data)) {
    if (TRANSCRIPT.some((re) => re.test(text))) errors.push(`${path}: looks like raw transcript content`);
    const secrets = (Object.keys(detect(text).counts) as PlaceholderType[]).filter((t) => !NOT_SECRETS.has(t));
    for (const type of secrets) errors.push(`${path}: contains a secret (${type})`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, payload: parsed.data };
}
