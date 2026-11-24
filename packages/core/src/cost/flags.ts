import { contentProblems } from '../shared/payload.js';
import type { Identity } from '../shared/store.js';
import type { SharedStore } from '../shared/tickets.js';
import { costAccess } from './report.js';
import type { CostFlag, FlagNote } from './store.js';

// Flags (Phase 12, DECISIONS.md D106): someone with cost access asks about a session; the developer it is about sees the
// flag, and can reply and settle it. Cost can't show what work was for, so a flag is a question, never a finding.

type Refusal = { status: 'forbidden' | 'not-found' | 'invalid'; reason: string };
export type FlagResult = { status: 'ok'; flag: CostFlag } | Refusal;
export type FlagChange = { status: 'ok' } | Refusal;

const MAX_NOTE = 1000;
const NOT_FOUND: Refusal = { status: 'not-found', reason: 'no such open flag' };

function noteFrom(who: Identity, text: unknown, now: Date): { note: FlagNote } | Refusal {
  if (typeof text !== 'string' || !text.trim()) return { status: 'invalid', reason: 'note: must not be empty' };
  if (text.length > MAX_NOTE) return { status: 'invalid', reason: `note: must be at most ${MAX_NOTE} characters` };
  const problems = contentProblems('note', text);
  if (problems.length) return { status: 'invalid', reason: problems.join('; ') };
  return { note: { by: who.developerId, name: who.developerName, role: who.role, at: now.toISOString(), text: text.trim() } };
}

export async function flagSession(store: SharedStore, who: Identity, input: { agent?: unknown; sessionId?: unknown; developerId?: unknown; note?: unknown }, now: Date): Promise<FlagResult> {
  if ((await costAccess(store, who)) !== 'all') return { status: 'forbidden', reason: 'only someone with cost access to this repo can flag a session' };
  const { agent, sessionId, developerId } = input;
  const registered = (await store.costConfig('account')).some((a) => a.repoId === who.repoId && a.developerId === developerId);
  const found = registered && (await store.usage({ developerIds: [developerId as string], from: '0000-01-01T00:00:00.000Z', to: '9999-01-01T00:00:00.000Z' })).find((r) => r.agent === agent && r.sessionId === sessionId);
  if (!found) return { status: 'not-found', reason: 'no such session on this repo' };
  const made = input.note === undefined || input.note === null || input.note === '' ? null : noteFrom(who, input.note, now);
  if (made && 'status' in made) return made;
  const flag = await store.saveFlag(
    { repoId: who.repoId, agent: found.agent, sessionId: found.sessionId, developerId: found.developerId, flaggedBy: who.developerId, flaggedByName: who.developerName, flaggedAt: now.toISOString() },
    made?.note ?? null,
  );
  return { status: 'ok', flag };
}

/** The open flag, when this person may answer it; otherwise it might as well not exist. */
async function openFlag(store: SharedStore, who: Identity, id: string): Promise<CostFlag | null> {
  const access = await costAccess(store, who);
  const flag = (await store.flags(who.repoId)).find((f) => f.id === id && !f.resolvedAt);
  return flag && (access === 'all' || (access === 'own' && flag.developerId === who.developerId)) ? flag : null;
}

export async function replyToFlag(store: SharedStore, who: Identity, id: string, text: unknown, now: Date): Promise<FlagChange> {
  if (!(await openFlag(store, who, id))) return NOT_FOUND;
  const made = noteFrom(who, text, now);
  if ('status' in made) return made;
  return (await store.addFlagNote(who.repoId, id, made.note)) ? { status: 'ok' } : NOT_FOUND;
}

export async function settleFlag(store: SharedStore, who: Identity, id: string, now: Date): Promise<FlagChange> {
  if (!(await openFlag(store, who, id))) return NOT_FOUND;
  return (await store.resolveFlag(who.repoId, id, who.developerName, now.toISOString())) ? { status: 'ok' } : NOT_FOUND;
}
