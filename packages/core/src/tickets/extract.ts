import type { TicketsConfig } from '../config.js';

// Ticket keys found in a session's git metadata (DECISIONS.md D44). Commit messages are read locally and only
// the keys they contain are kept, never the message text.

export const DEFAULT_TICKET_PATTERN = '\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b';

export type ExtractedSource = 'branch' | 'commit';

export interface ExtractedTickets {
  ticketRefs: string[];
  ticketSources: Record<string, ExtractedSource>;
}

/**
 * Branch names always count. Commit messages count only when project keys are configured, since without
 * them they match things like UTF-8 and SHA-256. With keys set, a match counts when the text before its
 * first "-" is one of them.
 */
export function extractTickets(git: { branches: readonly string[]; commitMessages: readonly string[] }, config: TicketsConfig = {}): ExtractedTickets {
  const re = new RegExp(config.pattern ?? DEFAULT_TICKET_PATTERN, 'g');
  const allowed = config.keys ? new Set(config.keys) : null;
  const counts = (key: string) => !allowed || allowed.has(key.split('-')[0]!);
  const ticketSources: Record<string, ExtractedSource> = {};
  const scan = (texts: readonly string[], source: ExtractedSource) => {
    for (const text of texts) for (const [key] of text.matchAll(re)) if (counts(key) && !ticketSources[key]) ticketSources[key] = source;
  };
  scan(git.branches, 'branch');
  if (allowed) scan(git.commitMessages, 'commit');
  return { ticketRefs: Object.keys(ticketSources), ticketSources };
}
