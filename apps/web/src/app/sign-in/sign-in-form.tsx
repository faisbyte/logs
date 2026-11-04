'use client';

import { useActionState } from 'react';
import { signIn, type SignInState } from '~/lib/auth-actions';

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { error: null });
  return (
    <form action={action} className="mt-6 max-w-md space-y-3">
      <label htmlFor="token" className="block text-sm font-medium">
        Your token
      </label>
      <input
        id="token"
        name="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        aria-describedby={state.error ? 'token-error token-help' : 'token-help'}
        aria-invalid={state.error ? true : undefined}
        className="border-line-strong bg-bg-elev w-full rounded-md border px-3 py-2 font-mono text-sm"
      />
      <p id="token-help" className="text-fg-muted text-sm">
        It is sent once to the logs server and swapped for a session that lasts 12 hours. The token itself isn&apos;t kept in this browser.
      </p>
      {state.error ? (
        <p id="token-error" role="alert" className="text-amber text-sm">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="bg-fg text-bg rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
