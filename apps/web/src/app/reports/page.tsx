import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ReportEstimate } from '~/components/report-estimate';
import { SectionHeader } from '~/components/section-header';
import { api, ApiError, viewer, type Period } from '~/lib/api';
import { WriteButton } from './write-button';

export const metadata: Metadata = { title: 'Reports' };

type Search = { sprint?: string; from?: string; to?: string };

/** The period asked for, if any: a sprint, or a complete date range. */
function periodOf(search: Search): Period | null {
  if (search.sprint) return { sprint: search.sprint };
  if (search.from && search.to) return { from: search.from, to: search.to };
  return null;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const me = await viewer();
  if (!me) redirect('/sign-in');
  const search = await searchParams;
  const sprints = await api.sprints(me.repoId);
  const period = periodOf(search);
  const estimate = period ? await api.estimate(me.repoId, period).catch((err: unknown) => (err instanceof ApiError ? err : Promise.reject(err))) : null;
  return (
    <>
      <SectionHeader index="02" label="Reports" title="Write a team report" line="A plain-language report of the team's shared AI work for any sprint or date range. You see the cost before anything is written." />

      <form method="get" className="border-line mt-8 grid max-w-3xl gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_auto_1fr_1fr_auto] sm:items-end">
        <div>
          <label htmlFor="sprint" className="text-fg-subtle block font-mono text-xs uppercase">
            Sprint
          </label>
          <select id="sprint" name="sprint" defaultValue={search.sprint ?? ''} className="border-line-strong bg-bg-elev mt-1 w-full rounded-md border px-2 py-1.5 text-sm">
            <option value="">{sprints.length ? 'Choose a sprint' : 'No sprints yet'}</option>
            {sprints.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-fg-subtle pb-2 text-center font-mono text-xs">or</p>
        <div>
          <label htmlFor="from" className="text-fg-subtle block font-mono text-xs uppercase">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={search.from} className="border-line-strong bg-bg-elev mt-1 w-full rounded-md border px-2 py-1.5 font-mono text-sm" />
        </div>
        <div>
          <label htmlFor="to" className="text-fg-subtle block font-mono text-xs uppercase">
            To (not included)
          </label>
          <input id="to" name="to" type="date" defaultValue={search.to} className="border-line-strong bg-bg-elev mt-1 w-full rounded-md border px-2 py-1.5 font-mono text-sm" />
        </div>
        <button type="submit" className="border-line-strong hover:bg-bg-subtle rounded-md border px-3 py-1.5 text-sm">
          Check the cost
        </button>
      </form>

      {estimate instanceof ApiError ? (
        <p role="alert" className="text-amber mt-6 text-sm">
          {estimate.message}
        </p>
      ) : estimate && period ? (
        <section aria-labelledby="estimate-heading" className="mt-8 max-w-3xl">
          <SectionHeader index="03" label="Estimate" title={'sprint' in period ? period.sprint : `${period.from} to ${period.to}`} level={2} id="estimate-heading" />
          <div className="mt-4">
            <ReportEstimate estimate={estimate} />
          </div>
          {estimate.canWrite ? <WriteButton period={period as Record<string, string>} /> : null}
        </section>
      ) : null}
    </>
  );
}
