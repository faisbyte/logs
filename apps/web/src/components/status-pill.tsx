import type { ReactNode } from 'react';

// Each accent means one thing everywhere (docs/dashboard-design.md):
// safe = green (approved, sent), attention = amber (pitfall, warning, needs a look),
// decision = blue, convention = violet, neutral = no accent.
export type Tone = 'safe' | 'attention' | 'decision' | 'convention' | 'neutral';

export const toneForItem = (type: 'pitfall' | 'decision' | 'convention'): Tone => (type === 'pitfall' ? 'attention' : type);

export const toneForDigest = (status: 'ready' | 'preview' | 'sent' | 'withdrawn'): Tone => (status === 'sent' ? 'safe' : status === 'withdrawn' ? 'attention' : 'neutral');

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span data-tone={tone} className="pill">
      {children}
    </span>
  );
}
