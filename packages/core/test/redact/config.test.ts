import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { redactText } from '../../src/redact/text.js';

const awsExample = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

function repoWithConfig(contents: string) {
  const repo = mkdtempSync(join(tmpdir(), 'digest-config-'));
  mkdirSync(join(repo, '.digest'));
  writeFileSync(join(repo, '.digest/config.json'), contents);
  return repo;
}

describe('deny list', () => {
  it('redacts every occurrence of a literal, case-sensitively', () => {
    expect(redactText('Project Falcon ships when Project Falcon is ready; project falcon is a codename', { deny: ['Project Falcon'] })).toEqual({
      text: '[REDACTED:deny_list] ships when [REDACTED:deny_list] is ready; project falcon is a codename',
      counts: { deny_list: 2 },
    });
  });

  it('matches literals only, so a pattern-looking entry is just text', () => {
    expect(redactText('see ACME-\\d{4} and ACME-1234', { deny: ['ACME-\\d{4}'] }).text).toBe('see [REDACTED:deny_list] and ACME-1234');
  });

  it('can redact a home directory out of paths', () => {
    expect(redactText('/Users/jdoe/Documents/GitHub/app/src', { deny: ['/Users/jdoe'] }).text).toBe('[REDACTED:deny_list]/Documents/GitHub/app/src');
  });
});

describe('allow list', () => {
  it('keeps a detected value that exactly matches a literal', () => {
    expect(redactText(`AWS_ACCESS_KEY_ID=${awsExample}`, { allow: [awsExample] }).text).toBe(`AWS_ACCESS_KEY_ID=${awsExample}`);
  });

  it('keeps each exactly-listed value and nothing else', () => {
    expect(redactText('mail dev@example.com or ops@example.com', { allow: ['dev@example.com'] }).text).toBe('mail dev@example.com or [REDACTED:email]');
  });

  it('still redacts a value that only contains an allowed literal', () => {
    expect(redactText(`KEY_PASSWORD=${awsExample}-extra`, { allow: [awsExample] }).counts).toEqual({ env_secret: 1 });
  });

  it('loses to the deny list', () => {
    expect(redactText('mail dev@example.com', { allow: ['dev@example.com'], deny: ['dev@example.com'] }).text).toBe('mail [REDACTED:deny_list]');
  });
});

describe('readConfig', () => {
  it('returns defaults when there is no config file', () => {
    expect(readConfig(mkdtempSync(join(tmpdir(), 'digest-noconfig-')))).toEqual({ redaction: {}, summarize: {} });
  });

  it('reads allow, deny and pii settings', () => {
    const repo = repoWithConfig(JSON.stringify({ redaction: { allow: ['a'], deny: ['b'], pii: { phone: false }, home: false } }));
    expect(readConfig(repo)).toEqual({ redaction: { allow: ['a'], deny: ['b'], pii: { phone: false }, home: false }, summarize: {} });
  });

  it('rejects unreadable JSON and unknown redaction keys, naming the file', () => {
    expect(() => readConfig(repoWithConfig('{"redaction":'))).toThrow(/\.digest\/config\.json/);
    expect(() => readConfig(repoWithConfig('{"redaction":{"denylist":["x"]}}'))).toThrow(/\.digest\/config\.json/);
  });

  it('rejects regex entries in allow and deny with a hint to use literals (D20)', () => {
    expect(() => readConfig(repoWithConfig('{"redaction":{"deny":[{"regex":"ACME-\\\\d+"}]}}'))).toThrow(/literal strings/);
    expect(() => readConfig(repoWithConfig('{"redaction":{"allow":[{"regex":"."}]}}'))).toThrow(/literal strings/);
  });
});
