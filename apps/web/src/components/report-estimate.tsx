import { StatusPill } from '~/components/status-pill';

/** The server's GET /v1/reports/estimate answer (DECISIONS.md D92). */
export type Estimate = {
  cached: boolean;
  summaryCount: number;
  developerCount: number;
  estimateUsd: number | null;
  spentUsd: number;
  capUsd: number;
  since: string;
  fits: boolean;
  canWrite: boolean;
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a report would cost and where the monthly cap stands, shown before anything is written. */
export function ReportEstimate({ estimate: e }: { estimate: Estimate }) {
  const cost = e.cached ? 'Already written: free' : e.summaryCount === 0 ? 'No shared summaries in this period' : e.estimateUsd === null ? 'Cost unknown' : `About ${usd(e.estimateUsd)}`;
  const state = e.cached ? null : !e.fits ? <StatusPill tone="attention">Over the monthly cap</StatusPill> : <StatusPill tone="safe">Fits under the cap</StatusPill>;
  return (
    <dl className="border-line grid gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_1fr]">
      <dt className="text-fg-subtle font-mono text-xs uppercase">Covers</dt>
      <dd>{`${plural(e.summaryCount, 'summary', 'summaries')} from ${plural(e.developerCount, 'developer', 'developers')}`}</dd>
      <dt className="text-fg-subtle font-mono text-xs uppercase">Cost</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{cost}</span>
        {state}
      </dd>
      <dt className="text-fg-subtle font-mono text-xs uppercase">This month</dt>
      <dd className="font-mono">{`${usd(e.spentUsd)} of ${usd(e.capUsd)} spent since ${e.since}`}</dd>
      {!e.canWrite && e.fits && !e.cached ? (
        <dd className="text-fg-muted sm:col-span-2">The server has no API key, so it can only show reports it has already written.</dd>
      ) : null}
    </dl>
  );
}
