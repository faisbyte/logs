import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/redact/text.js';
import { pick } from './corpus.js';

const awsKey = `AKIA${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`;

describe('redactText', () => {
  it('returns text without secrets unchanged', () => {
    expect(redactText('Add rate limiting to the login endpoint.')).toEqual({ text: 'Add rate limiting to the login endpoint.', counts: {} });
  });

  describe('aws_key', () => {
    it('replaces an AWS access key id with a typed placeholder and counts it', () => {
      expect(redactText(`key ${awsKey} here`)).toEqual({ text: 'key [REDACTED:aws_key] here', counts: { aws_key: 1 } });
    });

    it('recognises the other AWS key id prefixes', () => {
      expect(redactText(`ASIA${awsKey.slice(4)}`).text).toBe('[REDACTED:aws_key]');
    });

    it('does not match AKIA inside a longer word', () => {
      const text = `XAKIA${awsKey.slice(4)}Y`;
      expect(redactText(text).text).toBe(text);
    });
  });
});
