import { beforeAll, describe, expect, it } from 'vitest';
import { typecheck } from '../typecheck.js';

// Compiles snippets with the real TypeScript compiler to prove that code sending data off the machine
// (stood in for by sendToLlm) can only be handed a RedactedSession produced by redactSession().

const prelude = `import { parseClaudeCodeFile, redactSession, type RedactedSession } from '../src/index.js';
declare function sendToLlm(input: RedactedSession): void;
const parsed = parseClaudeCodeFile('session.jsonl')!;
`;

const snippets: Record<string, string> = {
  ok: 'sendToLlm(redactSession(parsed));',
  raw: 'sendToLlm(parsed);',
  lookalike: 'sendToLlm({ session: parsed, counts: {} });',
  spread: 'sendToLlm({ ...redactSession(parsed) });',
  mutate: "redactSession(parsed).session.title = 'swapped back';",
  push: "redactSession(parsed).session.transcript.push({ kind: 'interruption', timestamp: '' });",
  construct: "import * as core from '../src/index.js';\nsendToLlm(new core.RedactedSession(parsed, {}));",
};

let diagnostics: Record<string, string[]> = {};
let messages: Record<string, string> = {};

beforeAll(() => {
  ({ codes: diagnostics, messages } = typecheck(prelude, snippets));
}, 60_000);

describe('RedactedSession type guarantees', () => {
  it('accepts the result of redactSession()', () => {
    expect(diagnostics.ok).toBeUndefined();
  });

  // Each case pins the error code and a phrase from the message, so it fails for the right reason.
  it.each([
    ['raw', 'an unredacted ParsedSession', 'TS2739', "is missing the following properties from type 'RedactedSession'"],
    ['lookalike', 'an object shaped like a RedactedSession', 'TS2741', "Property '#brand' is missing"],
    ['spread', 'a spread copy of a RedactedSession', 'TS2741', "Property '#brand' is missing"],
    ['mutate', 'assigning to a redacted field', 'TS2540', 'read-only property'],
    ['push', 'pushing into the redacted transcript', 'TS2339', "Property 'push' does not exist"],
    ['construct', 'constructing a RedactedSession directly', 'TS2551', "Property 'RedactedSession' does not exist"],
  ])('rejects %s: %s', (name, _label, code, phrase) => {
    expect(diagnostics[name]).toEqual([code]);
    expect(messages[name]).toContain(phrase);
  });
});
