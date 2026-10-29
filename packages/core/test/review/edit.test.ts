import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { approve } from '../../src/review/approval.js';
import { editSummary, parseEdit, toEditable } from '../../src/review/edit.js';
import { createRedactor } from '../../src/redact/text.js';
import { draftSummary } from './helpers.js';

const redact = createRedactor({ home: false });
// Assembled at runtime so no literal token sits in the source (fake: not a real credential).
const fakeToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

describe('toEditable', () => {
  it('writes the editable fields as YAML, with a header explaining what is shared and how to cancel', () => {
    const text = toEditable(draftSummary());
    expect(text).toMatch(/^# Editing the summary of claude-code session c1a5e001/);
    expect(text).toContain('# Close the editor without saving to change nothing.');
    expect(text).toContain('# Shared with the team once pushed: goal, outcome, whatWasDone, decisions, rejectedApproaches, risksOrFollowUps, aiInvolvement, filesTouched, ticketRefs, branch, startedAt, endedAt');
    expect(text).toContain('# filesTouched: you can delete entries, but not add new ones.');
    expect(Object.keys(parse(text))).toEqual(['goal', 'outcome', 'whatWasDone', 'decisions', 'rejectedApproaches', 'risksOrFollowUps', 'aiInvolvement', 'ticketRefs', 'filesTouched']);
  });

  it('round-trips: saving the text unchanged changes nothing', () => {
    const original = draftSummary({ whatWasDone: 'A long sentence that goes on and on, '.repeat(8).trim() });
    expect(parseEdit(original, toEditable(original), redact)).toMatchObject({ changed: false, summary: original });
  });
});

describe('parseEdit', () => {
  const edit = (change: (yaml: string) => string, original = draftSummary()) => parseEdit(original, change(toEditable(original)), redact);

  it('applies edits to text fields and ticket refs, and marks the summary edited', () => {
    const result = edit((t) => t.replace('goal: Rate limit the login endpoint.', 'goal: Rate limit login, per IP.').replace('- PROJ-142', '- PROJ-142\n  - PROJ-150'));
    expect(result).toMatchObject({ changed: true, summary: { goal: 'Rate limit login, per IP.', ticketRefs: ['PROJ-142', 'PROJ-150'], editedByDeveloper: true, status: 'draft' } });
  });

  it('lets the developer remove files, but not add them', () => {
    expect(edit((t) => t.replace('  - src/routes/login.ts\n', ''))).toMatchObject({ summary: { filesTouched: ['src/middleware/rateLimit.ts'] } });
    expect(edit((t) => t.replace('  - src/routes/login.ts', '  - src/routes/login.ts\n  - src/secret-plans.ts'))).toEqual({
      errors: ["filesTouched: src/secret-plans.ts is not one of the session's files; entries can only be removed"],
    });
  });

  it('re-runs redaction on the edited text, so a pasted secret never reaches the summary', () => {
    const result = edit((t) => t.replace('goal: Rate limit the login endpoint.', `goal: Rate limit login using token ${fakeToken}`));
    expect('summary' in result && result.summary.goal).toBe('Rate limit login using token [REDACTED:github_token]');
    expect(JSON.stringify(result)).not.toContain(fakeToken);
    expect(result).toMatchObject({ redactions: { github_token: 1 } });
  });

  it('reports YAML syntax errors with a line number', () => {
    const result = edit((t) => t.replace('outcome: completed', 'outcome: [completed'));
    expect('errors' in result && result.errors[0]).toMatch(/line \d+/);
  });

  it('reports schema errors by field', () => {
    const result = edit((t) => t.replace('outcome: completed', 'outcome: finished').replace('goal: Rate limit the login endpoint.', 'goal: ""').replace('aiInvolvement: heavy', 'aiInvolvement: heavy\nmood: great'));
    expect('errors' in result && result.errors.join('\n')).toMatch(/outcome: .*completed/);
    expect('errors' in result && result.errors.join('\n')).toMatch(/goal: /);
    expect('errors' in result && result.errors.join('\n')).toMatch(/mood/);
  });

  it('refuses to edit an approved summary: reopen it first', () => {
    expect(() => parseEdit(approve(draftSummary()).summary as ReturnType<typeof draftSummary>, 'goal: x', redact)).toThrow(/reopen/);
  });
});

describe('editSummary (the editor loop)', () => {
  it('changes nothing when the editor is closed without saving', async () => {
    const original = draftSummary();
    const result = await editSummary(original, async () => null, redact);
    expect(result).toEqual({ cancelled: true });
  });

  it('treats a saved file identical to what was opened as cancelled', async () => {
    const result = await editSummary(draftSummary(), async (text) => text, redact);
    expect(result).toEqual({ cancelled: true });
  });

  it('reopens an invalid edit with the errors as comments at the top, then applies the fix', async () => {
    const opened: string[] = [];
    const replies = [(t: string) => t.replace('outcome: completed', 'outcome: finished'), (t: string) => t.replace('outcome: finished', 'outcome: partial')];
    const result = await editSummary(draftSummary(), async (text) => (opened.push(text), replies[opened.length - 1]!(text)), redact);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatch(/^# ERROR: outcome: .*\n/);
    expect(opened[1]).toContain('outcome: finished');
    expect(result).toMatchObject({ summary: { outcome: 'partial', editedByDeveloper: true } });
  });

  it('cancels if the developer gives up on an invalid edit', async () => {
    let n = 0;
    const result = await editSummary(draftSummary(), async (text) => (++n === 1 ? text.replace('outcome: completed', 'outcome: finished') : null), redact);
    expect(result).toEqual({ cancelled: true });
  });

  it('drops old error comments when the file is reopened again', async () => {
    const opened: string[] = [];
    const bad = (t: string) => t.replace(/outcome: \w+/, 'outcome: finished');
    await editSummary(draftSummary(), async (text) => (opened.push(text), opened.length < 3 ? bad(text) : null), redact);
    expect(opened[2]!.match(/^# ERROR:/gm)).toHaveLength(1);
  });
});
