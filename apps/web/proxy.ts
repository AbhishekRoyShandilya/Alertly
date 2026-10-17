import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/register'];

/**
 * Next.js 16 "proxy" (formerly middleware): runs before a page renders.
 * An optimistic check only: no session cookie → send to /login. It can't verify the JWT
 * (the API does that on every call); it just avoids flashing a dashboard that will 401.
 */
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has('alertly_session');
  const isPublic = PUBLIC.includes(req.nextUrl.pathname);

  if (!hasSession && !isPublic) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  if (hasSession && isPublic) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except the API rewrite, Next internals and static files.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg$).*)'],
};
