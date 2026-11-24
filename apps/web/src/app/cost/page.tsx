import { COST_NOTICE } from '@digest/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CostSessions } from '~/components/cost-sessions';
import { CostBreakdown, CostTotals } from '~/components/cost-summary';
import { SectionHeader } from '~/components/section-header';
import { api, ApiError, viewer } from '~/lib/api';
import { flagSession, replyToFlag, settleFlag } from '~/lib/cost-actions';
import { PLACE } from '~/lib/cost-format';
import { costPeriod, type CostSearch } from '~/lib/cost-period';

export const metadata: Metadata = { title: 'Cost' };

const field = 'border-line-strong bg-bg-elev mt-1 w-full rounded-md border px-2 py-1.5 text-sm';
const label = 'text-fg-subtle block font-mono text-xs uppercase';

export default async function CostPage({ searchParams }: { searchParams: Promise<CostSearch> }) {
  const me = await viewer();
  if (!me) redirect('/sign-in');
  if (me.costAccess !== 'all' && me.costAccess !== 'own') notFound();
  const search = await searchParams;
  const period = costPeriod(search, new Date());
  const sprints = await api.sprints(me.repoId);
  const report = await api.cost(me.repoId, period).catch((err: unknown) => (err instanceof ApiError ? err : Promise.reject(err)));

  const href = (over: CostSearch) => {
    const params = Object.entries({ ...period, developer: search.developer, place: search.place, ...over }).filter((e): e is [string, string] => Boolean(e[1]));
    return `/cost?${new URLSearchParams(params)}`;
  };
  const all = me.costAccess === 'all';
  return (
    <>
      <SectionHeader
        index="05"
        label="Cost"
        title={all ? 'AI cost' : 'Your AI cost'}
        line={all ? 'What AI development cost on this repo, by developer, day and session. Developers see their own rows exactly as you do.' : 'Your own AI cost, exactly as managers and POs with cost access see it.'}
      />

      <form method="get" className="border-line mt-8 grid max-w-4xl gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_auto_1fr_1fr_auto] sm:items-end">
        <div>
          <label htmlFor="sprint" className={label}>
            Sprint
          </label>
          <select id="sprint" name="sprint" defaultValue={search.sprint ?? ''} className={field}>
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
          <label htmlFor="from" className={label}>
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={'from' in period ? period.from : ''} className={field} />
        </div>
        <div>
          <label htmlFor="to" className={label}>
            To (not included)
          </label>
          <input id="to" name="to" type="date" defaultValue={'to' in period ? period.to : ''} className={field} />
        </div>
        <button type="submit" className="border-line-strong hover:bg-bg-subtle rounded-md border px-3 py-1.5 text-sm">
          Show
        </button>
      </form>

      {report instanceof ApiError ? (
        <p role="alert" className="text-amber mt-6 text-sm">{report.message}</p>
      ) : (
        <>
          <section aria-label="Totals" className="mt-8 max-w-4xl">
            <CostTotals report={report} />
          </section>
          <section aria-label="Breakdown" className="mt-8">
            <CostBreakdown report={report} hrefFor={(developer) => `${href({ developer })}#sessions`} />
          </section>
          <section aria-labelledby="sessions" className="mt-10">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="sessions" className="text-lg font-semibold">
                Sessions
              </h2>
              <a href={`/cost/export?${new URLSearchParams(period as Record<string, string>)}`} className="text-sm underline underline-offset-4">
                Download as CSV
              </a>
            </div>
            <nav aria-label="Where the work was" className="mt-3">
              <ul className="flex flex-wrap gap-1.5 text-sm">
                {[['', 'Everywhere'] as const, ...(Object.entries(PLACE) as [string, string][])].map(([place, name]) => {
                  const current = (search.place ?? '') === place;
                  return (
                    <li key={place}>
                      <Link
                        href={`${href({ place })}#sessions`}
                        aria-current={current ? 'true' : undefined}
                        className={`block rounded-full border px-3 py-1 ${current ? 'border-fg bg-bg-subtle text-fg' : 'border-line-strong text-fg-muted hover:text-fg'}`}
                      >
                        {name}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
            {search.developer && all ? (
              <p className="text-fg-muted mt-3 text-sm">
                {`Only ${report.developers.find((d) => d.developerId === search.developer)?.developerName ?? search.developer}. `}
                <Link href={`${href({ developer: '' })}#sessions`} className="text-fg underline underline-offset-4">
                  Show everyone
                </Link>
              </p>
            ) : null}
            <div className="mt-4">
              <CostSessions
                sessions={report.sessions.filter((s) => (!search.place || s.place === search.place) && (!search.developer || s.developerId === search.developer))}
                scope={report.scope}
                flag={flagSession}
                reply={replyToFlag}
                settle={settleFlag}
              />
            </div>
          </section>
        </>
      )}

      <section aria-labelledby="notice" className="border-line mt-10 max-w-3xl border-t pt-6">
        <h2 id="notice" className="text-sm font-semibold">
          What is recorded, and who sees it
        </h2>
        <p className="text-fg-muted mt-2 text-sm">{COST_NOTICE}</p>
        <p className="text-fg-muted mt-2 text-sm">Work outside shared repos can be a new project, a test folder or another team’s repo. Cost alone can’t say what it was for, so ask before assuming.</p>
      </section>
    </>
  );
}
