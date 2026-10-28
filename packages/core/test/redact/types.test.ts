import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Compiles snippets with the real TypeScript compiler to prove that code sending data off the machine
// (stood in for by sendToLlm) can only be handed a RedactedSession produced by redactSession().

const CORE = fileURLToPath(new URL('../../', import.meta.url));
const TSC = fileURLToPath(new URL('../../../../node_modules/.bin/tsc', import.meta.url));

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
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(CORE, '.typecheck-'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: '../../../tsconfig.base.json',
      compilerOptions: { noEmit: true, composite: false, declaration: false, declarationMap: false, sourceMap: false, types: ['node'] },
      include: ['*.ts'],
    }),
  );
  for (const [name, body] of Object.entries(snippets)) {
    // Imports must come first, so hoist any import in the body above the prelude.
    const [imports, rest] = body.startsWith('import') ? [body.split('\n')[0]! + '\n', body.split('\n').slice(1).join('\n')] : ['', body];
    writeFileSync(join(dir, `${name}.ts`), `${imports}${prelude}${rest}\n`);
  }
  let output = '';
  try {
    execFileSync(TSC, ['-p', dir, '--pretty', 'false'], { encoding: 'utf8' });
  } catch (err) {
    output = String((err as { stdout?: string }).stdout ?? '');
  }
  diagnostics = {};
  messages = {};
  for (const m of output.matchAll(/([\w-]+)\.ts\(\d+,\d+\): error (TS\d+): (.*)/g)) {
    (diagnostics[m[1]!] ??= []).push(m[2]!);
    messages[m[1]!] = `${messages[m[1]!] ?? ''}${m[3]}\n`;
  }
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
