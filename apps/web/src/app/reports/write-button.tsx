'use client';

import { useActionState } from 'react';
import { writeReport, type WriteState } from '~/lib/report-actions';

export function WriteButton({ period }: { period: Record<string, string> }) {
  const [state, action, pending] = useActionState<WriteState, FormData>(writeReport, { error: null });
  return (
    <form action={action} className="mt-4">
      {Object.entries(period).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" disabled={pending} className="bg-accent text-on-accent rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60">
        {pending ? 'Writing the report…' : 'Write the report'}
      </button>
      {state.error ? (
        <p role="alert" className="text-amber mt-3 text-sm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
