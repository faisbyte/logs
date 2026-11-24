import type { Period } from '~/lib/api';

export type CostSearch = { sprint?: string; from?: string; to?: string; developer?: string; place?: string };

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The period asked for, or the last 30 days. */
export function costPeriod(search: CostSearch, now: Date): Period {
  if (search.sprint) return { sprint: search.sprint };
  if (search.from && search.to) return { from: search.from, to: search.to };
  return { from: day(now.getTime() - 29 * DAY), to: day(now.getTime() + DAY) };
}
