import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

describe('built digest binary', () => {
  it('prints its version', () => {
    const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(out).toBe('0.1.0\n');
  });

  it('starts with a node shebang so package managers can link it', () => {
    expect(readFileSync(bin, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
