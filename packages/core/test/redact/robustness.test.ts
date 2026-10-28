import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRET_DETECTORS } from '../../src/redact/detectors.js';
import { redactSession } from '../../src/redact/session.js';
import { createRedactor, redactText } from '../../src/redact/text.js';
import type { ParsedSession } from '../../src/schema.js';
import { base62 } from './corpus.js';
import { base, sessionWith } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('failing closed', () => {
  it('replaces the whole string when a detector throws, instead of throwing or passing text through', () => {
    vi.spyOn(SECRET_DETECTORS[0]!, 'find').mockImplementation(() => {
      throw new Error('detector bug');
    });
    expect(redactText(`plain text with ghp_${base62(36)}`)).toEqual({ text: '[REDACTED:unscannable]', counts: { unscannable: 1 } });
  });

  it('marks every string unscannable in a session when a detector throws', () => {
    vi.spyOn(SECRET_DETECTORS[0]!, 'find').mockImplementation(() => {
      throw new Error('detector bug');
    });
    const { session, counts } = redactSession(sessionWith('anything'));
    expect(counts).toEqual({ unscannable: 18 });
    expect(JSON.stringify(session)).not.toContain('anything');
  });
});

describe('odd input', () => {
  it.each([
    ['empty', ''],
    ['lone surrogates', '\uD800 and \uDFFF'],
    ['NUL and control characters', 'a\u0000b\u0007c\u001b[31m'],
    ['emoji and right-to-left text', '🔑 مفتاح 🔐'],
    ['a 1 MB random token', base62(1_000_000)],
  ])('never throws on %s', (_label, text) => {
    expect(() => redactText(text)).not.toThrow();
    expect(typeof redactText(text).text).toBe('string');
  });

  it('never throws on a session with cycles or non-string values', () => {
    const odd = { ...sessionWith('x'), extra: [null, 1, true, undefined, { nested: ['deep'] }] } as unknown as ParsedSession & { self?: unknown };
    odd.self = odd;
    expect(() => redactSession(odd)).not.toThrow();
  });

  it('is deterministic across repeated calls on one redactor', () => {
    const redact = createRedactor({ deny: [{ regex: 'Falcon\\d+' }] });
    const text = `Falcon42 GITHUB_TOKEN=ghp_${base62(36)} dev@example.org ${base62(40)}`;
    const first = redact(text);
    expect(redact(text)).toEqual(first);
    expect(redact(text)).toEqual(first);
    expect(redactSession(base)).toEqual(redactSession(base));
  });
});

describe('pathological input', () => {
  const N = 200_000;
  it.each([
    ['PEM headers without END', '-----BEGIN PUBLIC KEY-----\n'.repeat(N / 27)],
    ['a long BEGIN label', `-----BEGIN ${'A '.repeat(N / 2)}`],
    ['repeated secret-key words in one token', 'secret'.repeat(N / 6)],
    ['repeated assignments', 'password='.repeat(N / 9)],
    ['dash-joined JWT prefixes', 'eyJ-'.repeat(N / 4)],
    ['a long local part before @', `${'a'.repeat(N)}@`],
    ['repeated phone prefixes', '+1 '.repeat(N / 3)],
    ['long digit runs', '0'.repeat(N)],
    ['repeated URL schemes', 'a://b:'.repeat(N / 6)],
    ['dashes at line start', `${'-'.repeat(N)}token: x`],
    ['1 MB of unterminated public PEM headers', '-----BEGIN PUBLIC KEY-----\n'.repeat((5 * N) / 27)],
    ['thousands of short emails', 'a@b.cc '.repeat(N / 7)],
    ['1 MB of complete small certificates', '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n'.repeat((5 * N) / 61)],
  ])('finishes %s quickly', (_label, text) => {
    const started = performance.now();
    redactText(text);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
