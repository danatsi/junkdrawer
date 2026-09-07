import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { UNLOCK_COOKIE, hiddenNotFound, isUnlockConfigured, isValidUnlockToken } from '@/lib/unlock'

/**
 * The site gate (PLAN.md §5).
 *
 * Next 16 renamed the `middleware.ts` convention to `proxy.ts`; the behaviour
 * is unchanged. It runs on the Node.js runtime by default, which is what lets
 * `lib/unlock.ts` use `node:crypto`.
 */

/** Reachable without the cookie. `/unlock` is how the cookie is obtained;
 *  `/api/capture` authenticates the Shortcut with its own bearer token and
 *  never carries a browser cookie. */
const OPEN_PATHS = ['/unlock', '/api/capture']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (OPEN_PATHS.includes(pathname)) return NextResponse.next()

  if (!isUnlockConfigured()) {
    // Fail closed in production: a deploy that forgot the secret is exactly
    // the hole this exists to close, and a silent fail-open wouldn't be
    // noticed. Locally it's just noise, so dev stays open.
    if (process.env.NODE_ENV === 'production') {
      console.error('APP_UNLOCK_SECRET is not set; refusing every request')
      return hiddenNotFound()
    }
    return NextResponse.next()
  }

  if (!isValidUnlockToken(request.cookies.get(UNLOCK_COOKIE)?.value)) {
    return hiddenNotFound()
  }

  return NextResponse.next()
}

export const config = {
  // Anything with a file extension is skipped along with Next's own static
  // output: that covers the manifest and the icons, which aren't secret and
  // which Safari fetches without cookies — gating them breaks installing the
  // PWA. App routes have no dot, so nothing real slips through.
  matcher: ['/((?!_next/static|_next/image|.*\\.\\w+$).*)'],
}
