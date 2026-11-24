import { recordCommit, type CommitResult } from '../cost/ingest.js';
import { costReport, type CostReport } from '../cost/report.js';
import type { Agent } from '../schema.js';
import type { ContextItem } from '../context/item.js';
import type { RetireResult } from '../context/store.js';
import type { UploadPayload } from './payload.js';
import { READER_REFUSAL, receivePush, type DataDeletion, type PushIdentity, type RetractResult } from './store.js';
import { ticketReport, type TicketReport, type TicketReportFilter } from './ticket-report.js';
import type { StoredDigest } from './digests.js';
import type { LinkResult, SharedStore, Sprint, SummaryRef, TitleResult, UnlinkResult } from './tickets.js';

// What the CLI talks to: the shared store behind its token. The token lives inside the target, never in a summary.

/** What a pusher learns about one push. */
export type PushOutcome =
  | { status: 'created' | 'unchanged' }
  | { status: 'conflict' | 'unauthorized' | 'forbidden'; reason: string }
  | { status: 'rejected'; errors: string[] };

type Refused = { status: 'unauthorized' | 'forbidden'; reason: string };
export type LinkOutcome = LinkResult | Refused;
export type UnlinkOutcome = UnlinkResult | Refused;
export type TicketsOutcome = { status: 'ok'; report: TicketReport } | Refused;
export type RetractOutcome = RetractResult | Refused;
export type TitleOutcome = TitleResult | Refused;
export type SprintsOutcome = { status: 'ok'; sprints: Sprint[] } | Refused;
export type PreviewsOutcome = { status: 'ok'; digests: StoredDigest[] } | Refused;
export type ContextItemsOutcome = { status: 'ok'; items: ContextItem[] } | Refused;
export type RetireOutcome = RetireResult | Refused;
export type DeletionOutcome = ({ status: 'deleted' } & DataDeletion) | Refused;

export type CostOutcome = { status: 'ok'; report: CostReport } | { status: 'off' } | { status: 'invalid'; reason: string } | Refused;
export type CommitOutcome = CommitResult | Refused;

export interface PushTarget {
  push(repoId: string, payload: UploadPayload): Promise<PushOutcome>;
  /** Manual ticket links on a pushed summary (DECISIONS.md D45). */
  link(repoId: string, ref: SummaryRef, ticket: string): Promise<LinkOutcome>;
  unlink(repoId: string, ref: SummaryRef, ticket: string): Promise<UnlinkOutcome>;
  /** Summaries grouped by sprint, then ticket (D46). */
  tickets(repoId: string, filter: TicketReportFilter): Promise<TicketsOutcome>;
  /** Set a ticket's title for reports and digests, when no tracker gives one (D67). */
  setTicketTitle(repoId: string, ticket: string, title: string): Promise<TitleOutcome>;
  /** The repo's sprints, earliest first. */
  sprints(repoId: string): Promise<SprintsOutcome>;
  /** Withdraw a pushed summary; only the developer who pushed it can (D60). */
  retract(repoId: string, ref: SummaryRef): Promise<RetractOutcome>;
  /** Scheduled digests waiting in developer preview, with their text (D54). */
  previews(repoId: string): Promise<PreviewsOutcome>;
  /** Every context item, any status, newest first: developers only (D77). */
  contextItems(repoId: string): Promise<ContextItemsOutcome>;
  /** Retire a wrong context item; it never comes back automatically (D77). */
  retireContextItem(repoId: string, id: string): Promise<RetireOutcome>;
  /** Delete everything this developer pushed to the repo, and what was derived only from it (D98). */
  deleteMyData(repoId: string): Promise<DeletionOutcome>;
  /** This developer's own AI cost (D107). */
  cost(repoId: string, filter: TicketReportFilter): Promise<CostOutcome>;
  /** A commit made during a session: its hash and the session, nothing else (D107). */
  recordCommit(repoId: string, commit: { agent: Agent; sessionId: string; sha: string }): Promise<CommitOutcome>;
}

/** A PushTarget for a store in this process (tests, and local end-to-end runs). */
export function localPushTarget(store: SharedStore, token: string): PushTarget {
  const as = async (repoId: string): Promise<PushIdentity | Refused> => {
    const identity = await store.authenticate(token);
    if (!identity) return { status: 'unauthorized', reason: 'unknown or revoked token' };
    if (identity.repoId !== repoId) return { status: 'forbidden', reason: 'this token is for a different repo' };
    if (identity.role !== 'developer') return { status: 'forbidden', reason: READER_REFUSAL };
    return identity;
  };
  const refused = (x: PushIdentity | Refused): x is Refused => 'status' in x;
  return {
    push: (repoId, payload) => receivePush(store, token, repoId, payload),
    async link(repoId, ref, ticket) {
      const identity = await as(repoId);
      return refused(identity) ? identity : store.addTicketLink(identity, ref, ticket);
    },
    async unlink(repoId, ref, ticket) {
      const identity = await as(repoId);
      return refused(identity) ? identity : store.removeTicketLink(identity, ref, ticket);
    },
    async tickets(repoId, filter) {
      const identity = await as(repoId);
      return refused(identity) ? identity : { status: 'ok', report: await ticketReport(store, repoId, filter) };
    },
    async setTicketTitle(repoId, ticket, title) {
      const identity = await as(repoId);
      return refused(identity) ? identity : store.setTicketTitle(identity, ticket, title);
    },
    async sprints(repoId) {
      const identity = await as(repoId);
      return refused(identity) ? identity : { status: 'ok', sprints: await store.sprints(repoId) };
    },
    async retract(repoId, ref) {
      const identity = await as(repoId);
      return refused(identity) ? identity : store.retract(identity, ref);
    },
    async previews(repoId) {
      const identity = await as(repoId);
      return refused(identity) ? identity : { status: 'ok', digests: await store.digests(repoId, { statuses: ['preview'] }) };
    },
    async contextItems(repoId) {
      const identity = await as(repoId);
      return refused(identity) ? identity : { status: 'ok', items: await store.contextItems(repoId) };
    },
    async retireContextItem(repoId, id) {
      const identity = await as(repoId);
      return refused(identity) ? identity : store.retireContextItem(identity, id);
    },
    async deleteMyData(repoId) {
      const identity = await as(repoId);
      return refused(identity) ? identity : { status: 'deleted', ...(await store.deleteDeveloperData(identity)) };
    },
    async cost(repoId, filter) {
      const identity = await as(repoId);
      if (refused(identity)) return identity;
      const range = 'sprint' in filter ? (await store.sprints(repoId)).find((s) => s.name === filter.sprint) : filter;
      if (!range) return { status: 'invalid', reason: 'no such sprint' };
      const result = await costReport(store, { ...identity, role: 'developer' }, range);
      return result.status === 'ok' ? result : { status: 'off' };
    },
    async recordCommit(repoId, commit) {
      const identity = await as(repoId);
      return refused(identity) ? identity : recordCommit(store, identity, commit, new Date());
    },
  };
}
