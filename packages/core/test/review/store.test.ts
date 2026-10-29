import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approve, reject } from '../../src/review/approval.js';
import { findSummary, listSummaries, saveOriginal, saveSummary } from '../../src/review/store.js';
import { writeSummary } from '../../src/summarize/store.js';
import { draftSummary } from './helpers.js';

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'digest-review-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const draftFile = (dir: string, id = 'c1a5e001-0000-4000-8000-000000000001') => join(dir, '.digest/summaries', `claude-code-${id}.json`);

describe('review store', () => {
  it('lists saved summaries, oldest session first, skipping unreadable files', () => {
    const dir = repo();
    saveSummary(dir, draftSummary({ sessionId: 'b2', startedAt: '2026-03-03T00:00:00.000Z' }));
    saveSummary(dir, draftSummary({ sessionId: 'a1', startedAt: '2026-03-01T00:00:00.000Z' }));
    writeFileSync(join(dir, '.digest/summaries/broken.json'), '{ nope');
    expect(listSummaries(dir).map((s) => s.sessionId)).toEqual(['a1', 'b2']);
  });

  it('returns nothing for a repo with no summaries yet', () => {
    expect(listSummaries(repo())).toEqual([]);
  });

  it('finds a summary by session id prefix, and explains a missing or ambiguous one', () => {
    const dir = repo();
    saveSummary(dir, draftSummary({ sessionId: 'abc111' }));
    saveSummary(dir, draftSummary({ sessionId: 'abc222' }));
    expect(findSummary(dir, 'abc1')).toMatchObject({ summary: { sessionId: 'abc111' } });
    expect(findSummary(dir, 'abc')).toEqual({ error: expect.stringMatching(/matches 2 summaries/) });
    expect(findSummary(dir, 'zzz')).toEqual({ error: expect.stringMatching(/No summary matching zzz/) });
  });

  it('keeps the first original model output, for future evals', () => {
    const dir = repo();
    saveOriginal(dir, draftSummary({ goal: 'Model wrote this.' }));
    saveOriginal(dir, draftSummary({ goal: 'A later edit.' }));
    const original = JSON.parse(readFileSync(join(dir, '.digest/originals/claude-code-c1a5e001-0000-4000-8000-000000000001.json'), 'utf8'));
    expect(original.goal).toBe('Model wrote this.');
  });
});

describe('re-summarising never overwrites a reviewed summary', () => {
  it.each([
    ['approved', () => approve(draftSummary()).summary],
    ['edited', () => draftSummary({ editedByDeveloper: true, goal: 'Edited by hand.' })],
  ])('keeps an %s summary as it is', (_label, make) => {
    const dir = repo();
    const reviewed = make() as ReturnType<typeof draftSummary>;
    saveSummary(dir, reviewed);
    expect(() => writeSummary(dir, 'k1', draftSummary({ goal: 'Regenerated.' }))).toThrow(/never overwritten/);
    expect(JSON.parse(readFileSync(draftFile(dir), 'utf8')).goal).toBe(reviewed.goal);
    expect(existsSync(join(dir, '.digest/cache/summaries/k1.json'))).toBe(false);
  });

  it('replaces a plain draft', () => {
    const dir = repo();
    saveSummary(dir, draftSummary());
    writeSummary(dir, 'k1', draftSummary({ goal: 'Regenerated.' }));
    expect(JSON.parse(readFileSync(draftFile(dir), 'utf8')).goal).toBe('Regenerated.');
  });

  it('replaces a rejected summary only when asked for that session (the CLI never does it with --all)', () => {
    const dir = repo();
    saveSummary(dir, reject(draftSummary()));
    writeSummary(dir, 'k1', draftSummary({ goal: 'Regenerated.' }));
    expect(JSON.parse(readFileSync(draftFile(dir), 'utf8'))).toMatchObject({ status: 'draft', goal: 'Regenerated.' });
  });
});
