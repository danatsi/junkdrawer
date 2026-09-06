'use client'

import { useState } from 'react'
import type { Link } from '@/lib/types'
import { displayTitle } from '@/lib/types'
import { ChevronIcon, ShareIcon } from './Icons'
import { ImageViewer } from './ImageViewer'
import styles from './LinkRow.module.css'

/**
 * Screenshot variant (spec §5.5). A screenshot has no external URL, so the
 * interaction model differs from a link row: the whole body toggles the panel
 * instead of linking out, and the chevron is affordance only — it rotates but
 * isn't separately tappable.
 *
 * Sharing also differs (spec §5.6): wa.me can only pre-fill text, so sending
 * the actual image needs the Web Share API, which opens the OS picker rather
 * than jumping straight into WhatsApp.
 */
export function ScreenshotRow({ link }: { link: Link }) {
  const [open, setOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)

  const image = link.image_url

  async function share(e: React.MouseEvent) {
    e.stopPropagation()
    if (!image) return
    try {
      const blob = await fetch(image).then((r) => r.blob())
      const file = new File([blob], 'screenshot.jpg', { type: blob.type })
      // title and text are left empty deliberately: on iOS, passing a title
      // alongside files makes some targets (WhatsApp especially) fall back to
      // sharing as text instead of the file.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] })
      } else {
        setShareError('Sharing images needs iOS Safari 15+.')
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setShareError('Could not open the share sheet.')
      }
    }
  }

  return (
    <>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.rowToggle}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.thumb} src={image} alt="" loading="lazy" />
          ) : (
            <div className={styles.thumb} />
          )}
          <div className={styles.content}>
            <div className={styles.titleLine}>
              <span className={styles.title}>{displayTitle(link)}</span>
            </div>
            <div className={styles.meta}>
              <span className={styles.tagAccent}>screenshot</span>
            </div>
          </div>
        </button>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Share screenshot"
            onClick={share}
          >
            <ShareIcon />
          </button>
          {/* Affordance only — the row body is the control. */}
          <span
            className={`${styles.iconBtn} ${styles.chevron} ${open ? styles.chevronOpen : ''}`}
            aria-hidden="true"
          >
            <ChevronIcon />
          </span>
        </div>
      </div>

      <div className={`${styles.panel} ${open ? styles.panelOpen : ''}`}>
        <div className={styles.panelClip}>
          <div className={`${styles.panelInner} ${styles.panelWithThumb}`}>
            {image && (
              <button
                type="button"
                className={styles.panelThumb}
                style={{ backgroundImage: `url(${image})`, backgroundSize: 'cover' }}
                aria-label="View screenshot full screen"
                onClick={(e) => {
                  e.stopPropagation()
                  setViewerOpen(true)
                }}
              />
            )}
            <div>
              {link.description ?? link.note}
              {shareError && <div className={styles.note}>{shareError}</div>}
            </div>
          </div>
        </div>
      </div>

      {viewerOpen && image && (
        <ImageViewer src={image} alt={displayTitle(link)} onClose={() => setViewerOpen(false)} />
      )}
    </>
  )
}
