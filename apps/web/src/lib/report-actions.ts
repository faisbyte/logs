'use server';

import { redirect } from 'next/navigation';
import { api, ApiError, viewer, type Period } from '~/lib/api';

export type WriteState = { error: string | null };

/** Writes (or fetches the cached) report for a period, then opens it. The server applies the cost cap again (D53). */
export async function writeReport(_: WriteState, form: FormData): Promise<WriteState> {
  const me = await viewer();
  if (!me) redirect('/sign-in');
  const sprint = String(form.get('sprint') ?? '');
  const period: Period = sprint ? { sprint } : { from: String(form.get('from') ?? ''), to: String(form.get('to') ?? '') };
  let id: string;
  try {
    id = (await api.writeReport(me.repoId, period)).digest.id;
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Writing the report failed.' };
  }
  redirect(`/digests/${id}`);
}
