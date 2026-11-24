import { costCsv } from '@digest/core';
import type { NextRequest } from 'next/server';
import { api, ApiError, viewer } from '~/lib/api';
import { costPeriod } from '~/lib/cost-period';

// The cost report as CSV, for whoever may see it: the server decides, as it does for the page.
export async function GET(request: NextRequest) {
  const me = await viewer();
  if (!me) return new Response('Sign in first.\n', { status: 401 });
  try {
    const report = await api.cost(me.repoId, costPeriod(Object.fromEntries(request.nextUrl.searchParams), new Date()));
    const name = `ai-cost-${report.from.slice(0, 10)}-${report.to.slice(0, 10)}.csv`;
    return new Response(costCsv(report), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof ApiError) return new Response(`${err.message}\n`, { status: err.status });
    throw err;
  }
}
