'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { captureLink, type CaptureState } from '@/app/capture/actions'
import styles from './CaptureForm.module.css'

const INITIAL: CaptureState = { status: 'idle' }

/**
 * A stand-in for the iOS Shortcut (spec §2.2), for saving links before the
 * Shortcut exists and for testing the pipeline from a desktop browser.
 *
 * Uses a server action rather than posting to /api/capture, so CAPTURE_TOKEN
 * never has to reach the browser. That endpoint stays bearer-only, exactly as
 * the Shortcut will use it.
 */
export function CaptureForm() {
  const [state, formAction, pending] = useActionState(captureLink, INITIAL)

  return (
    <main className={styles.screen}>
      <div className={styles.header}>
        <h1 className={styles.wordmark}>Add to Junk Drawer</h1>
        <Link className={styles.back} href="/">
          Back to the drawer
        </Link>
      </div>

      <form action={formAction} className={styles.form}>
        <label className={styles.label} htmlFor="url">
          Link
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          autoFocus
          placeholder="https://…"
          className={styles.input}
        />

        <label className={styles.label} htmlFor="note">
          Note <span className={styles.optional}>optional</span>
        </label>
        {/* Worth spelling out: the note outranks the scraped page text, which
            is the whole reason Instagram links work at all. */}
        <textarea
          id="note"
          name="note"
          rows={3}
          placeholder="Why you're saving it — this beats whatever the page says"
          className={styles.input}
        />

        <button type="submit" className={styles.submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>

        {state.status !== 'idle' && (
          <p className={state.status === 'error' ? styles.error : styles.ok}>{state.message}</p>
        )}
      </form>

      <p className={styles.hint}>
        The row appears immediately with its domain as a placeholder title, then fills in once
        enrichment finishes. Screenshots aren&apos;t supported yet — that&apos;s v2.
      </p>
    </main>
  )
}
