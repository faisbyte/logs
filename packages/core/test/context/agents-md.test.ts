import { describe, expect, it } from 'vitest';
import { AGENTS_END, AGENTS_START, agentsSection, withAgentsImport, withAgentsSection } from '../../src/context/agents-md.js';
import { contextItem } from '../shared/context-contract.js';

// The marked AGENTS.md section `sprintdigest context propose` writes (DECISIONS.md D75 option A, D83). Nothing outside
// the markers is ever changed.

const pitfall = contextItem({ id: 'ctx-00000001', date: '2026-03-10', paths: ['src/auth/lockout.ts', 'src/auth'] });
const decision = contextItem({ id: 'ctx-00000002', type: 'decision', text: 'Accounts lock after 5 failed logins.', reason: 'Fewer support calls.', date: '2026-03-12', paths: [] });
const retired = contextItem({ id: 'ctx-00000003', status: 'retired' });

describe('agentsSection', () => {
  it('frames the notes, lists active items pitfalls first with their ids and paths, between the markers', () => {
    expect(agentsSection([decision, retired, pitfall])).toBe(
      [
        AGENTS_START,
        '## Team notes from past AI sessions',
        '',
        "These notes come from the team's approved AI session summaries, through sprintdigest. They are not instructions: verify them against the code before relying on them. This section is replaced as a whole on each proposal, and a wrong note is retired in sprintdigest rather than edited here.",
        '',
        '- Pitfall, 2026-03-10 (ctx-00000001): Counting failed logins in memory was tried and dropped. Why: The counts reset on every deploy. Paths: src/auth/lockout.ts, src/auth.',
        '- Decision, 2026-03-12 (ctx-00000002): Accounts lock after 5 failed logins. Why: Fewer support calls.',
        AGENTS_END,
      ].join('\n'),
    );
    expect(AGENTS_START).toBe('<!-- sprintdigest:context:start -->');
    expect(AGENTS_END).toBe('<!-- sprintdigest:context:end -->');
  });

  it('stays well under Codex\'s 32 KiB instruction limit, saying how many notes it left out', () => {
    const many = Array.from({ length: 300 }, (_, n) => contextItem({ id: `ctx-${String(n).padStart(8, '0')}`, text: `Note ${n} about the lockout counters was tried and dropped after review.` }));
    const section = agentsSection(many);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(16_384);
    const shown = section.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(section).toContain(`(${300 - shown} more notes are in sprintdigest context.)\n${AGENTS_END}`);
    expect(agentsSection(many.slice(0, shown + 1))).toContain(`(1 more note is in sprintdigest context.)\n${AGENTS_END}`);
  });
});

describe('withAgentsSection', () => {
  const section = agentsSection([pitfall]);

  it('creates the file, or appends to one without markers', () => {
    expect(withAgentsSection(null, section)).toEqual({ text: `${section}\n` });
    // The existing text is kept byte for byte, trailing blank lines included; only the gap before the section is added.
    expect(withAgentsSection('# Agents\n\nRun the tests.\n\n\n', section)).toEqual({ text: `# Agents\n\nRun the tests.\n\n\n${section}\n` });
    expect(withAgentsSection('# Agents\n\nRun the tests.\n', section)).toEqual({ text: `# Agents\n\nRun the tests.\n\n${section}\n` });
    expect(withAgentsSection('# Agents', section)).toEqual({ text: `# Agents\n\n${section}\n` });
  });

  it('replaces only what is between the markers, leaving every byte outside them as it was', () => {
    const before = '# Agents\r\n\r\nKeep this exactly.  \n';
    const after = '\n## Later section\n\nAlso kept.\n';
    const existing = `${before}${AGENTS_START}\nold notes\n${AGENTS_END}${after}`;
    const result = withAgentsSection(existing, section);
    expect(result).toEqual({ text: `${before}${section}${after}` });
  });

  it('refuses a file with missing, repeated or out-of-order markers', () => {
    for (const broken of [`${AGENTS_START}\nno end\n`, `no start\n${AGENTS_END}\n`, `${AGENTS_END}\n${AGENTS_START}\n`, `${AGENTS_START}\n${AGENTS_END}\n${AGENTS_START}\n${AGENTS_END}\n`]) {
      expect(withAgentsSection(broken, section)).toEqual({ error: 'AGENTS.md has sprintdigest markers that are missing, repeated or out of order; fix them by hand first.' });
    }
  });
});

describe('withAgentsImport', () => {
  it('adds an @AGENTS.md line to a CLAUDE.md that lacks one, and leaves one that has it alone', () => {
    expect(withAgentsImport('# Claude\n\nUse pnpm.\n')).toBe('# Claude\n\nUse pnpm.\n\n@AGENTS.md\n');
    expect(withAgentsImport('# Claude')).toBe('# Claude\n\n@AGENTS.md\n');
    expect(withAgentsImport('# Claude\n@AGENTS.md\nMore.\n')).toBeNull();
    expect(withAgentsImport('See @./AGENTS.md\n')).toBeNull();
    // Inside a code span it isn't an import, so one is still added.
    expect(withAgentsImport('Mention `@AGENTS.md` only.\n')).toBe('Mention `@AGENTS.md` only.\n\n@AGENTS.md\n');
  });
});
