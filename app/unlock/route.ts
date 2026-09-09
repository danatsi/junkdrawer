import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  UNLOCK_COOKIE,
  UNLOCK_MAX_AGE,
  hiddenNotFound,
  isCorrectSecret,
  unlockToken,
} from '@/lib/unlock'

/**
 * GET /unlock?k=<APP_UNLOCK_SECRET> — the one-time, one-per-device unlock.
 *
 * There's no login form on purpose: one user, one secret, and a form would be
 * a page that has to render before the gate can decide anything. A wrong or
 * missing key 404s exactly like every other locked path, so probing this route
 * tells you nothing that probing `/` doesn't.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const provided = request.nextUrl.searchParams.get('k')
  if (!provided || !isCorrectSecret(provided)) return hiddenNotFound()

  // Redirect rather than render, so the secret stops being the current URL as
  // soon as the cookie is set.
  const response = NextResponse.redirect(new URL('/', request.url))
  response.cookies.set({
    name: UNLOCK_COOKIE,
    value: unlockToken(),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: UNLOCK_MAX_AGE,
  })
  return response
}
