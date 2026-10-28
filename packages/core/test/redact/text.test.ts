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

  describe('env_secret', () => {
    it('redacts values of secret-named keys and keeps the key', () => {
      expect(redactText('DB_PASSWORD=s3cr3t-value').text).toBe('DB_PASSWORD=[REDACTED:env_secret]');
      expect(redactText('{"client_secret": "abc-123-def"}').text).toBe('{"client_secret": "[REDACTED:env_secret]"}');
      expect(redactText('  api_key: k9-abcdef').text).toBe('  api_key: [REDACTED:env_secret]');
    });

    it('redacts the credential after a Bearer or Basic scheme', () => {
      expect(redactText('-H "Authorization: Bearer opaque-tok3n"').text).toBe('-H "Authorization: Bearer [REDACTED:env_secret]"');
    });

    it('leaves ordinary settings alone', () => {
      const env = 'NODE_ENV=production\nPORT=3000\nTZ=UTC pnpm test';
      expect(redactText(env).text).toBe(env);
    });

    it('does not treat numbers, variable references or type names as secrets', () => {
      const text = '"max_tokens": 1024, TOKEN=$GITHUB_TOKEN, SECRET=${SECRET}, password: string;';
      expect(redactText(text).text).toBe(text);
    });

    it('does not mistake Author or Authored keys for auth', () => {
      const text = 'Author: Jane\nCo-Authored-By: Dev Bot\nauthored: yes';
      expect(redactText(text, { pii: { email: false } }).text).toBe(text);
    });

    it('ignores secret-ish words in the middle of prose', () => {
      const text = 'The request failed with Invalid token: expired after an hour.';
      expect(redactText(text).text).toBe(text);
    });
  });

  describe('connection_string', () => {
    it('redacts the credentials and keeps scheme, host and database', () => {
      expect(redactText('postgres://app:pa55word@db.internal:5432/app').text).toBe('postgres://[REDACTED:connection_string]@db.internal:5432/app');
    });

    it('handles an empty user name', () => {
      expect(redactText('redis://:pa55word@cache:6379').text).toBe('redis://[REDACTED:connection_string]@cache:6379');
    });

    it('leaves URLs without a password alone', () => {
      const text = 'ssh://git@github.com/acme/webapp.git and https://example.com/a:b';
      expect(redactText(text).text).toBe(text);
    });
  });

  describe('overlapping matches', () => {
    const token = `ghp_${base62(36)}`;

    it('produces one placeholder of the most specific type', () => {
      const secret = pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 40);
      expect(redactText(`AWS_SECRET_ACCESS_KEY=${secret}`)).toEqual({ text: 'AWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret]', counts: { aws_secret: 1 } });
      expect(redactText(`GITHUB_TOKEN=${token}`)).toEqual({ text: 'GITHUB_TOKEN=[REDACTED:github_token]', counts: { github_token: 1 } });
    });

    it('merges partially overlapping matches into one clean placeholder', () => {
      expect(redactText(`https://x-access-token:${token}@github.com/acme/webapp.git`)).toEqual({
        text: 'https://[REDACTED:github_token]@github.com/acme/webapp.git',
        counts: { github_token: 1 },
      });
    });

    it('keeps separate secrets separate', () => {
      expect(redactText(`${awsKey} ${awsKey}`).text).toBe('[REDACTED:aws_key] [REDACTED:aws_key]');
    });

    it('is idempotent', () => {
      const once = redactText(`GITHUB_TOKEN=${token} DB_PASSWORD=hunter2`).text;
      expect(redactText(once).text).toBe(once);
    });
  });
});
