import Link from 'next/link';
import { SectionHeader } from '~/components/section-header';

export default function NotFound() {
  return (
    <>
      <SectionHeader index="404" label="Not found" title="Nothing here" line="This page doesn't exist, or it isn't one your sign-in can open." />
      <p className="mt-6">
        <Link href="/digests" className="text-fg underline underline-offset-4">
          Go to the digests
        </Link>
      </p>
    </>
  );
}
