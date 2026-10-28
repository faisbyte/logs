import { describe, expect, it } from 'vitest';
import { assertRedactedSession, isRedactedSession, redactSession, type RedactedSession } from '../../src/redact/session.js';
import { ParsedSessionSchema, type ParsedSession } from '../../src/schema.js';
import { base62 } from './corpus.js';
import { base, sessionWith } from './helpers.js';

const token = `ghp_${base62(36)}`;

describe('redactSession', () => {
  it('redacts a secret in every text field', () => {
    const { session } = redactSession(sessionWith(`see ${token} now`));
    const strings: string[] = [];
    JSON.stringify(session, (_k, v) => (typeof v === 'string' && strings.push(v), v));
    expect(JSON.stringify(session)).not.toContain(token);
    const free = strings.filter((s) => s.includes('see '));
    expect(free).toHaveLength(23);
    expect(free.every((s) => s === 'see [REDACTED:github_token] now')).toBe(true);
  });

  it('keeps structural fields, so the result is still a valid ParsedSession', () => {
    const { session } = redactSession(sessionWith(`see ${token} now`));
    expect(ParsedSessionSchema.safeParse(session).success).toBe(true);
    expect(session.agent).toBe('claude-code');
    expect(session.startedAt).toBe(base.startedAt);
    expect(session.transcript.map((e) => e.kind)).toEqual(['user', 'assistant', 'reasoning', 'tool', 'interruption']);
  });

  it('scans structural fields that do not hold their expected format', () => {
    const odd = { ...sessionWith('x'), startedAt: token, agent: token } as unknown as ParsedSession;
    const json = JSON.stringify(redactSession(odd).session);
    expect(json).not.toContain(token);
  });

  it('counts replacements across the whole session', () => {
    expect(redactSession(sessionWith(`see ${token} now`)).counts).toEqual({ github_token: 23 });
  });

  it('applies options everywhere', () => {
    const { session, counts } = redactSession(sessionWith('Project Falcon'), { deny: ['Project Falcon'] });
    expect(counts).toEqual({ deny_list: 23 });
    expect(JSON.stringify(session)).not.toContain('Falcon');
  });

  it('does not modify its input', () => {
    const input = sessionWith(`see ${token} now`);
    const copy = structuredClone(input);
    redactSession(input);
    expect(input).toEqual(copy);
  });

  it('is deterministic', () => {
    expect(redactSession(base).session).toEqual(redactSession(base).session);
  });

  it('returns a deeply frozen session so redacted text cannot be swapped back', () => {
    const { session } = redactSession(sessionWith(`see ${token} now`));
    expect(() => {
      (session as { title: string }).title = token;
    }).toThrow(TypeError);
    expect(() => {
      (session.transcript[0] as { text: string }).text = token;
    }).toThrow(TypeError);
  });

  it('recognises only real redaction results', () => {
    const redacted = redactSession(base);
    expect(isRedactedSession(redacted)).toBe(true);
    expect(isRedactedSession(base)).toBe(false);
    expect(isRedactedSession({ ...redacted })).toBe(false);
    expect(isRedactedSession({ session: base, counts: {} })).toBe(false);
  });

  it('assertRedactedSession throws on anything but a real redaction result, including forced casts', () => {
    expect(() => assertRedactedSession(redactSession(base))).not.toThrow();
    for (const fake of [base, { ...redactSession(base) }, { session: base, counts: {} }, null, 'text']) {
      expect(() => assertRedactedSession(fake as unknown as RedactedSession)).toThrow(/unredacted/);
    }
  });
});
