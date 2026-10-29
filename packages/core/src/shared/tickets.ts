import { z } from 'zod';
import type { Agent } from '../schema.js';
import { contentProblems } from './payload.js';
import type { DigestStore } from './digests.js';
import type { PushIdentity, StoredSummary, SummaryStore, TokenStore } from './store.js';

// Tickets and sprints on the shared store (DECISIONS.md D45). Ticket keys inside a pushed summary never change.
// Manual links added after a push, sprints, and what a tracker says about tickets are separate records that
// can change, and are joined in only when summaries are grouped.

export type TicketLinkSource = 'branch' | 'commit' | 'manual' | 'api';

/** One summary linked to one ticket (PROJECT_PLAN.md section 5). Manual links say who added them and when. */
export interface TicketLink {
  sessionId: string;
  ticketKey: string;
  source: TicketLinkSource;
  addedBy: string | null;
  addedAt: string | null;
}

export interface SummaryRef {
  agent: Agent;
  sessionId: string;
}

/** A link added after the push by the developer who pushed the summary. */
export interface ManualTicketLink extends SummaryRef {
  repoId: string;
  ticketKey: string;
  /** Developer id. */
  addedBy: string;
  addedAt: string;
}

/** A named date range, [from, to). A session belongs to the sprint containing its start. */
export interface Sprint {
  name: string;
  from: string;
  to: string;
}

/** What a tracker (Jira, Linear) says about a ticket it knows. */
export interface TrackerTicket {
  key: string;
  title: string | null;
  sprint: string | null;
}

export type LinkResult = { status: 'created' | 'unchanged' } | { status: 'not-found' | 'forbidden' | 'rejected'; reason: string };
export type UnlinkResult = { status: 'removed' } | { status: 'not-found' | 'forbidden' | 'in-summary'; reason: string };
export type SprintResult = { status: 'saved' } | { status: 'invalid'; reason: string };

export interface TicketStore {
  addTicketLink(identity: PushIdentity, ref: SummaryRef, ticketKey: string): Promise<LinkResult>;
  removeTicketLink(identity: PushIdentity, ref: SummaryRef, ticketKey: string): Promise<UnlinkResult>;
  ticketLinks(repoId: string): Promise<ManualTicketLink[]>;
  /** Adds a sprint, or replaces the one with the same name. */
  saveSprint(repoId: string, sprint: Sprint): Promise<SprintResult>;
  removeSprint(repoId: string, name: string): Promise<boolean>;
  /** Earliest first. */
  sprints(repoId: string): Promise<Sprint[]>;
  /** Replaces what was known about each given key. */
  saveTrackerTickets(repoId: string, tickets: TrackerTicket[]): Promise<void>;
  /** Sorted by key. */
  trackerTickets(repoId: string): Promise<TrackerTicket[]>;
}

export type SharedStore = SummaryStore & TokenStore & TicketStore & DigestStore;

const TicketKeySchema = z.string().min(1, 'must not be empty').max(100, 'must be at most 100 characters').regex(/^\S+$/, 'must be a single word such as PROJ-142');

/** Why a ticket key from a client can't be stored, without echoing it. */
export function ticketKeyProblems(key: unknown): string[] {
  const parsed = TicketKeySchema.safeParse(key);
  if (!parsed.success) return parsed.error.issues.map((i) => `ticket: ${i.message}`);
  return contentProblems('ticket', parsed.data);
}

/** The rules for adding a manual link; `linked` says whether that manual link already exists. */
export function decideLink(identity: PushIdentity, stored: StoredSummary | undefined, ticketKey: unknown, linked: boolean): LinkResult | { status: 'create' } {
  const problems = ticketKeyProblems(ticketKey);
  if (problems.length) return { status: 'rejected', reason: problems.join('; ') };
  if (!stored || stored.retractedAt) return { status: 'not-found', reason: 'no pushed summary for that session in this repo' };
  if (stored.developerId !== identity.developerId) return { status: 'forbidden', reason: 'only the developer who pushed a summary can change its ticket links' };
  if (linked || stored.summary.ticketRefs.includes(ticketKey as string)) return { status: 'unchanged' };
  return { status: 'create' };
}

/** The rules for removing a manual link. Ticket keys inside a summary can't be removed. */
export function decideUnlink(identity: PushIdentity, stored: StoredSummary | undefined, ticketKey: string, linked: boolean): UnlinkResult | { status: 'remove' } {
  if (!stored || stored.retractedAt) return { status: 'not-found', reason: 'no pushed summary for that session in this repo' };
  if (stored.developerId !== identity.developerId) return { status: 'forbidden', reason: 'only the developer who pushed a summary can change its ticket links' };
  if (stored.summary.ticketRefs.includes(ticketKey)) return { status: 'in-summary', reason: 'that ticket key is part of the approved summary, which never changes once pushed' };
  if (!linked) return { status: 'not-found', reason: 'no manual link to that ticket' };
  return { status: 'remove' };
}

const SprintSchema = z.strictObject({
  name: z.string().trim().min(1, 'needs a name').max(100, 'name must be at most 100 characters'),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

/** Validates a sprint against the repo's others: sprints never overlap, so each date falls in at most one. */
export function decideSprint(existing: readonly Sprint[], input: Sprint): SprintResult | { status: 'save'; sprint: Sprint } {
  const parsed = SprintSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid', reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'sprint'}: ${i.message}`).join('; ') };
  const sprint = { name: parsed.data.name, from: new Date(parsed.data.from).toISOString(), to: new Date(parsed.data.to).toISOString() };
  if (sprint.to <= sprint.from) return { status: 'invalid', reason: `${sprint.name} ends before it starts` };
  const clash = existing.find((s) => s.name !== sprint.name && sprint.from < s.to && s.from < sprint.to);
  if (clash) return { status: 'invalid', reason: `${sprint.name} overlaps ${clash.name}` };
  return { status: 'save', sprint };
}

export const byFrom = (a: Sprint, b: Sprint) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name);
export const byLinkTime = (a: ManualTicketLink, b: ManualTicketLink) => a.addedAt.localeCompare(b.addedAt) || a.ticketKey.localeCompare(b.ticketKey);
