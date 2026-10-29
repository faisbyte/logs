import { describe, expect, it } from 'vitest';
import { approve, assertApprovedSummary, isApprovedSummary, reject, reopen, uploadPayload, verifyApproval, type ApprovedSummary } from '../../src/review/approval.js';
import { draftSummary } from './helpers.js';

const now = new Date('2026-10-29T12:00:00.000Z');

describe('approve', () => {
  it('turns a draft into an ApprovedSummary, recording who approved it and when', () => {
    const approved = approve(draftSummary(), { now });
    expect(isApprovedSummary(approved)).toBe(true);
    expect(approved.summary).toMatchObject({ status: 'approved', approvedAt: '2026-10-29T12:00:00.000Z', approvedBy: 'developer' });
    expect(approved.summary.approvalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks auto-approvals as such', () => {
    expect(approve(draftSummary(), { now, by: 'auto' }).summary.approvedBy).toBe('auto');
  });

  it('only approves drafts: a rejected summary must be reopened first', () => {
    const rejected = reject(draftSummary(), { now });
    expect(() => approve(rejected, { now })).toThrow(/rejected.*reopen/);
    expect(() => approve(approve(draftSummary(), { now }).summary, { now })).toThrow(/already approved/);
  });

  it('freezes the approved summary, so it cannot be edited after approval', () => {
    const approved = approve(draftSummary(), { now });
    expect(() => {
      (approved.summary as { goal: string }).goal = 'changed';
    }).toThrow(TypeError);
    expect(() => (approved.summary.decisions as unknown[]).push({ decision: 'x', reason: 'y' })).toThrow(TypeError);
  });
});

describe('reject and reopen', () => {
  it('rejects a draft', () => {
    expect(reject(draftSummary(), { now })).toMatchObject({ status: 'rejected', approvedAt: null, approvedBy: null });
  });

  it('only rejects drafts', () => {
    expect(() => reject(approve(draftSummary(), { now }).summary, { now })).toThrow(/approved.*reopen/);
  });

  it('puts an approved or rejected summary back to draft, clearing the approval', () => {
    for (const summary of [approve(draftSummary(), { now }).summary, reject(draftSummary(), { now })]) {
      expect(reopen(summary)).toMatchObject({ status: 'draft', approvedAt: null, approvedBy: null, approvalHash: null });
    }
  });

  it('refuses to reopen a summary that has already been pushed', () => {
    const pushed = { ...approve(draftSummary(), { now }).summary, pushedAt: '2026-10-30T00:00:00.000Z' };
    expect(() => reopen(pushed)).toThrow(/already pushed/);
  });
});

describe('verifyApproval', () => {
  it('re-checks a stored approval read back from disk', () => {
    const stored = JSON.parse(JSON.stringify(approve(draftSummary(), { now }).summary));
    expect(isApprovedSummary(verifyApproval(stored))).toBe(true);
  });

  it('refuses drafts, rejected summaries and hand-edited "approved" ones', () => {
    const stored = JSON.parse(JSON.stringify(approve(draftSummary(), { now }).summary));
    expect(() => verifyApproval(draftSummary())).toThrow(/not approved/);
    expect(() => verifyApproval(reject(draftSummary(), { now }))).toThrow(/not approved/);
    expect(() => verifyApproval({ ...draftSummary(), status: 'approved' })).toThrow(/not approved/);
    expect(() => verifyApproval({ ...stored, goal: 'Changed after approval.' })).toThrow(/changed after it was approved/);
  });
});

describe('uploadPayload (the only way summaries leave the machine, Phase 5)', () => {
  it('returns only the shared fields plus identity and approval details', () => {
    const payload = uploadPayload(approve(draftSummary(), { now }));
    expect(Object.keys(payload).sort()).toEqual(
      ['agent', 'aiInvolvement', 'approvedAt', 'approvedBy', 'branch', 'decisions', 'editedByDeveloper', 'endedAt', 'filesTouched', 'goal', 'outcome', 'rejectedApproaches', 'risksOrFollowUps', 'sessionId', 'startedAt', 'ticketRefs', 'whatWasDone'].sort(),
    );
  });

  it('throws for anything that is not an ApprovedSummary, even when forced through the type system', () => {
    const draft = draftSummary();
    expect(() => uploadPayload(draft as unknown as ApprovedSummary)).toThrow(/approved/);
    expect(() => uploadPayload({ summary: { ...draft, status: 'approved' } } as unknown as ApprovedSummary)).toThrow(/approved/);
    expect(() => uploadPayload({ ...approve(draft, { now }) } as ApprovedSummary)).toThrow(/approved/);
    expect(() => assertApprovedSummary(reject(draft))).toThrow(/approved/);
  });
});
