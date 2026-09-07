import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

/**
 * The frontend gate (PLAN.md §5). The capture endpoint has its own bearer
 * token, but nothing protected the site itself — anyone with the URL could
 * read the drawer. This is the whole mechanism: visit `/unlock?k=<secret>`
 * once per device, get a signed cookie, and every other request is checked
 * against it by `proxy.ts`.
 *
 * The cookie holds an HMAC of the secret rather than the secret itself, so a
 * cookie that leaks can't be replayed as an unlock link, and rotating
 * APP_UNLOCK_SECRET (or TOKEN_VERSION) signs every device out at once.
 */
export const UNLOCK_COOKIE = 'jd_unlock'

/** Bump to invalidate every issued cookie without rotating the secret. */
const TOKEN_VERSION = 'v1'

export const UNLOCK_MAX_AGE = 60 * 60 * 24 * 365

export function isUnlockConfigured(): boolean {
  return Boolean(process.env.APP_UNLOCK_SECRET)
}

function sign(secret: string): string {
  return createHmac('sha256', secret).update(TOKEN_VERSION).digest('hex')
}

function required(): string {
  const secret = process.env.APP_UNLOCK_SECRET
  if (!secret) throw new Error('Missing required env var: APP_UNLOCK_SECRET')
  return secret
}

/** The cookie value handed out by `/unlock`. */
export function unlockToken(): string {
  return sign(required())
}

export function isValidUnlockToken(token: string | undefined): boolean {
  if (!token || !isUnlockConfigured()) return false
  return equal(token, unlockToken())
}

/** Checks `?k=` against the secret. Both sides are hashed first so the compare
 *  is over two fixed-length digests and the secret's length doesn't leak. */
export function isCorrectSecret(provided: string): boolean {
  if (!isUnlockConfigured()) return false
  return equal(sign(provided), sign(required()))
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * 404 rather than 401 for every locked request: a 401 confirms something is
 * here worth guessing at, a 404 says there's nothing at this address at all.
 * Deliberately bodyless — no wordmark, no framework fingerprint.
 */
export function hiddenNotFound(): NextResponse {
  return new NextResponse(null, { status: 404 })
}
