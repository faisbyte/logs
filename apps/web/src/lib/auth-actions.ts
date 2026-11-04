'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError, SESSION_COOKIE } from '~/lib/api';

// Sign-in and sign-out (DECISIONS.md D91 option B). The pasted token goes to the digest server once and is exchanged
// for a 12-hour session; only the session id is kept, in an httpOnly, SameSite=Strict cookie. Next.js checks a server
// action's Origin against its host, so another site can't post these.

export type SignInState = { error: string | null };

export async function signIn(_: SignInState, form: FormData): Promise<SignInState> {
  const token = String(form.get('token') ?? '').trim();
  if (!token) return { error: 'Paste the token an admin issued you.' };
  let started: Awaited<ReturnType<typeof api.startSession>>;
  try {
    started = await api.startSession(token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { error: "That token isn't valid. It may have been re-issued; ask for a new one." };
    return { error: err instanceof Error ? err.message : 'Signing in failed.' };
  }
  (await cookies()).set(SESSION_COOKIE, started.session, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(started.expiresAt),
  });
  redirect('/digests');
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  // Ends the session on the server too, so a copied cookie stops working at once.
  if (session) await api.endSession(session).catch(() => undefined);
  jar.delete(SESSION_COOKIE);
  redirect('/sign-in');
}
