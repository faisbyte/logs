import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { RedactedText } from '../redact/text.js';
import type { RedactionCounts } from '../redact/types.js';
import { LlmSummarySchema, type SessionSummary } from '../summarize/schema.js';
import { shortSessionId } from '../periods.js';
import { ReviewError, SHARED_FIELDS } from './approval.js';

// Developers edit a summary as YAML in $EDITOR (DECISIONS.md D35). Every text field, outcome, AI involvement
// and ticket refs can change; filesTouched entries can only be removed. Edited text is redacted again.

const text = z.string().trim().min(1, 'must not be empty');
export const EditableSchema = z.strictObject({
  goal: text,
  outcome: LlmSummarySchema.shape.outcome,
  whatWasDone: text,
  decisions: z.array(z.strictObject({ decision: text, reason: z.string() })),
  rejectedApproaches: z.array(z.strictObject({ approach: text, reason: z.string() })),
  risksOrFollowUps: z.array(text),
  aiInvolvement: LlmSummarySchema.shape.aiInvolvement,
  ticketRefs: z.array(z.string().regex(/^\S+$/, 'ticket refs are single words such as PROJ-142')),
  filesTouched: z.array(z.string().min(1)),
});
type Editable = z.infer<typeof EditableSchema>;

const editable = (s: SessionSummary): Editable => ({
  goal: s.goal,
  outcome: s.outcome,
  whatWasDone: s.whatWasDone,
  decisions: s.decisions.map(({ decision, reason }) => ({ decision, reason })),
  rejectedApproaches: s.rejectedApproaches.map(({ approach, reason }) => ({ approach, reason })),
  risksOrFollowUps: [...s.risksOrFollowUps],
  aiInvolvement: s.aiInvolvement,
  ticketRefs: [...s.ticketRefs],
  filesTouched: [...s.filesTouched],
});

const ERROR_PREFIX = '# ERROR: ';

export function toEditable(summary: SessionSummary): string {
  const header = [
    `# Editing the summary of ${summary.agent} session ${shortSessionId(summary.sessionId)} (branch ${summary.branch ?? 'unknown'}, ${summary.startedAt.slice(0, 10)}).`,
    '# Save and close the editor to apply your changes.',
    '# Close the editor without saving to change nothing.',
    `# Shared with the team once pushed: ${SHARED_FIELDS.join(', ')}.`,
    '# Allowed values: outcome is completed, partial or abandoned; aiInvolvement is light, moderate or heavy.',
    '# filesTouched: you can delete entries, but not add new ones.',
  ];
  return `${header.join('\n')}\n\n${stringify(editable(summary), { lineWidth: 100 })}`;
}

const assertDraft = (summary: SessionSummary) => {
  if (summary.status !== 'draft') throw new ReviewError(`${summary.sessionId} is ${summary.status}; reopen it before editing.`);
};

export type EditResult = { summary: SessionSummary; changed: boolean; redactions: RedactionCounts } | { errors: string[] };

/** Validates an edited YAML file against the original summary and redacts every string in it again. */
export function parseEdit(original: SessionSummary, yaml: string, redact: (text: string) => RedactedText): EditResult {
  assertDraft(original);
  const doc = parseDocument(yaml, { prettyErrors: true });
  if (doc.errors.length) return { errors: doc.errors.map((e) => e.message.split('\n')[0]!) };

  const parsed = EditableSchema.safeParse(doc.toJS());
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`) };
  const added = parsed.data.filesTouched.filter((f) => !original.filesTouched.includes(f));
  if (added.length) return { errors: added.map((f) => `filesTouched: ${f} is not one of the session's files; entries can only be removed`) };

  const redactions: RedactionCounts = {};
  const clean = (value: string) => {
    const result = redact(value);
    for (const [type, n] of Object.entries(result.counts) as [keyof RedactionCounts, number][]) redactions[type] = (redactions[type] ?? 0) + n;
    return result.text;
  };
  const e = parsed.data;
  const edited: Editable = {
    ...e,
    goal: clean(e.goal),
    whatWasDone: clean(e.whatWasDone),
    decisions: e.decisions.map((d) => ({ decision: clean(d.decision), reason: clean(d.reason) })),
    rejectedApproaches: e.rejectedApproaches.map((r) => ({ approach: clean(r.approach), reason: clean(r.reason) })),
    risksOrFollowUps: e.risksOrFollowUps.map(clean),
    ticketRefs: [...new Set(e.ticketRefs.map(clean))],
    filesTouched: [...new Set(e.filesTouched)],
  };

  if (JSON.stringify(edited) === JSON.stringify(editable(original))) return { summary: original, changed: false, redactions };
  // Keys added here are manual links; the rest keep the source they had.
  const ticketSources = Object.fromEntries(
    edited.ticketRefs.flatMap((key) => (original.ticketRefs.includes(key) ? (original.ticketSources[key] ? [[key, original.ticketSources[key]]] : []) : [[key, 'manual' as const]])),
  );
  return { summary: { ...original, ...edited, ticketSources, editedByDeveloper: true }, changed: true, redactions };
}

const withErrors = (yaml: string, errors: string[]) =>
  [...errors.map((e) => `${ERROR_PREFIX}${e}`), '# Fix the errors above, then save and close. Close without saving to cancel the edit.', '', yaml.split('\n').filter((l) => !l.startsWith(ERROR_PREFIX) && !l.startsWith('# Fix the errors above')).join('\n').replace(/^\n+/, '')].join('\n');

/**
 * Opens the summary in an editor until it is valid or the developer gives up. `open` returns the saved text,
 * or null when the editor was closed without saving; a file saved unchanged also counts as cancelled.
 */
export async function editSummary(
  original: SessionSummary,
  open: (text: string) => Promise<string | null>,
  redact: (text: string) => RedactedText,
): Promise<Exclude<EditResult, { errors: string[] }> | { cancelled: true }> {
  assertDraft(original);
  let text = toEditable(original);
  for (;;) {
    const saved = await open(text);
    if (saved === null || saved === text) return { cancelled: true };
    const result = parseEdit(original, saved, redact);
    if (!('errors' in result)) return result;
    text = withErrors(saved, result.errors);
  }
}
