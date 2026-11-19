// The audit log (DECISIONS.md D100): who viewed or sent what, and the other actions that change what people see. An
// event names who, their role, what and which item; it never holds content or a token. Only the admin reads it.

export type AuditAction =
  | 'digest.viewed'
  | 'digest.sent'
  | 'report.written'
  | 'summary.pushed'
  | 'summary.retracted'
  | 'context.retired'
  | 'data.deleted'
  | 'retention.applied'
  | 'token.issued'
  | 'token.revoked'
  | 'session.started';

/** server: the scheduled jobs; admin: whoever runs the server's commands (D97). */
export type AuditRole = 'developer' | 'reader' | 'admin' | 'server';

export interface AuditEvent {
  repoId: string;
  at: string;
  actorId: string;
  actorName: string;
  actorRole: AuditRole;
  action: AuditAction;
  /** The item acted on: a digest id, an "agent/sessionId", a context item id, a developer id; null when there is none. */
  target: string | null;
  /** A short label, such as a digest's period or the channels it went to; never content. */
  detail: string | null;
}

export interface AuditStore {
  recordAudit(event: AuditEvent): Promise<void>;
  /** A repo's events, newest first (by time, then by when they were recorded). */
  auditEvents(repoId: string, filter?: { since?: string; limit?: number }): Promise<AuditEvent[]>;
}

/** The actor for events from the server's scheduled jobs and the admin's commands. */
export const SERVER_ACTOR = { actorId: 'server', actorName: 'server', actorRole: 'server' } as const;
export const ADMIN_ACTOR = { actorId: 'admin', actorName: 'admin', actorRole: 'admin' } as const;
