import { contentProblems } from '../shared/payload.js';

// Context items (DECISIONS.md D76): durable team knowledge distilled from approved summaries. An agent reads them
// as context before it starts work, so each one must be a statement of fact with its reason, never a command:
// anything that reads like an instruction, a shell command, a URL or a secret is refused.

export type ContextItemType = 'decision' | 'convention' | 'pitfall';
/** superseded: a newer item on the same topic replaced it; retired: a developer or a retraction took it out. */
export type ContextItemStatus = 'active' | 'superseded' | 'retired';

export interface ContextItem {
  id: string;
  repoId: string;
  type: ContextItemType;
  /** One sentence. */
  text: string;
  /** One sentence: why. */
  reason: string;
  /** Repo-relative files or directories it is about. */
  paths: string[];
  /** Ticket keys of its source summaries. */
  tickets: string[];
  /** The summaries it came from, as "agent/sessionId". */
  sources: string[];
  /** Day of the newest source summary's end, YYYY-MM-DD. */
  date: string;
  status: ContextItemStatus;
  supersededBy: string | null;
  /** A developer id, or "retraction" when every source summary was retracted. */
  retiredBy: string | null;
  retiredAt: string | null;
  createdAt: string;
}

export const MAX_SENTENCE = 300;

const SHELL = [
  /`[^`]+`/,
  /\$\(|\$\{/,
  /\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
  /&&|\|\|/,
  /\b(curl|wget|sudo|chmod|chown|powershell|iex)\s+\S/i,
  /\brm\s+(-\w|\/|~|\.)/,
  /\b(npm|pnpm|yarn|npx|pip3?|brew|apt(-get)?|docker|kubectl|git|gh|node|python3?)\s+(install|add|i|run|exec|dlx|remove|uninstall|push|pull|reset|rebase|commit|config|clone|checkout|fetch|merge|rm|-{1,2}\w)/i,
];
const URL = [/\b[a-z][a-z0-9+.-]*:\/\/\S/i, /\bwww\.\S/i, /\b[\w-]+\.(com|io|net|org|dev|ai|xyz|co)\b/i];
// Imperative openings and injection phrases: an item states what is true, it doesn't tell the reader what to do.
const IMPERATIVE =
  /^(please\s+)?(always|never|ignore|disregard|forget|override|run|execute|install|add|set|export|use|paste|send|upload|download|delete|remove|disable|enable|call|fetch|copy|commit|push|grant|give|store|save|put|make|ensure|avoid|prefer|do|don't|do not|keep|skip|check|update|change|write|read|open|create|follow|trust|approve|merge|bypass|allow|deny)\b/i;
const INSTRUCTION = [
  IMPERATIVE,
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|rules?|prompts?|messages?|guidelines?)\b/i,
  /\bsystem prompt\b/i,
  /\b(you|your|yourself)\b/i,
  /\b(make sure|be sure to)\b/i,
];
const CREDENTIAL = /\b(passwords?|passphrases?|api[ -]?keys?|secret keys?|private keys?|access keys?|ssh keys?|credentials?)\b/i;
const AGENT_PERMISSION = /\b(agents?|assistants?|claude|codex|tools?)\s+(may|should|must|is allowed|are allowed)\b|\bwithout (asking|approval|confirmation|review)\b/i;

/** Strips the abbreviations whose dots aren't sentence ends. */
const sentences = (text: string) => text.replace(/\b(e\.g|i\.e|etc|vs|cf)\./gi, '$1').trim().split(/(?<=[.!?])\s+(?=\S)/).length;

function textProblems(field: string, text: string): string[] {
  if (!text.trim()) return [`${field}: is missing`];
  const problems: string[] = [];
  if (text.length > MAX_SENTENCE) problems.push(`${field}: is longer than ${MAX_SENTENCE} characters`);
  if (sentences(text) > 1) problems.push(`${field}: must be one sentence`);
  if (SHELL.some((re) => re.test(text))) problems.push(`${field}: contains a shell command`);
  if (URL.some((re) => re.test(text))) problems.push(`${field}: contains a URL`);
  if (INSTRUCTION.some((re) => re.test(text.trim()))) problems.push(`${field}: reads as an instruction, not a statement of fact`);
  if (CREDENTIAL.test(text)) problems.push(`${field}: talks about handling a credential`);
  if (AGENT_PERMISSION.test(text)) problems.push(`${field}: talks about what agents or tools may do`);
  // Secrets and transcript content: the same detectors a push goes through, which never echo the value (D40).
  problems.push(...contentProblems(field, text));
  return problems;
}

const repoRelative = (path: string) => path.length > 0 && path.length <= 500 && !/^([/~\\]|[a-z]:)/i.test(path) && !/\\/.test(path) && !path.split('/').includes('..') && !/:\/\//.test(path);

/** Everything wrong with an item's text, reason and paths. Problems name the field, never the matched value. */
export function itemProblems(item: { text: string; reason: string; paths: readonly string[] }): string[] {
  return [
    ...textProblems('text', item.text),
    ...textProblems('reason', item.reason),
    ...item.paths.flatMap((p, i) => (repoRelative(p) ? contentProblems(`paths.${i}`, p) : [`paths.${i}: must be repo-relative`])),
  ];
}
