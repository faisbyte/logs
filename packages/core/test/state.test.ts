import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintFile, markProcessed, readState, sessionKey, sessionStatus, writeState } from '../src/state.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'digest-state-'));
const key = sessionKey({ agent: 'codex', sourceSessionId: '019c0001' });
const now = new Date('2026-03-10T12:00:00.000Z');

describe('session state', () => {
  it('starts empty when the repo has no .digest directory', () => {
    expect(readState(tempDir())).toEqual({ version: 1, sessions: {} });
  });

  it('keys sessions by agent and source session id', () => {
    expect(key).toBe('codex:019c0001');
  });

  it('reports a session it has never processed as new', () => {
    expect(sessionStatus(readState(tempDir()), key, 'fp-1')).toBe('new');
  });

  it('reports processed while the fingerprint matches, and changed once the file grows', () => {
    const state = markProcessed(readState(tempDir()), key, 'fp-1', now);
    expect(sessionStatus(state, key, 'fp-1')).toBe('processed');
    expect(sessionStatus(state, key, 'fp-2')).toBe('changed');
  });

  it('does not modify the state it was given', () => {
    const before = readState(tempDir());
    markProcessed(before, key, 'fp-1', now);
    expect(before.sessions).toEqual({});
  });

  it('round-trips through .digest/state.json', () => {
    const repo = tempDir();
    writeState(repo, markProcessed(readState(repo), key, 'fp-1', now));
    expect(readState(repo).sessions[key]).toEqual({ fingerprint: 'fp-1', processedAt: '2026-03-10T12:00:00.000Z' });
    expect(JSON.parse(readFileSync(join(repo, '.digest/state.json'), 'utf8')).version).toBe(1);
  });

  it('keeps .digest out of git even when the repo does not ignore it', () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeState(repo, readState(repo));
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
  });

  it('refuses to silently reset a corrupt state file', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.digest'));
    writeFileSync(join(repo, '.digest/state.json'), '{"version":1,"sessions":');
    expect(() => readState(repo)).toThrow(/\.digest\/state\.json/);
    writeFileSync(join(repo, '.digest/state.json'), '{"version":2}');
    expect(() => readState(repo)).toThrow(/\.digest\/state\.json/);
  });
});

describe('fingerprintFile', () => {
  it('is stable for unchanged content and changes when a session appends lines', () => {
    const file = join(tempDir(), 's.jsonl');
    writeFileSync(file, '{"a":1}\n');
    const first = fingerprintFile(file);
    expect(fingerprintFile(file)).toBe(first);
    appendFileSync(file, '{"b":2}\n');
    expect(fingerprintFile(file)).not.toBe(first);
  });
});
