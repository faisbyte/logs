import { redirect } from 'next/navigation';
import { viewer } from '~/lib/api';

// Home by role: developers start on the overview, readers on the digest archive, the one view they have (D51).
export default async function Home() {
  const me = await viewer();
  if (!me) redirect('/sign-in');
  redirect(me.role === 'developer' ? '/overview' : '/digests');
}
