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

  it('redacts regex matches', () => {
    expect(redactText('see ACME-1234 and acme-5678', { deny: [{ regex: 'ACME-\\d{4}', flags: 'i' }] }).text).toBe(
      'see [REDACTED:deny_list] and [REDACTED:deny_list]',
    );
  });

  it('can redact a home directory out of paths', () => {
    expect(redactText('/Users/jdoe/Documents/GitHub/app/src', { deny: ['/Users/jdoe'] }).text).toBe('[REDACTED:deny_list]/Documents/GitHub/app/src');
  });
});

describe('allow list', () => {
  it('keeps a detected value that exactly matches a literal', () => {
    expect(redactText(`AWS_ACCESS_KEY_ID=${awsExample}`, { allow: [awsExample] }).text).toBe(`AWS_ACCESS_KEY_ID=${awsExample}`);
  });

  it('keeps detected values matching a regex', () => {
    expect(redactText('mail dev@example.com or ops@acme.io', { allow: [{ regex: '@example\\.com$' }] }).text).toBe('mail dev@example.com or [REDACTED:email]');
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
    expect(readConfig(mkdtempSync(join(tmpdir(), 'digest-noconfig-')))).toEqual({ redaction: {} });
  });

  it('reads allow, deny and pii settings', () => {
    const repo = repoWithConfig(JSON.stringify({ redaction: { allow: ['a'], deny: [{ regex: 'b+' }], pii: { phone: false } } }));
    expect(readConfig(repo)).toEqual({ redaction: { allow: ['a'], deny: [{ regex: 'b+' }], pii: { phone: false } } });
  });

  it('rejects unreadable JSON, unknown redaction keys and invalid regexes, naming the file', () => {
    expect(() => readConfig(repoWithConfig('{"redaction":'))).toThrow(/\.digest\/config\.json/);
    expect(() => readConfig(repoWithConfig('{"redaction":{"denylist":["x"]}}'))).toThrow(/\.digest\/config\.json/);
    expect(() => readConfig(repoWithConfig('{"redaction":{"deny":[{"regex":"("}]}}'))).toThrow(/\.digest\/config\.json/);
  });
});
