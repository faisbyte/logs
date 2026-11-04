import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DigestTable } from '~/components/digest-table';
import { SectionHeader } from '~/components/section-header';
import { api, viewer } from '~/lib/api';

export const metadata: Metadata = { title: 'Digests' };

export default async function DigestsPage() {
  const me = await viewer();
  if (!me) redirect('/sign-in');
  const digests = await api.digests(me.repoId);
  return (
    <>
      <SectionHeader
        index="01"
        label="Digests"
        title="Digests and reports"
        line={me.role === 'reader' ? 'Every update sent to you, and every report written on demand.' : 'Every update sent to stakeholders and every report, including ones still in preview or withdrawn.'}
      />
      <p className="text-fg-subtle mt-4 font-mono text-xs">{me.repoId}</p>
      <div className="mt-6">
        <DigestTable digests={digests} />
      </div>
    </>
  );
}
