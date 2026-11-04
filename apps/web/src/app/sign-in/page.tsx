import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SectionHeader } from '~/components/section-header';
import { viewer } from '~/lib/api';
import { SERVER_CLI } from '~/lib/brand';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage() {
  if (await viewer().catch(() => null)) redirect('/digests');
  return (
    <>
      <SectionHeader index="00" label="Sign in" title="Sign in to logs" line={<>Paste the developer or reader token an admin issued with <code className="font-mono text-[0.9em]">{SERVER_CLI} token</code>.</>} />
      <SignInForm />
    </>
  );
}
