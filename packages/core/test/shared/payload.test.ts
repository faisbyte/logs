import { describe, expect, it } from 'vitest';
import { approve, uploadPayload } from '../../src/review/approval.js';
import { UploadPayloadSchema, validatePush } from '../../src/shared/payload.js';
import { draftSummary } from '../review/helpers.js';

const payload = () => uploadPayload(approve(draftSummary(), { now: new Date('2026-10-29T12:00:00.000Z') }));
// Assembled at runtime so no literal secret sits in the source (fake values).
const fakeGithub = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const fakeAws = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

describe('UploadPayloadSchema', () => {
  it('accepts exactly what uploadPayload() returns', () => {
    expect(UploadPayloadSchema.parse(payload())).toEqual(payload());
  });

  it('carries where each ticket key came from, and only for keys in ticketRefs', () => {
    const withSources = uploadPayload(approve(draftSummary({ ticketRefs: ['PROJ-142', 'PROJ-7'], ticketSources: { 'PROJ-142': 'branch', 'PROJ-7': 'commit' } })));
    expect(withSources.ticketSources).toEqual({ 'PROJ-142': 'branch', 'PROJ-7': 'commit' });
    expect(validatePush({ ...withSources, ticketSources: { 'OPS-1': 'manual' } })).toMatchObject({ ok: false, errors: [expect.stringMatching(/ticketSources: OPS-1 is not in ticketRefs/)] });
    expect(validatePush({ ...withSources, ticketSources: { 'PROJ-7': 'api' } })).toMatchObject({ ok: false });
  });

  it('accepts a payload without ticket sources, from a client older than Phase 6', () => {
    const { ticketSources: _, ...older } = payload();
    expect(validatePush(older)).toMatchObject({ ok: true });
  });
});

describe('validatePush (server side)', () => {
  it('accepts a payload from uploadPayload()', () => {
    expect(validatePush(payload())).toEqual({ ok: true, payload: payload() });
  });

  it('rejects extra fields, missing fields and an unapproved payload', () => {
    expect(validatePush({ ...payload(), transcript: [] })).toMatchObject({ ok: false, errors: [expect.stringMatching(/transcript/)] });
    const { goal: _goal, ...noGoal } = payload();
    expect(validatePush(noGoal)).toMatchObject({ ok: false, errors: [expect.stringMatching(/goal/)] });
    expect(validatePush({ ...payload(), approvedAt: null })).toMatchObject({ ok: false });
    expect(validatePush('not an object')).toMatchObject({ ok: false });
  });

  it.each([
    ['transcript role lines', 'USER: add rate limiting\nASSISTANT: sure, reading login.ts'],
    ['condensed tool lines', 'Done.\nTOOL Bash: pnpm test (exit 0)'],
    ['JSONL session events', '{"type":"assistant","message":{"role":"assistant","content":[]}}'],
    ['a field far longer than a summary', 'word '.repeat(2_000)],
  ])('rejects anything resembling a raw transcript: %s', (_label, text) => {
    const result = validatePush({ ...payload(), whatWasDone: text });
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/^whatWasDone: /)] });
  });

  it('rejects text the secret detectors match, naming the field and type but never the value', () => {
    const result = validatePush({ ...payload(), risksOrFollowUps: [`Rotate ${fakeGithub}`], decisions: [{ decision: `Use key ${fakeAws}`, reason: 'x' }] });
    expect(result).toEqual({ ok: false, errors: ['decisions.0.decision: contains a secret (aws_key)', 'risksOrFollowUps.0: contains a secret (github_token)'] });
    expect(JSON.stringify(result)).not.toContain(fakeGithub);
  });

  it('accepts text that was already redacted on the client', () => {
    expect(validatePush({ ...payload(), goal: 'Rotate [REDACTED:github_token] after the leak.' })).toMatchObject({ ok: true });
  });
});
