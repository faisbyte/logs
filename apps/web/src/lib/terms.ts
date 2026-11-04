// One user-facing term per concept, for every view (docs/dashboard-design.md, "Terminology"). Internal field names stay as
// they are; this is only what a person reads. "Tried and dropped" is a summary's rejected approach, in the timeline and the
// digest; "Pitfall" is the context item distilled from one, in the context view and the agent brief.
export const TERMS = {
  rejectedApproaches: 'Tried and dropped',
  decisions: 'Decisions',
  risksOrFollowUps: 'Follow-ups',
  editedByDeveloper: 'Edited by developer',
  autoApproved: 'Auto-approved',
  pitfall: 'Pitfall',
  decision: 'Decision',
  convention: 'Convention',
  active: 'Active',
  superseded: 'Superseded',
  retired: 'Retired',
  // A summary taken back after it was shared: the word readers see in a corrected digest.
  withdrawnSummary: 'withdrew a summary',
} as const;

export const ITEM_TYPE = { pitfall: TERMS.pitfall, decision: TERMS.decision, convention: TERMS.convention } as const;
