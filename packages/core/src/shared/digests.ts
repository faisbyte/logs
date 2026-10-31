import { assertDeliverable } from '../digest/generate.js';

// Stored digests, LLM spend and per-repo digest settings (DECISIONS.md D52). On-demand reports are cached by
// period, input hash, prompt version and model; scheduled digests are kept one per period, so send-due is
// idempotent.

export type DigestKind = 'report' | 'scheduled';
/** report: ready on demand; scheduled: preview (developers only), then sent. */
/** withdrawn: sent, then a summary it included was retracted (D60); kept, never shown to readers. */
export type DigestStatus = 'ready' | 'preview' | 'sent' | 'withdrawn';

export interface NewDigest {
  repoId: string;
  kind: DigestKind;
  /** "sprint:<name>", "range:<from>/<to>" or "week:<monday>". */
  periodKey: string;
  periodLabel: string;
  from: string | null;
  to: string | null;
  inputHash: string;
  promptVersion: string;
  model: string;
  markdown: string;
  summaryCount: number;
  developerCount: number;
  costUsd: number | null;
  status: DigestStatus;
  /** When a scheduled digest in preview may be sent. */
  previewUntil: string | null;
  createdAt: string;
  /** The summaries it was written from ("agent/sessionId"), so a retraction can withdraw it (D60). */
  summaryKeys?: string[];
  /** The withdrawn digest this one corrects (D70). */
  corrects?: string | null;
}

export interface StoredDigest extends NewDigest {
  id: string;
  summaryKeys: string[];
  corrects: string | null;
  /** Channel → when it was delivered there. */
  deliveries: Record<string, string>;
  sentAt: string | null;
}

export interface ReportKey {
  periodKey: string;
  inputHash: string;
  promptVersion: string;
  model: string;
}

export interface RepoSettings {
  repoId: string;
  schedule: 'off' | 'weekly' | 'sprint-end';
  /** For weekly digests: the ISO weekday they go out on (1 = Monday), covering the 7 days before. */
  weekday: number;
  /** 0 = no developer preview; otherwise how long developers can read a digest before it is sent. */
  previewHours: number;
  emailTo: string[];
  /** The name of the server environment variable that holds the Slack webhook URL; the URL itself is a secret. */
  slackWebhookEnv: string | null;
  /** null = the server's default cap. */
  monthlyCapUsd: number | null;
  /** When the schedule was turned on: nothing before it is sent. */
  scheduleSince: string | null;
}

export type DigestPatch = Partial<Pick<StoredDigest, 'status' | 'sentAt' | 'previewUntil'>> & { deliveries?: Record<string, string> };

export interface DigestStore {
  /**
   * Stores a digest after the secret check (D50). A repeat of the same scheduled period or cached report returns the
   * one stored; a withdrawn scheduled digest doesn't count, so a corrected one can follow it (D70).
   */
  saveDigest(digest: NewDigest): Promise<StoredDigest>;
  getDigest(repoId: string, id: string): Promise<StoredDigest | null>;
  findReport(repoId: string, key: ReportKey): Promise<StoredDigest | null>;
  /** The period's scheduled digest, leaving out withdrawn ones. */
  scheduledDigest(repoId: string, periodKey: string): Promise<StoredDigest | null>;
  /** Newest first. */
  digests(repoId: string, filter?: { kinds?: DigestKind[]; statuses?: DigestStatus[] }): Promise<StoredDigest[]>;
  /** Merges deliveries; sets the other fields given. */
  updateDigest(repoId: string, id: string, patch: DigestPatch): Promise<void>;
  recordSpend(repoId: string, usd: number, at: string): Promise<void>;
  spendSince(repoId: string, since: string): Promise<number>;
  repoSettings(repoId: string): Promise<RepoSettings>;
  saveRepoSettings(repoId: string, patch: Partial<Omit<RepoSettings, 'repoId'>>): Promise<RepoSettings>;
  /** Repos with a schedule other than off. */
  scheduledRepos(): Promise<string[]>;
}

export const defaultRepoSettings = (repoId: string): RepoSettings => ({ repoId, schedule: 'off', weekday: 1, previewHours: 0, emailTo: [], slackWebhookEnv: null, monthlyCapUsd: null, scheduleSince: null });

/** The checks every DigestStore runs before keeping a digest. */
export function checkNewDigest(digest: NewDigest): void {
  assertDeliverable(digest.markdown);
}

export const sameReport = (d: NewDigest, key: ReportKey) =>
  d.kind === 'report' && d.periodKey === key.periodKey && d.inputHash === key.inputHash && d.promptVersion === key.promptVersion && d.model === key.model;
