import { redirect } from 'next/navigation';

// The archive is the one view every role has, so it is home for now.
export default function Home() {
  redirect('/digests');
}
