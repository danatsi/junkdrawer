'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  UNLOCK_COOKIE,
  UNLOCK_MAX_AGE,
  isCorrectSecret,
  isUnlockConfigured,
  unlockToken,
} from '@/lib/unlock'

export interface UnlockState {
  error?: string
}

/**
 * Checks the password and, if it's right, issues the cookie `proxy.ts` looks
 * for (PLAN.md §5).
 *
 * This replaced a `/unlock?k=<secret>` link. A form post is better on two
 * counts: the secret never lands in a URL — and so never in history, a
 * referer header, or a screenshot of the address bar — and a password field
 * is something iOS and a password manager will offer to save, which is what
 * makes a once-a-year unlock painless rather than a scavenger hunt.
 *
 * No rate limiting, deliberately. The secret is a five-word passphrase with
 * ~74 bits of entropy; an attacker managing a thousand guesses a second is
 * still looking at astronomical time, so a lockout would only ever fire on
 * the one person allowed in. `isCorrectSecret` hashes both sides before
 * comparing, so neither the length nor the contents leak through timing.
 */
export async function unlock(_previous: UnlockState, formData: FormData): Promise<UnlockState> {
  const provided = formData.get('password')
  if (typeof provided !== 'string' || !provided) {
    return { error: 'Enter the password.' }
  }
  if (!isUnlockConfigured()) {
    console.error('unlock: APP_UNLOCK_SECRET is not set')
    return { error: 'This deployment has no password configured.' }
  }
  if (!isCorrectSecret(provided)) {
    // No detail on *why*, and the same message for a wrong password as for a
    // malformed one.
    return { error: 'Wrong password.' }
  }

  ;(await cookies()).set({
    name: UNLOCK_COOKIE,
    value: unlockToken(),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: UNLOCK_MAX_AGE,
  })

  // Throws internally, so it has to sit outside any try/catch to work.
  redirect('/')
}
