import type { CostReport } from '@digest/core';
import Link from 'next/link';
import { PLACE, usd } from '~/lib/cost-format';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function CostTotals({ report }: { report: CostReport }) {
  const places = (Object.keys(PLACE) as (keyof typeof PLACE)[]).filter((p) => report.places[p] > 0);
  return (
    <div className="border-line rounded-lg border p-5">
      <p>
        <span className="text-2xl font-semibold tabular-nums sm:text-3xl">{usd(report.totalMicros)}</span> <span className="text-fg-muted text-sm">estimated</span>
      </p>
      {places.length ? (
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:flex sm:flex-wrap">
          {places.map((p) => (
            <div key={p}>
              <dt className="text-fg-subtle font-mono text-xs uppercase">{PLACE[p]}</dt>
              <dd className="tabular-nums">{usd(report.places[p])}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {report.billing.subscription > 0 ? <p className="text-fg-muted mt-4 text-sm">{`${usd(report.billing.subscription)} of this was on subscriptions: an API-equivalent estimate, not money spent.`}</p> : null}
      {report.billing.unknown > 0 ? <p className="text-fg-muted mt-2 text-sm">{`${usd(report.billing.unknown)} has no billing type set, so it may or may not be money spent.`}</p> : null}
      {report.unpricedRequests ? (
        <p className="text-fg-muted mt-2 text-sm">{`${count(report.unpricedRequests, 'request has', 'requests have')} no price set, so ${report.unpricedRequests === 1 ? 'it is' : 'they are'} not in the total.`}</p>
      ) : null}
    </div>
  );
}

const cell = 'text-fg-muted tabular-nums';

/** Developers in name order, never by amount; tickets and models for this repo's period. */
export function CostBreakdown({ report, hrefFor }: { report: CostReport; hrefFor: (developerId: string) => string }) {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-2">
      {report.scope === 'all' && report.developers.length ? (
        <table className="data-table w-full text-sm">
          <caption className="text-fg-subtle mb-2 text-left font-mono text-xs whitespace-nowrap uppercase">Cost by developer</caption>
          <thead>
            <tr>
              <th scope="col">Developer</th>
              <th scope="col">Sessions</th>
              <th scope="col">Estimated</th>
            </tr>
          </thead>
          <tbody>
            {report.developers.map((d) => (
              <tr key={d.developerId}>
                <td data-label="Developer">
                  <Link href={hrefFor(d.developerId)} className="row-link text-fg font-medium underline-offset-4 hover:underline">
                    {d.developerName}
                  </Link>
                </td>
                <td data-label="Sessions" className={cell}>{d.sessions}</td>
                <td data-label="Estimated" className={cell}>{usd(d.micros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {report.tickets.length ? (
        <table className="data-table w-full text-sm">
          <caption className="text-fg-subtle mb-2 text-left font-mono text-xs whitespace-nowrap uppercase">Cost by ticket</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Title</th>
              <th scope="col">Estimated</th>
            </tr>
          </thead>
          <tbody>
            {report.tickets.map((t) => (
              <tr key={t.ticket ?? ''}>
                <td data-label="Ticket" className="font-mono">{t.ticket ?? 'No ticket'}</td>
                <td data-label="Title" className="text-fg-muted">{t.title ?? (t.ticket ? 'No title' : 'Not linked by an approved summary')}</td>
                <td data-label="Estimated" className={cell}>{usd(t.micros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {report.models.length ? (
        <table className="data-table w-full text-sm">
          <caption className="text-fg-subtle mb-2 text-left font-mono text-xs whitespace-nowrap uppercase">Cost by model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Estimated</th>
            </tr>
          </thead>
          <tbody>
            {report.models.map((m) => (
              <tr key={m.model}>
                <td data-label="Model" className="font-mono text-xs break-all">{m.model}</td>
                <td data-label="Estimated" className={cell}>{usd(m.micros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
