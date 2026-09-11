'use client'

import { useState } from 'react'
import type { Link } from '@/lib/types'
import { displayTitle } from '@/lib/types'
import { ChevronIcon, ShareIcon, StarIcon } from './Icons'
import { ImageViewer } from './ImageViewer'
import styles from './LinkRow.module.css'

/**
 * Screenshot variant (spec §5.5). A screenshot has no external URL, so the
 * interaction model differs from a link row: instead of linking out, *any* tap
 * on the row toggles the panel — the body, the chevron, and the padding around
 * them. Only the share button is carved out.
 *
 * Sharing also differs (spec §5.6): wa.me can only pre-fill text, so sending
 * the actual image needs the Web Share API, which opens the OS picker rather
 * than jumping straight into WhatsApp.
 */
export function ScreenshotRow({
  link,
  open,
  onToggle,
}: {
  link: Link
  open: boolean
  onToggle: () => void
}) {
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
      <div className={`${styles.row} ${styles.rowClickable}`} onClick={onToggle}>
        <div className={styles.rowToggle}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.thumb} src={image} alt="" loading="lazy" draggable={false} />
          ) : (
            <div className={styles.thumb} />
          )}
          <div className={styles.content}>
            <div className={styles.titleLine}>
              {/* Same reason as LinkRow: a screenshot's title is whatever
                  script its text was in. */}
              <span dir="auto" className={styles.title}>
                {displayTitle(link)}
              </span>
              {/* A screenshot of a book cover reaches the same taste scoring a
                  pasted link does — the vision path writes both fields — so it
                  gets the same badge. */}
              {link.reassurance_score !== null && (
                <span className={styles.score}>
                  <StarIcon />
                  {`${link.reassurance_score}/10`}
                </span>
              )}
            </div>
            <div className={styles.meta}>
              <span className={`${styles.tagPill} ${styles.tagAccent}`}>screenshot</span>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Share screenshot"
            onClick={share}
          >
            <ShareIcon />
          </button>
          {/* The row already handles the tap; this stays a real button so the
              row is still keyboard-reachable and announces its state. */}
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.chevron} ${open ? styles.chevronOpen : ''}`}
            aria-label={open ? 'Collapse details' : 'Expand details'}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            <ChevronIcon />
          </button>
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
            <div dir="auto">
              {link.description ?? link.note}
              {link.reassurance_reason && (
                <p className={styles.reason}>{link.reassurance_reason}</p>
              )}
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
