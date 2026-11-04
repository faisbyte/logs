import Link from 'next/link';
import { StatusPill, toneForDigest } from '~/components/status-pill';

/** What the digest list needs: the server's stored digest without its text. */
export type DigestRow = {
  id: string;
  kind: 'report' | 'scheduled';
  periodLabel: string;
  status: 'ready' | 'preview' | 'sent' | 'withdrawn';
  summaryCount: number;
  developerCount: number;
  createdAt: string;
  sentAt: string | null;
  corrects: string | null;
  previewUntil?: string | null;
  warnings?: string[];
};

const STATUS = { ready: 'Ready', preview: 'In preview', sent: 'Sent', withdrawn: 'Withdrawn' } as const;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The archive, one row per digest, newest first as the server lists them. Stacks into labelled blocks on narrow screens. */
export function DigestTable({ digests }: { digests: DigestRow[] }) {
  if (!digests.length) {
    return (
      <div className="border-line text-fg-muted rounded-lg border border-dashed px-5 py-8 text-sm">
        <p className="text-fg font-medium">No digests yet.</p>
        <p className="mt-1">Scheduled digests appear here once one has been sent, and reports once someone writes one.</p>
      </div>
    );
  }
  return (
    <table className="data-table w-full text-sm">
      <caption className="sr-only">Digests and reports, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Kind</th>
          <th scope="col">Status</th>
          <th scope="col">Coverage</th>
          <th scope="col">Written</th>
        </tr>
      </thead>
      <tbody>
        {digests.map((d) => (
          <tr key={d.id}>
            <td data-label="Period">
              <Link href={`/digests/${d.id}`} className="row-link text-fg font-medium underline-offset-4 hover:underline">
                {d.periodLabel}
              </Link>
            </td>
            <td data-label="Kind">{d.kind === 'report' ? 'Report' : 'Scheduled'}</td>
            <td data-label="Status">
              <span className="inline-flex flex-wrap gap-1.5">
                <StatusPill tone={toneForDigest(d.status)}>{STATUS[d.status]}</StatusPill>
                {d.corrects ? <StatusPill tone="attention">Corrected</StatusPill> : null}
              </span>
            </td>
            <td data-label="Coverage" className="text-fg-muted">
              {count(d.summaryCount, 'summary', 'summaries')} · {count(d.developerCount, 'developer', 'developers')}
            </td>
            <td data-label="Written" className="text-fg-muted font-mono text-xs">
              {d.createdAt.slice(0, 10)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
