import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDigestDir } from './digest-dir.js';
import type { Agent } from './schema.js';

// Tracks sessions already processed, per repo, in .digest/state.json (DECISIONS.md D9).

export const DigestStateSchema = z.object({
  version: z.literal(1),
  sessions: z.record(
    z.string(),
    z.object({
      fingerprint: z.string(),
      processedAt: z.iso.datetime(),
    }),
  ),
});
export type DigestState = z.infer<typeof DigestStateSchema>;
export type SessionStatus = 'new' | 'changed' | 'processed';

const STATE_FILE = join('.digest', 'state.json');

export const sessionKey = (s: { agent: Agent; sourceSessionId: string }) => `${s.agent}:${s.sourceSessionId}`;

/** Content hash of a session file; sessions are append-only, so any new activity changes it. */
export const fingerprintFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function readState(repoRoot: string): DigestState {
  const file = join(repoRoot, STATE_FILE);
  if (!existsSync(file)) return { version: 1, sessions: {} };
  try {
    return DigestStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    // Resetting would make every session look new again, so make the user decide.
    throw new Error(`Unreadable ${STATE_FILE} in ${repoRoot}: fix or delete it. (${(err as Error).message})`);
  }
}

export function writeState(repoRoot: string, state: DigestState): void {
  ensureDigestDir(repoRoot);
  writeFileSync(join(repoRoot, STATE_FILE), JSON.stringify(DigestStateSchema.parse(state), null, 2) + '\n');
}

export function markProcessed(state: DigestState, key: string, fingerprint: string, now: Date): DigestState {
  return { ...state, sessions: { ...state.sessions, [key]: { fingerprint, processedAt: now.toISOString() } } };
}

export function sessionStatus(state: DigestState, key: string, fingerprint: string): SessionStatus {
  const entry = state.sessions[key];
  if (!entry) return 'new';
  return entry.fingerprint === fingerprint ? 'processed' : 'changed';
}
