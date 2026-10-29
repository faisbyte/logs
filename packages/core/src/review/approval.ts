import { createHash } from 'node:crypto';
import type { DeepReadonly } from '../redact/session.js';
import { UploadPayloadSchema, type UploadPayload } from '../shared/payload.js';
import type { SessionSummary } from '../summarize/schema.js';

// The only way to get an ApprovedSummary is approve(), or verifyApproval() re-checking an approval that
// approve() recorded (DECISIONS.md D34). Upload code takes an ApprovedSummary and goes through uploadPayload().

export class ReviewError extends Error {}

/** What the team sees once a summary is pushed. Everything else (usage, model, prompt, transcript) stays local. */
export const SHARED_FIELDS = [
  'goal',
  'outcome',
  'whatWasDone',
  'decisions',
  'rejectedApproaches',
  'risksOrFollowUps',
  'aiInvolvement',
  'filesTouched',
  'ticketRefs',
  'branch',
  'startedAt',
  'endedAt',
] as const;

const IDENTITY_FIELDS = ['sessionId', 'agent', 'editedByDeveloper', 'approvedAt', 'approvedBy'] as const;


const pick = <K extends keyof SessionSummary>(summary: SessionSummary, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, summary[k]])) as Pick<SessionSummary, K>;
const sharedHash = (summary: SessionSummary) => createHash('sha256').update(JSON.stringify(pick(summary, SHARED_FIELDS))).digest('hex');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class ApprovedSummary {
  readonly #brand = true;
  readonly summary: DeepReadonly<SessionSummary>;

  constructor(summary: SessionSummary) {
    this.summary = deepFreeze(structuredClone(summary));
    Object.freeze(this);
  }

  static isInstance(value: unknown): value is ApprovedSummary {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}
export type { ApprovedSummary };

export const isApprovedSummary = (value: unknown): value is ApprovedSummary => ApprovedSummary.isInstance(value);

/** Hard check for upload code: throws, so a forced cast can't push an unapproved summary. */
export function assertApprovedSummary(value: unknown): asserts value is ApprovedSummary {
  if (!isApprovedSummary(value) || value.summary.status !== 'approved') {
    throw new ReviewError('Refusing to upload: expected an ApprovedSummary from approve(). Only approved summaries can leave this machine.');
  }
}

/** draft → approved. The only function that approves. */
export function approve(summary: SessionSummary, { now = new Date(), by = 'developer' }: { now?: Date; by?: 'developer' | 'auto' } = {}): ApprovedSummary {
  if (summary.status === 'approved') throw new ReviewError(`${summary.sessionId} is already approved.`);
  if (summary.status === 'rejected') throw new ReviewError(`${summary.sessionId} was rejected; reopen it before approving.`);
  return new ApprovedSummary({ ...summary, status: 'approved', approvedAt: now.toISOString(), approvedBy: by, approvalHash: sharedHash(summary) });
}

/** Re-checks an approval read back from disk: still approved, and nothing shared has changed since. */
export function verifyApproval(summary: SessionSummary): ApprovedSummary {
  if (summary.status !== 'approved' || !summary.approvedAt || !summary.approvedBy || !summary.approvalHash) {
    throw new ReviewError(`${summary.sessionId} is not approved.`);
  }
  if (summary.approvalHash !== sharedHash(summary)) throw new ReviewError(`${summary.sessionId} changed after it was approved; reopen and approve it again.`);
  return new ApprovedSummary(summary);
}

/** draft → rejected. Rejected summaries are never uploaded and never re-summarised automatically. */
export function reject(summary: SessionSummary): SessionSummary {
  if (summary.status === 'approved') throw new ReviewError(`${summary.sessionId} is approved; reopen it before rejecting.`);
  if (summary.status === 'rejected') throw new ReviewError(`${summary.sessionId} is already rejected.`);
  return { ...summary, status: 'rejected' };
}

/** approved or rejected → draft, as long as nothing has been pushed. */
export function reopen(summary: SessionSummary): SessionSummary {
  if (summary.pushedAt) throw new ReviewError(`${summary.sessionId} was already pushed; it can't go back to draft.`);
  if (summary.status === 'draft') throw new ReviewError(`${summary.sessionId} is already a draft.`);
  return { ...summary, status: 'draft', approvedAt: null, approvedBy: null, approvalHash: null };
}

/** The payload a push sends. Takes only an ApprovedSummary, checks it again at runtime, and fits the shared schema. */
export function uploadPayload(approved: ApprovedSummary): Readonly<UploadPayload> {
  assertApprovedSummary(approved);
  const summary = approved.summary as SessionSummary;
  verifyApproval(summary);
  return deepFreeze(UploadPayloadSchema.parse({ ...pick(summary, IDENTITY_FIELDS), ...pick(summary, SHARED_FIELDS) }));
}
