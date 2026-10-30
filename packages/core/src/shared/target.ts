import type { UploadPayload } from './payload.js';
import { READER_REFUSAL, receivePush, type PushIdentity, type RetractResult } from './store.js';
import { ticketReport, type TicketReport, type TicketReportFilter } from './ticket-report.js';
import type { StoredDigest } from './digests.js';
import type { LinkResult, SharedStore, Sprint, SummaryRef, UnlinkResult } from './tickets.js';

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
export type SprintsOutcome = { status: 'ok'; sprints: Sprint[] } | Refused;
export type PreviewsOutcome = { status: 'ok'; digests: StoredDigest[] } | Refused;

export interface PushTarget {
  push(repoId: string, payload: UploadPayload): Promise<PushOutcome>;
  /** Manual ticket links on a pushed summary (DECISIONS.md D45). */
  link(repoId: string, ref: SummaryRef, ticket: string): Promise<LinkOutcome>;
  unlink(repoId: string, ref: SummaryRef, ticket: string): Promise<UnlinkOutcome>;
  /** Summaries grouped by sprint, then ticket (D46). */
  tickets(repoId: string, filter: TicketReportFilter): Promise<TicketsOutcome>;
  /** The repo's sprints, earliest first. */
  sprints(repoId: string): Promise<SprintsOutcome>;
  /** Withdraw a pushed summary; only the developer who pushed it can (D60). */
  retract(repoId: string, ref: SummaryRef): Promise<RetractOutcome>;
  /** Scheduled digests waiting in developer preview, with their text (D54). */
  previews(repoId: string): Promise<PreviewsOutcome>;
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
  };
}
