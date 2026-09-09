'use client'

import { useActionState } from 'react'
import { unlock, type UnlockState } from '@/app/unlock/actions'
import styles from './UnlockForm.module.css'

const INITIAL: UnlockState = {}

/**
 * The gate's one screen (PLAN.md §5). Unlocks the device for a year, so this
 * is a page you see about as often as you see a new phone.
 */
export function UnlockForm() {
  const [state, formAction, pending] = useActionState(unlock, INITIAL)

  return (
    <main className={styles.screen}>
      <form className={styles.form} action={formAction}>
        <h1 className={styles.wordmark}>Junk Drawer</h1>
        <p className={styles.blurb}>Locked. One password, then this device stays unlocked for a year.</p>

        <label className={styles.label} htmlFor="password">
          Password
        </label>
        <input
          className={styles.input}
          id="password"
          name="password"
          type="password"
          /* Lets iOS and a password manager offer to save and refill it —
             the difference between one tap a year and hunting for a note. */
          autoComplete="current-password"
          autoFocus
          required
        />

        <button className={styles.submit} type="submit" disabled={pending}>
          {pending ? 'Unlocking…' : 'Unlock'}
        </button>

        {state.error ? (
          <p className={styles.error} role="alert">
            {state.error}
          </p>
        ) : null}
      </form>
    </main>
  )
}
