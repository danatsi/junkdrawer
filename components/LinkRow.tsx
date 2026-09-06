'use client'

import { useState } from 'react'
import type { Link } from '@/lib/types'
import { displayTitle } from '@/lib/types'
import { ChevronIcon, StarIcon, WhatsAppIcon } from './Icons'
import styles from './LinkRow.module.css'

/** wa.me can only pre-fill text, which is all a link row needs (spec §3.4).
 *  No API key, no server round-trip. */
function whatsAppHref(link: Link): string {
  return `https://wa.me/?text=${encodeURIComponent(`${displayTitle(link)} ${link.url}`)}`
}

export function LinkRow({ link }: { link: Link }) {
  const [open, setOpen] = useState(false)

  const isWatch = link.tags.includes('watch')
  const primaryTag = link.tags[0] ?? null
  const hasPanel = Boolean(link.note || link.description)
  const awaitingTitle = link.enrichment === 'pending' && !link.title

  return (
    <>
      <div className={styles.row}>
        <a className={styles.rowLink} href={link.url} target="_blank" rel="noopener noreferrer">
          {link.image_url ? (
            // Arbitrary scraped hosts, and these are 40px — next/image's
            // optimizer would cost more than it saves here.
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.thumb} src={link.image_url} alt="" loading="lazy" />
          ) : (
            <div className={styles.thumb} />
          )}
          <div className={styles.content}>
            <div className={styles.titleLine}>
              <span className={`${styles.title} ${awaitingTitle ? styles.pending : ''}`}>
                {displayTitle(link)}
              </span>
              {link.imdb_rating && (
                <span className={styles.score}>
                  <StarIcon />
                  {link.imdb_rating}
                </span>
              )}
            </div>
            <div className={styles.meta}>
              {link.domain}
              {primaryTag && (
                <>
                  {' · '}
                  <span className={isWatch ? styles.tagWatch : undefined}>{primaryTag}</span>
                </>
              )}
            </div>
          </div>
        </a>

        <div className={styles.actions}>
          {/* stopPropagation so neither icon triggers the row's link-out */}
          <a
            className={styles.iconBtn}
            href={whatsAppHref(link)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Share via WhatsApp"
            onClick={(e) => e.stopPropagation()}
          >
            <WhatsAppIcon />
          </a>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.chevron} ${open ? styles.chevronOpen : ''} ${
              hasPanel ? '' : styles.chevronHidden
            }`}
            aria-label={open ? 'Collapse details' : 'Expand details'}
            aria-expanded={hasPanel ? open : undefined}
            aria-hidden={hasPanel ? undefined : true}
            tabIndex={hasPanel ? undefined : -1}
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setOpen((v) => !v)
            }}
          >
            <ChevronIcon />
          </button>
        </div>
      </div>

      {hasPanel && (
        <div className={`${styles.panel} ${open ? styles.panelOpen : ''}`}>
          <div className={styles.panelClip}>
            <div className={styles.panelInner}>
              {link.description && <div>{link.description}</div>}
              {link.note && (
                <div className={link.description ? styles.note : undefined}>{link.note}</div>
              )}
              {link.trailer_url && (
                <a
                  className={styles.trailerLink}
                  href={link.trailer_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Watch trailer
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
