'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, viewer } from '~/lib/api';

export type CostActionState = { status: 'ok' } | { status: 'error'; message: string };

/** The server decides who may flag, reply or settle; its refusal is shown as it is. */
async function change(run: (repoId: string) => Promise<unknown>): Promise<CostActionState> {
  const me = await viewer();
  if (!me) return { status: 'error', message: 'Your session has ended. Sign in again.' };
  try {
    await run(me.repoId);
    revalidatePath('/cost');
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof ApiError) return { status: 'error', message: err.message };
    throw err;
  }
}

export async function flagSession(target: { agent: string; sessionId: string; developerId: string; note: string }): Promise<CostActionState> {
  return change((repoId) => api.flagSession(repoId, target));
}
export async function replyToFlag(id: string, text: string): Promise<CostActionState> {
  return change((repoId) => api.replyToFlag(repoId, id, text));
}
export async function settleFlag(id: string): Promise<CostActionState> {
  return change((repoId) => api.settleFlag(repoId, id));
}
