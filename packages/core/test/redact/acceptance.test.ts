import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/redact/text.js';
import { corpus } from './corpus.js';

// The test that defines "done" for Phase 2: no original secret value survives anywhere.
describe('fake-secret corpus', () => {
  it.each(corpus.map((e) => [e.type, e]))('leaves no %s value in any context', (_type, entry) => {
    for (const context of entry.contexts) {
      const { text } = redactText(context);
      expect(text).not.toContain(entry.secret);
      expect(text).toContain(`[REDACTED:${entry.type}]`);
    }
  });
});
