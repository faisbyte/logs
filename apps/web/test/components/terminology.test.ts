// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS } from '~/lib/terms';

// One user-facing term per concept (docs/dashboard-design.md, "Terminology"). Labels live in src/lib/terms.ts; this scans
// every view so a synonym can't creep back in, and so "Pitfall" stays with context items and "Tried and dropped" with
// summaries and digests.

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
// Comments explain internals in internal words; only code and markup reach a person.
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const views = files(SRC).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(join('lib', 'terms.ts')));
const uses = (pattern: RegExp) => views.filter((f) => pattern.test(code(f))).map((f) => relative(SRC, f)).sort();

describe('terminology', () => {
  it('maps each concept to one label', () => {
    expect(TERMS).toEqual({
      rejectedApproaches: 'Tried and dropped',
      decisions: 'Decisions',
      risksOrFollowUps: 'Follow-ups',
      editedByDeveloper: 'Edited by developer',
      autoApproved: 'Auto-approved',
      pitfall: 'Pitfall',
      decision: 'Decision',
      convention: 'Convention',
      active: 'Active',
      superseded: 'Superseded',
      retired: 'Retired',
      withdrawnSummary: 'withdrew a summary',
    });
  });

  it('never shows the internal or retired synonyms', () => {
    expect(uses(/rejected approach|a retraction|was retracted|\bretracted\b/i)).toEqual([]);
  });

  it('writes each label only in terms.ts', () => {
    expect(uses(/['"`>]\s*(Tried and dropped|Pitfalls?|Edited by developer|Auto-approved)\b/)).toEqual([]);
  });

  it('keeps "tried and dropped" out of the context view, where the concept is a pitfall', () => {
    expect(uses(/tried and dropped/i)).toEqual([]);
  });
});
