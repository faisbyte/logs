import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiles snippets with the real TypeScript compiler, for tests that pin what the type system rejects.

const CORE = fileURLToPath(new URL('../', import.meta.url));
const TSC = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));

export interface Diagnostics {
  /** Error codes per snippet name; absent when the snippet compiles. */
  codes: Record<string, string[]>;
  messages: Record<string, string>;
}

export function typecheck(prelude: string, snippets: Record<string, string>): Diagnostics {
  const dir = mkdtempSync(join(CORE, '.typecheck-'));
  try {
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
    const result: Diagnostics = { codes: {}, messages: {} };
    for (const m of output.matchAll(/([\w-]+)\.ts\(\d+,\d+\): error (TS\d+): (.*)/g)) {
      (result.codes[m[1]!] ??= []).push(m[2]!);
      result.messages[m[1]!] = `${result.messages[m[1]!] ?? ''}${m[3]}\n`;
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
