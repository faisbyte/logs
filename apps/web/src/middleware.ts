import { NextResponse, type NextRequest } from 'next/server';

// Without a session cookie, every page but sign-in goes to sign-in. Whether a cookie's session is still valid, and what
// its role may see, is the digest server's call on each request (src/lib/api.ts).
export function middleware(request: NextRequest) {
  if (!request.cookies.get('logs_session')?.value) return NextResponse.redirect(new URL('/sign-in', request.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!sign-in|_next/|favicon|icon).*)'] };
