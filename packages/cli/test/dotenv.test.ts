import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/dotenv.js';

const envFile = (contents: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'digest-dotenv-')), '.env');
  writeFileSync(file, contents);
  return file;
};

describe('loadDotEnv', () => {
  it('fills variables from the file', () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(envFile('# key for digest summarize\nANTHROPIC_API_KEY=from-file\n'), env);
    expect(env.ANTHROPIC_API_KEY).toBe('from-file');
  });

  it('never overrides a variable already set in the environment', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'from-shell' };
    loadDotEnv(envFile('ANTHROPIC_API_KEY=from-file\n'), env);
    expect(env.ANTHROPIC_API_KEY).toBe('from-shell');
  });

  it('skips empty values, so a blank placeholder changes nothing', () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(envFile('ANTHROPIC_API_KEY=\n'), env);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('does nothing when the file is missing', () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(join(tmpdir(), 'digest-no-such-dir', '.env'), env);
    expect(env).toEqual({});
  });
});
