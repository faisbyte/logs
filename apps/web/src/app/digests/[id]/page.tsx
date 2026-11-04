import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { DigestDocument } from '~/components/digest-document';
import { PrintButton } from '~/components/print-button';
import { StatusPill, toneForDigest } from '~/components/status-pill';
import { api, ApiError, viewer } from '~/lib/api';

export const metadata: Metadata = { title: 'Digest' };

const STATUS = { ready: 'Ready', preview: 'In preview', sent: 'Sent', withdrawn: 'Withdrawn' } as const;

export default async function DigestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await viewer();
  if (!me) redirect('/sign-in');
  const digest = await api.digest(me.repoId, id).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href="/digests" className="text-fg-muted hover:text-fg font-mono text-xs">
          ← All digests
        </Link>
        <PrintButton />
      </div>
      <h1 className="sr-only">{digest.periodLabel}</h1>
      {digest.status === 'withdrawn' ? (
        <p role="note" className="callout-attention no-print mt-4 rounded-md border px-4 py-3 text-sm">
          A developer withdrew a summary this digest included, so it was withdrawn. Readers no longer see it.
        </p>
      ) : null}
      <div className="mt-4">
        <DigestDocument
          markdown={digest.markdown}
          caption={
            <>
              <span>{digest.kind === 'report' ? 'Report' : 'Scheduled digest'}</span>
              <StatusPill tone={toneForDigest(digest.status)}>{STATUS[digest.status]}</StatusPill>
              <span>{digest.sentAt ? `sent ${digest.sentAt.slice(0, 10)}` : `written ${digest.createdAt.slice(0, 10)}`}</span>
            </>
          }
        />
      </div>
    </div>
  );
}
