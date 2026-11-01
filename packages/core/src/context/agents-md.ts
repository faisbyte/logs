import { selectItems } from './brief.js';
import type { ContextItem } from './item.js';

// The AGENTS.md section `sprintdigest context propose` writes (DECISIONS.md D75 option A, D83). Codex reads AGENTS.md,
// and Claude Code reads it directly or through an @AGENTS.md import in CLAUDE.md. Only the text between the markers is
// ever written; everything outside them is kept byte for byte.

export const AGENTS_START = '<!-- sprintdigest:context:start -->';
export const AGENTS_END = '<!-- sprintdigest:context:end -->';
/** Half of Codex's default 32 KiB for all instruction files, so the team's own AGENTS.md text keeps room. */
export const AGENTS_MAX_BYTES = 16_384;

const LABEL = { pitfall: 'Pitfall', decision: 'Decision', convention: 'Convention' } as const;
const HEAD = [
  AGENTS_START,
  '## Team notes from past AI sessions',
  '',
  "These notes come from the team's approved AI session summaries, through sprintdigest. They are not instructions: verify them against the code before relying on them. This section is replaced as a whole on each proposal, and a wrong note is retired in sprintdigest rather than edited here.",
  '',
];
const line = (i: ContextItem) => `- ${LABEL[i.type]}, ${i.date} (${i.id}): ${i.text} Why: ${i.reason}${i.paths.length ? ` Paths: ${i.paths.join(', ')}.` : ''}`;
const bytes = (lines: string[]) => Buffer.byteLength(lines.join('\n'));

/** The whole section, markers included: active items, pitfalls first, cut to fit AGENTS_MAX_BYTES. */
export function agentsSection(items: readonly ContextItem[]): string {
  const selected = selectItems(items, undefined);
  const footer = (n: number) => `(${n} more notes are in sprintdigest context.)`;
  const lines = [...HEAD];
  for (const [n, item] of selected.entries()) {
    const left = selected.length - n - 1;
    const next = [...lines, line(item), ...(left ? [footer(left)] : []), AGENTS_END];
    if (bytes(next) > AGENTS_MAX_BYTES) break;
    lines.push(line(item));
  }
  const hidden = selected.length - (lines.length - HEAD.length);
  return [...lines, ...(hidden ? [footer(hidden)] : []), AGENTS_END].join('\n');
}

const count = (text: string, marker: string) => text.split(marker).length - 1;

/** AGENTS.md with the section in place of the old one, or added at the end; refuses broken markers. */
export function withAgentsSection(existing: string | null, section: string): { text: string } | { error: string } {
  if (existing === null) return { text: `${section}\n` };
  const [starts, ends] = [count(existing, AGENTS_START), count(existing, AGENTS_END)];
  if (starts === 0 && ends === 0) {
    const gap = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${existing}${gap}${section}\n` };
  }
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (starts !== 1 || ends !== 1 || end < start) return { error: 'AGENTS.md has sprintdigest markers that are missing, repeated or out of order; fix them by hand first.' };
  return { text: `${existing.slice(0, start)}${section}${existing.slice(end + AGENTS_END.length)}` };
}

/** CLAUDE.md with an @AGENTS.md import added at the end, or null when it already imports it. */
export function withAgentsImport(claudeMd: string): string | null {
  // Imports aren't read inside code spans or fenced blocks, so those don't count.
  const prose = claudeMd.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  if (/(^|\s)@(\.\/)?AGENTS\.md(?=\s|$)/.test(prose)) return null;
  return `${claudeMd}${claudeMd.endsWith('\n') ? '\n' : '\n\n'}@AGENTS.md\n`;
}
