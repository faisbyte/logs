import type { Agent } from '../schema.js';
import type { UsageEvent } from './telemetry.js';

// What cost tracking keeps (Phase 12, DECISIONS.md D106, D107): usage records, commits, flags and the admin's settings.
// Developer ids mean the same person across every repo on one server.

/** company: a registered company repo; outside: any other repo; unknown: the agent reported no repo. */
export type Place = 'company' | 'outside' | 'unknown';

/** One model request. The repo is kept only when it is a company repo; nothing about any other repo is. */
export interface CostRecord extends Omit<UsageEvent, 'account' | 'organizationId'> {
  developerId: string;
  developerName: string;
  place: Place;
}

/** A commit made during a session, in a repo with cost tracking on. */
export interface CostCommit {
  repoId: string;
  agent: Agent;
  sessionId: string;
  developerId: string;
  sha: string;
  at: string;
}

export interface FlagNote {
  by: string;
  name: string;
  role: 'reader' | 'developer';
  at: string;
  text: string;
}

/** A session someone with cost access wants to discuss: a question, not a finding. */
export interface NewFlag {
  repoId: string;
  agent: Agent;
  sessionId: string;
  developerId: string;
  flaggedBy: string;
  flaggedByName: string;
  flaggedAt: string;
}
export interface CostFlag extends NewFlag {
  id: string;
  notes: FlagNote[];
  resolvedAt: string | null;
  /** Display name. */
  resolvedBy: string | null;
}

export interface CostAccount {
  repoId: string;
  email: string;
  developerId: string;
  developerName: string;
  /** When set, only usage signed in to this organisation counts. */
  organizationId: string | null;
  billing: 'api' | 'subscription' | null;
  /** Nothing more is recorded; what was stays in the report. */
  removedAt: string | null;
}

/** US dollars per million tokens, from a date on, for models whose agent reports no cost. */
export interface CostPrice {
  model: string;
  from: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface CostConfig {
  /** Repos where cost tracking is on; developersTold is the admin's confirmation. */
  repo: { repoId: string; enabledAt: string; developersTold: true };
  account: CostAccount;
  /** Company repos beyond those: "host/org/repo" or "host/org/*". */
  pattern: { pattern: string };
  grant: { repoId: string; readerId: string };
  /** Telemetry credentials, hashed. */
  ingest: { label: string; hash: string; createdAt: string };
  price: CostPrice;
  retention: { days: number };
}

export interface CostStore {
  /** Keeps records not seen before (by key); returns how many were new. */
  recordUsage(records: CostRecord[]): Promise<number>;
  /** [from, to), oldest first. */
  usage(query: { developerIds: string[]; from: string; to: string }): Promise<CostRecord[]>;
  /** Deletes usage, commits and flags from before a time; returns how many usage records went. */
  purgeUsageBefore(before: string): Promise<number>;
  deleteCostData(developerId: string): Promise<{ records: number; commits: number; flags: number }>;
  /** False when the repo already has that commit. */
  saveCommit(commit: CostCommit): Promise<boolean>;
  /** Oldest first. */
  commits(query: { developerIds: string[] }): Promise<CostCommit[]>;
  /** Opens a flag, or returns the one already open on that session in that repo. */
  saveFlag(flag: NewFlag, note: FlagNote | null): Promise<CostFlag>;
  addFlagNote(repoId: string, id: string, note: FlagNote): Promise<boolean>;
  /** False when there is no such open flag. */
  resolveFlag(repoId: string, id: string, by: string, at: string): Promise<boolean>;
  /** Oldest first. */
  flags(repoId: string): Promise<CostFlag[]>;
  /** Sorted by key. */
  costConfig<K extends keyof CostConfig>(kind: K): Promise<CostConfig[K][]>;
  putCostConfig<K extends keyof CostConfig>(kind: K, key: string, value: CostConfig[K]): Promise<void>;
  removeCostConfig(kind: keyof CostConfig, key: string): Promise<boolean>;
}
