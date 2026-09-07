'use client'

import { useActionState, useRef, useState } from 'react'
import Link from 'next/link'
import { compressImage, formatBytes } from '@/lib/compress'
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
  const [image, setImage] = useState<{ file: File; preview: string; note: string } | null>(null)
  const [compressing, setCompressing] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null)

  // Compress on selection rather than on submit, so the size saving is visible
  // before you commit and the upload starts from an already-small file.
  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0]
    if (!picked) return
    setCompressing(true)
    try {
      const { file, originalBytes, compressedBytes } = await compressImage(picked)
      // The input must carry the *compressed* file, not what was picked.
      const transfer = new DataTransfer()
      transfer.items.add(file)
      if (imageInput.current) imageInput.current.files = transfer.files
      setImage({
        file,
        preview: URL.createObjectURL(file),
        note: `${formatBytes(originalBytes)} → ${formatBytes(compressedBytes)}`,
      })
    } catch {
      setImage(null)
    } finally {
      setCompressing(false)
    }
  }

  function clearImage() {
    if (image) URL.revokeObjectURL(image.preview)
    setImage(null)
    if (imageInput.current) imageInput.current.value = ''
  }

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
          Link {image && <span className={styles.optional}>not needed for a screenshot</span>}
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required={!image}
          disabled={Boolean(image)}
          autoFocus
          placeholder="https://…"
          className={styles.input}
        />

        <label className={styles.label} htmlFor="image">
          Screenshot <span className={styles.optional}>instead of a link</span>
        </label>
        <input
          ref={imageInput}
          id="image"
          name="image"
          type="file"
          accept="image/*"
          onChange={onPick}
          className={styles.file}
        />
        {compressing && <p className={styles.meta}>Compressing…</p>}
        {image && (
          <div className={styles.preview}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.preview} alt="" className={styles.thumb} />
            <div>
              <div className={styles.meta}>{image.note}</div>
              <button type="button" className={styles.clear} onClick={clearImage}>
                Remove
              </button>
            </div>
          </div>
        )}

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

        <button type="submit" className={styles.submit} disabled={pending || compressing}>
          {pending ? 'Saving…' : 'Save'}
        </button>

        {state.status !== 'idle' && (
          <p className={state.status === 'error' ? styles.error : styles.ok}>{state.message}</p>
        )}
      </form>

      <p className={styles.hint}>
        The row appears immediately, then fills in once enrichment finishes. Screenshots are
        compressed here in the browser before upload, and read by Gemini afterwards — if one shows
        a film or TV show, it gets the same IMDb rating and trailer a pasted link would.
      </p>
    </main>
  )
}
