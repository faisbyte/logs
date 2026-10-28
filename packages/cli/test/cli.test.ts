import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { exitCode, stdout, stderr };
}

describe('digest CLI', () => {
  it('prints the version for --version', async () => {
    const result = await run(['--version']);
    expect(result).toEqual({ exitCode: 0, stdout: '0.1.0\n', stderr: '' });
  });

  it('exits non-zero on an unknown command', async () => {
    const result = await run(['frobnicate']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('frobnicate');
  });
});
