import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/redact/text.js';
import { base62, base64url, jwt, pem, pick } from './corpus.js';

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

  describe('aws_secret', () => {
    const secret = pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 40);

    it('redacts the value in a credentials file and keeps the key name', () => {
      expect(redactText(`aws_secret_access_key = ${secret}`).text).toBe('aws_secret_access_key = [REDACTED:aws_secret]');
    });

    it('redacts SecretAccessKey in AWS CLI JSON output', () => {
      expect(redactText(`"SecretAccessKey": "${secret}"`).text).toBe('"SecretAccessKey": "[REDACTED:aws_secret]"');
    });
  });

  describe('github_token', () => {
    it.each(['ghp', 'gho', 'ghu', 'ghs', 'ghr'])('redacts %s_ tokens', (prefix) => {
      expect(redactText(`token ${prefix}_${base62(36)}.`).text).toBe('token [REDACTED:github_token].');
    });

    it('redacts fine-grained personal access tokens', () => {
      expect(redactText(`github_pat_${base62(22)}_${base62(59)}`).text).toBe('[REDACTED:github_token]');
    });

    it('ignores identifiers that only share the prefix', () => {
      expect(redactText('ghp_short and gho_away').text).toBe('ghp_short and gho_away');
    });
  });

  describe('anthropic_key', () => {
    it('redacts Anthropic API keys as anthropic_key, not openai_key', () => {
      expect(redactText(`key=sk-ant-api03-${base64url(93)}AA;`).counts).toEqual({ anthropic_key: 1 });
    });
  });

  describe('openai_key', () => {
    it('redacts project and legacy OpenAI keys', () => {
      expect(redactText(`sk-proj-${base64url(64)} and sk-${base62(48)}`).text).toBe('[REDACTED:openai_key] and [REDACTED:openai_key]');
    });

    it('ignores sk- prefixed words that are not random keys', () => {
      const text = 'see sk-learn-preprocessing-pipelines-guide for details';
      expect(redactText(text).text).toBe(text);
    });
  });

  describe('jwt', () => {
    it('redacts a three-part JWT', () => {
      expect(redactText(`Bearer ${jwt()}`).text).toBe('Bearer [REDACTED:jwt]');
    });

    it('ignores eyJ fragments that are not three base64url segments', () => {
      expect(redactText('eyJhbGciOi is a JSON header prefix').text).toBe('eyJhbGciOi is a JSON header prefix');
    });
  });

  describe('private_key', () => {
    const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');

    it('replaces the whole PEM block with one placeholder and keeps the text around it', () => {
      expect(redactText(`before\n${pem(label)}\nafter`)).toEqual({ text: 'before\n[REDACTED:private_key]\nafter', counts: { private_key: 1 } });
    });

    it('handles PEM blocks with JSON-escaped newlines', () => {
      const escaped = JSON.stringify({ private_key: pem(label) });
      expect(redactText(escaped).text).toBe('{"private_key":"[REDACTED:private_key]"}');
    });

    it('redacts to the end of the text when the END line was cut off', () => {
      const truncated = pem(label).split('\n').slice(0, 3).join('\n');
      expect(redactText(`output:\n${truncated}`).text).toBe('output:\n[REDACTED:private_key]');
    });

    it('leaves public keys and certificates alone', () => {
      const text = `${pem('PUBLIC KEY', 2)}\n${pem('CERTIFICATE', 2)}`;
      expect(redactText(text).text).toBe(text);
    });
  });
});
