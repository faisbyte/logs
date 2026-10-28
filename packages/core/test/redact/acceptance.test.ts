import { describe, expect, it } from 'vitest';
import { redactSession } from '../../src/redact/session.js';
import { redactText } from '../../src/redact/text.js';
import { corpus } from './corpus.js';
import { sessionWith } from './helpers.js';

// Every 16-char window of each secret piece: catches partial redaction, not just whole-value survival.
const fragments = (secret: string) =>
  secret
    .split(/\s+/)
    .filter((piece) => piece.length >= 16)
    .flatMap((piece) => Array.from({ length: piece.length - 15 }, (_, i) => piece.slice(i, i + 16)));

// The test that defines "done" for Phase 2: no original secret value survives anywhere.
describe('fake-secret corpus', () => {
  it.each(corpus.map((e) => [e.type, e]))('leaves no %s value in any context', (_type, entry) => {
    for (const context of entry.contexts) {
      const { text } = redactText(context);
      expect(text).not.toContain(entry.secret);
      for (const fragment of fragments(entry.secret)) expect(text).not.toContain(fragment);
      expect(text).toContain(`[REDACTED:${entry.type}]`);
    }
  });
});

describe('fake-secret corpus in sessions', () => {
  it.each(corpus.map((e) => [e.type, e]))('leaves no %s value in any field of a redacted session', (_type, entry) => {
    for (const context of entry.contexts) {
      const json = JSON.stringify(redactSession(sessionWith(context)).session);
      expect(json).not.toContain(JSON.stringify(entry.secret).slice(1, -1));
      for (const fragment of fragments(entry.secret)) expect(json).not.toContain(JSON.stringify(fragment).slice(1, -1));
    }
  });
});
