import { beforeAll, describe, expect, it } from 'vitest';
import { typecheck, type Diagnostics } from '../typecheck.js';

// Proves that upload code (stood in for by upload) can only be handed an ApprovedSummary made by approve().

const prelude = `import { approve, type ApprovedSummary, type SessionSummary } from '../src/index.js';
declare function upload(input: ApprovedSummary): void;
declare const draft: SessionSummary;
`;

const snippets: Record<string, string> = {
  ok: 'upload(approve(draft));',
  raw: 'upload(draft);',
  lookalike: "upload({ summary: { ...draft, status: 'approved' } });",
  spread: 'upload({ ...approve(draft) });',
  edit: "approve(draft).summary.goal = 'changed after approval';",
  push: "approve(draft).summary.decisions.push({ decision: 'added after approval', reason: '' });",
  construct: "import * as core from '../src/index.js';\nupload(new core.ApprovedSummary(draft));",
};

let result: Diagnostics;
beforeAll(() => {
  result = typecheck(prelude, snippets);
}, 60_000);

describe('ApprovedSummary type guarantees', () => {
  it('accepts the result of approve()', () => {
    expect(result.codes.ok).toBeUndefined();
  });

  it.each([
    ['raw', 'a raw draft', 'TS2739', "is missing the following properties from type 'ApprovedSummary'"],
    ['lookalike', 'an object shaped like an ApprovedSummary', 'TS2741', "Property '#brand' is missing"],
    ['spread', 'a spread copy of an ApprovedSummary', 'TS2741', "Property '#brand' is missing"],
    ['edit', 'editing a field after approval', 'TS2540', 'read-only property'],
    ['push', 'adding to a list after approval', 'TS2339', "Property 'push' does not exist"],
    ['construct', 'constructing an ApprovedSummary directly', 'TS2551', "Property 'ApprovedSummary' does not exist"],
  ])('rejects %s: %s', (name, _label, code, phrase) => {
    expect(result.codes[name]).toEqual([code]);
    expect(result.messages[name]).toContain(phrase);
  });
});
