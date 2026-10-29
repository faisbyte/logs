import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { extractTickets } from '../../src/tickets/extract.js';

function repoWithConfig(contents: object) {
  const repo = mkdtempSync(join(tmpdir(), 'digest-tickets-'));
  mkdirSync(join(repo, '.digest'));
  writeFileSync(join(repo, '.digest/config.json'), JSON.stringify(contents));
  return repo;
}

const noisy = ['Fix UTF-8 decoding and switch to SHA-256', 'Try GPT-4 for PROJ-9 titles', 'PROJ-12: retry on timeout'];

describe('extractTickets', () => {
  it('takes keys from branch names only when no project keys are configured (commit messages are too noisy)', () => {
    expect(extractTickets({ branches: ['feature/PROJ-142-rate-limit', 'main', 'fix/ABC-7-and-ABC-8'], commitMessages: noisy })).toEqual({
      ticketRefs: ['PROJ-142', 'ABC-7', 'ABC-8'],
      ticketSources: { 'PROJ-142': 'branch', 'ABC-7': 'branch', 'ABC-8': 'branch' },
    });
  });

  it('with project keys set, takes keys from branches and commit messages, but only for those projects', () => {
    expect(extractTickets({ branches: ['feature/PROJ-142-x', 'fix/ABC-7'], commitMessages: noisy }, { keys: ['PROJ'] })).toEqual({
      ticketRefs: ['PROJ-142', 'PROJ-9', 'PROJ-12'],
      ticketSources: { 'PROJ-142': 'branch', 'PROJ-9': 'commit', 'PROJ-12': 'commit' },
    });
  });

  it('marks a key found in both a branch and a commit as coming from the branch', () => {
    expect(extractTickets({ branches: ['PROJ-12-retry'], commitMessages: ['PROJ-12: retry'] }, { keys: ['PROJ'] }).ticketSources).toEqual({ 'PROJ-12': 'branch' });
  });

  it('uses a configured pattern instead of the default', () => {
    expect(extractTickets({ branches: ['feature/proj_42-x'], commitMessages: [] }, { pattern: 'proj_\\d+' }).ticketRefs).toEqual(['proj_42']);
  });

  it('finds nothing in sessions without branches or commits', () => {
    expect(extractTickets({ branches: [], commitMessages: [] })).toEqual({ ticketRefs: [], ticketSources: {} });
  });
});

describe('tickets config', () => {
  it('defaults to no pattern and no project keys', () => {
    expect(readConfig(repoWithConfig({})).tickets).toEqual({});
  });

  it('reads a pattern and project keys', () => {
    expect(readConfig(repoWithConfig({ tickets: { pattern: '[A-Z]+-\\d+', keys: ['PROJ', 'OPS'] } })).tickets).toEqual({ pattern: '[A-Z]+-\\d+', keys: ['PROJ', 'OPS'] });
  });

  it.each([
    ['a pattern that does not compile', { pattern: '[A-Z+-\\d+' }, /tickets\.pattern is not a valid regular expression/],
    ['a pattern over 100 characters', { pattern: `${'A'.repeat(100)}-\\d+` }, /tickets\.pattern must be at most 100 characters/],
    ['a pattern that matches empty text', { pattern: '[A-Z]*' }, /tickets\.pattern must not match empty text/],
    ['a project key that is not a plain word', { keys: ['PROJ-'] }, /tickets\.keys/],
    ['an unknown setting', { patterns: 'x' }, /\.digest\/config\.json/],
  ])('rejects %s with a clear error', (_, tickets, message) => {
    expect(() => readConfig(repoWithConfig({ tickets }))).toThrow(message);
  });
});
