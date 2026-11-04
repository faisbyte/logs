'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, viewer } from '~/lib/api';

export type RetireState = { status: 'retired' | 'already'; id: string } | { status: 'error'; message: string };

/**
 * Retires a context item through the same endpoint as `sprintdigest context retire` (D80). The server decides who may: a
 * reader's session gets its 403, shown as the refusal.
 */
export async function retireItem(id: string): Promise<RetireState> {
  const me = await viewer();
  if (!me) return { status: 'error', message: 'Your session has ended. Sign in again.' };
  try {
    const result = await api.retireContextItem(me.repoId, id);
    if (result.status === 'not-found') return { status: 'error', message: `${id} no longer exists.` };
    revalidatePath('/context');
    return { status: result.status, id };
  } catch (err) {
    if (err instanceof ApiError) return { status: 'error', message: err.status === 404 ? `${id} no longer exists.` : err.message };
    throw err;
  }
}
