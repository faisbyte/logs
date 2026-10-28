import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/redact/text.js';

const unchanged = (text: string, options?: Parameters<typeof redactText>[1]) => expect(redactText(text, options).text).toBe(text);

describe('email', () => {
  it('redacts email addresses by default', () => {
    expect(redactText('ping jane.doe+ci@example.org about it').text).toBe('ping [REDACTED:email] about it');
    expect(redactText('Co-Authored-By: Dev <dev@mail.acme.co.uk>').text).toBe('Co-Authored-By: Dev <[REDACTED:email]>');
  });

  it('still redacts an email followed by a colon and a space', () => {
    expect(redactText('mail ops@acme.io: they own it').text).toBe('mail [REDACTED:email]: they own it');
  });

  it('leaves git SSH remotes, scoped packages and decorators alone', () => {
    unchanged('git@github.com:acme/webapp.git @types/node@26.6.5 @Component user@localhost');
  });

  it('can be turned off', () => {
    unchanged('ping jane.doe@example.org', { pii: { email: false } });
  });
});

describe('phone', () => {
  it.each([
    ['international with spaces', '+61 2 9876 5432'],
    ['international with area code in brackets', '+1 (415) 555-0123'],
    ['international without separators', '+447700900123'],
    ['area code in brackets', '(02) 9876 5432'],
    ['national with leading zero', '0412 345 678'],
    ['US dashed', '415-555-0123'],
  ])('redacts %s numbers by default', (_label, number) => {
    expect(redactText(`call ${number} tomorrow`).text).toBe('call [REDACTED:phone] tomorrow');
  });

  it.each([
    ['dates and times', '2026-10-28 13:02:12 and 28/10/2026'],
    ['IP addresses and ports', '192.168.100.200 and localhost:5432'],
    ['versions and decimals', 'v2.1.310 and 3.14159265'],
    ['epoch timestamps and counts', '1767225600123 and 1,234,567 rows'],
    ['arithmetic', 'x+1234 5678'],
  ])('leaves %s alone', (_label, text) => unchanged(text));

  it('can be turned off', () => {
    unchanged('call +61 2 9876 5432', { pii: { phone: false } });
  });
});
