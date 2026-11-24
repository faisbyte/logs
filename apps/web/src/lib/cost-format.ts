// How AI cost reads on screen. Amounts arrive as millionths of a US dollar, and are always estimates (D107).
export function usd(micros: number | null): string {
  if (micros === null) return 'No price';
  if (micros > 0 && micros < 10_000) return '<$0.01';
  return (micros / 1e6).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Neutral words: cost can't show what work was for.
export const PLACE = { shared: 'Shared repo', company: 'Other company repo', outside: 'Outside company repos', unknown: 'Repo not reported' } as const;
export const AGENT = { 'claude-code': 'Claude Code', codex: 'Codex' } as const;

/** A commit's page, on hosts whose address for one is known. */
export function commitUrl(repoId: string, sha: string): string | null {
  return /^(github|gitlab)\.com\//.test(repoId) ? `https://${repoId}/commit/${sha}` : null;
}
