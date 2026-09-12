'use client'

import { useState } from 'react'
import { CORE_TAGS, type Link } from '@/lib/types'
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

  // The screenshot itself: still the artefact, so the panel and the viewer
  // keep showing it whatever the row's thumbnail ends up being.
  const image = link.image_url
  // What identifies the row in the list. A screenshot of a streaming app at
  // 44px is an unreadable smear that looks like every other screenshot; once
  // enrichment has worked out which show it is, its poster says so at a
  // glance.
  const thumbnail = link.poster_url ?? image
  // A screenshot can be of anything, and when it's of a film or show it took
  // the whole watch pipeline to get here — rating included. This row used to
  // hardcode the pill to "screenshot" and drop the rating on the floor, so a
  // saved show looked exactly like a saved receipt.
  const primaryTag = CORE_TAGS.find((tag) => link.tags.includes(tag))
  const hasScore = Boolean(link.imdb_rating) || link.reassurance_score !== null

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
          {thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.thumb} src={thumbnail} alt="" loading="lazy" draggable={false} />
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
              {/* A screenshot of a poster or a book cover reaches the same
                  lookups a pasted link does — the vision path feeds both the
                  watch chain and the taste scoring — so it gets the same
                  badge. */}
              {hasScore && (
                <span className={styles.score}>
                  <StarIcon />
                  {link.imdb_rating ?? `${link.reassurance_score}/10`}
                </span>
              )}
            </div>
            <div className={styles.meta}>
              {/* What it is, when we worked that out, and only otherwise how it
                  arrived. "Screenshot" is how it got here, not what it's about,
                  and it was the only thing this row ever said. */}
              <span className={`${styles.tagPill} ${styles.tagAccent}`}>
                {primaryTag ?? 'screenshot'}
              </span>
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
            <div dir="auto" className={styles.panelStack}>
              {link.description ?? link.note}
              {link.reassurance_reason && (
                <p className={styles.reason}>{link.reassurance_reason}</p>
              )}
              {/* Same chain as a pasted IMDb link, so the same way out of the
                  row. Only the thumbnail above knows this started as a
                  screenshot. */}
              {link.trailer_url && (
                <a
                  className={styles.trailerLink}
                  href={link.trailer_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  draggable={false}
                  onClick={(e) => e.stopPropagation()}
                >
                  Watch trailer
                </a>
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
