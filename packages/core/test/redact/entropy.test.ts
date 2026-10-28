import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/redact/text.js';
import { base62, pick } from './corpus.js';

const hex = (n: number) => pick('0123456789abcdef', n);
const uuid4 = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const base64 = (n: number) => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', n);

const unchanged = (text: string) => expect(redactText(text).text).toBe(text);

// Written before any threshold was chosen: these shapes are everywhere in real sessions.
describe('high_entropy false positives', () => {
  it.each([
    ['full git SHA', `commit ${hex(40)}`],
    ['short git SHAs', `${hex(7)} and ${hex(12)}`],
    ['UUID v4 session id', uuid4()],
    ['UUID v7 Codex session id', `019bdfda-${hex(4)}-7${hex(3)}-8${hex(3)}-${hex(12)}`],
    ['upper-case UUID', uuid4().toUpperCase()],
    ['Claude tool use id', `toolu_01${base62(22)}`],
    ['Claude server tool use id', `srvtoolu_01${base62(22)}`],
    ['Claude message id', `msg_01${base62(22)}`],
    ['Claude request id', `req_011C${base62(20)}`],
    ['Codex call id', `call_${base62(24)}`],
    ['subagent id', `agent-a${hex(16)}`],
    ['sha256 hex digest', hex(64)],
    ['sha512 hex digest', hex(128)],
    ['md5 hex digest', hex(32)],
    ['SRI integrity hash', `integrity: sha512-${base64(86)}==`],
    ['docker image digest', `node@sha256:${hex(64)}`],
    ['SSH public key', `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA${base64(43)} dev@laptop`],
  ])('leaves a %s alone', (_label, text) => unchanged(text));

  it.each([
    ['absolute path with digits and capitals', '/Users/dev/Documents/GitHub/IMC-Prosperity2/src/Trader2024FinalVersion.py'],
    ['camelCase identifiers with digits', 'ParsedSessionSchemaV2TranscriptEntry and getUserById2FactorAuthTokenV3'],
    ['branch name', 'feature/PROJ-160-audit-log-for-admin-actions-v2'],
    ['timestamps, versions and long numbers', '2026-10-28T01:05:42.123Z v2.1.310 1767225600123'],
    ['scoped package with version', '@typescript-eslint/eslint-plugin@8.46.2'],
    ['constant names', 'MAX_RETRY_ATTEMPTS_BEFORE_CIRCUIT_BREAKER_OPENS_V2'],
  ])('leaves %s alone', (_label, text) => unchanged(text));
});

describe('high_entropy', () => {
  it.each([24, 32, 40, 64])('flags a random %i-char token mid-sentence', (n) => {
    expect(redactText(`the vendor gave us ${base62(n)} for staging`).text).toBe('the vendor gave us [REDACTED:high_entropy] for staging');
  });

  it('flags random base64 with padding and base64url tokens', () => {
    expect(redactText(`a ${base64(30)}== b ${base62(20)}-${base62(20)}_${base62(4)}`).counts).toEqual({ high_entropy: 2 });
  });

  it('flags random tokens inside JSON and tool arguments', () => {
    expect(redactText(JSON.stringify({ webhook: base62(40) })).counts).toEqual({ high_entropy: 1 });
    expect(redactText(`curl -d 'k=1' -H "X-Vendor: ${base62(40)}" https://x.example`).counts).toEqual({ high_entropy: 1 });
  });
});
