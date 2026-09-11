'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Link } from '@/lib/types'
import { displayTitle } from '@/lib/types'
import { generatedThumb } from '@/lib/thumb'
import { ChevronIcon, StarIcon, WhatsAppIcon } from './Icons'
import styles from './LinkRow.module.css'

/** wa.me can only pre-fill text, which is all a link row needs (spec §3.4).
 *  No API key, no server round-trip. */
function whatsAppHref(link: Link): string {
  return `https://wa.me/?text=${encodeURIComponent(`${displayTitle(link)} ${link.url}`)}`
}

export function LinkRow({
  link,
  open,
  onToggle,
}: {
  link: Link
  open: boolean
  onToggle: () => void
}) {
  // Purely a request-in-flight flag for the button. Deliberately not used to
  // derive the row's state: the server owns that, so there's no way for this
  // to strand the row in a state the database disagrees with.
  const [retrying, setRetrying] = useState(false)
  const router = useRouter()

  // Both give the row a score badge, and the same read at rest is the point:
  // "how good is this" and "will I like this" render identically.
  const hasScore = Boolean(link.imdb_rating) || link.reassurance_score !== null
  const primaryTag = link.tags[0] ?? null
  // Enrichment runs after the capture endpoint has already returned, so a row
  // is live and tappable before it has a title, a thumbnail or tags. Say so
  // rather than rendering it as a finished row that happens to look thin.
  const isPending = link.enrichment === 'pending'
  const hasFailed = link.enrichment === 'failed'
  // displayTitle falls back to the domain. Mute it whenever that's what's
  // showing — a failed row is just as much a stand-in as a pending one.
  const placeholderTitle = !link.title?.trim()
  // A failed row gets a panel even with no note, since the panel is the only
  // place a retry button can legally live — the meta line is inside the row's
  // anchor, and a <button> can't nest in an <a>.
  const hasPanel = Boolean(link.note || link.description || hasFailed)
  const thumb = generatedThumb(link)

  async function retry(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    setRetrying(true)
    try {
      const response = await fetch(`/api/links/${link.id}/enrich`, { method: 'POST' })
      if (!response.ok) throw new Error(`retry failed: ${response.status}`)
      // The endpoint sets the row back to pending before it answers, so a
      // refresh hands it straight to the poll in LinkList.
      router.refresh()
    } catch (error) {
      console.error(error)
    } finally {
      setRetrying(false)
    }
  }

  // One quiet line of state, in the same slot the tag would occupy. State
  // stays plain text — a pill is a category, and "couldn't fetch details" is
  // not one.
  const metaDetail = isPending ? (
    <span className={styles.pendingNote}>adding details</span>
  ) : hasFailed ? (
    <span className={styles.failedNote}>couldn&apos;t fetch details</span>
  ) : primaryTag ? (
    <span className={`${styles.tagPill} ${hasScore ? styles.tagScored : ''}`}>{primaryTag}</span>
  ) : null

  return (
    <>
      <div className={styles.row}>
        {/* draggable={false} on every link and image in the row: a browser
            starts its own native drag from an <a> or an <img>, and that drag
            swallows the pointer before the swipe-to-archive gesture ever sees
            it. Expanded rows appeared to work only because the panel is a
            plain div with nothing native to steal. */}
        <a
          className={styles.rowLink}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          draggable={false}
        >
          {link.image_url && link.image_kind === 'photo' ? (
            // Arbitrary scraped hosts, and these are 40px — next/image's
            // optimizer would cost more than it saves here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className={styles.thumb}
              src={link.image_url}
              alt=""
              loading="lazy"
              draggable={false}
            />
          ) : isPending ? (
            <div className={`${styles.thumb} ${styles.thumbPending}`} />
          ) : (
            // No photo. A favicon shrunk into a 40px square reads as clutter
            // at this size, so an `icon` image_url is deliberately ignored in
            // favour of the derived tile — the row keeps a solid left edge
            // and the letter identifies the site as well as the icon did.
            <div className={`${styles.thumb} ${styles.thumbGenerated}`} style={{ background: thumb.background }}>
              {thumb.monogram}
            </div>
          )}
          <div className={styles.content}>
            <div className={styles.titleLine}>
              {/* Scraped titles come in whatever script the page was written
                  in. Without dir the browser lays a Hebrew or Arabic title out
                  left-to-right and its punctuation lands at the wrong end;
                  "auto" picks the direction from the string's own first strong
                  character, per string, which is the only thing that can be
                  right for a mixed list. */}
              <span
                dir="auto"
                className={`${styles.title} ${placeholderTitle ? styles.pending : ''}`}
              >
                {displayTitle(link)}
              </span>
              {hasScore && (
                <span className={styles.score}>
                  <StarIcon />
                  {link.imdb_rating ?? `${link.reassurance_score}/10`}
                </span>
              )}
            </div>
            <div className={styles.meta}>
              <span className={styles.domain}>{link.domain}</span>
              {metaDetail}
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
            draggable={false}
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
              onToggle()
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
              {hasFailed && (
                <div className={styles.failedPanel}>
                  {/* enrich_error is already stored, and it's the only clue as
                      to whether this is a blocked site or a missing API key. */}
                  <div>{link.enrich_error || 'Enrichment did not finish.'}</div>
                  <button
                    type="button"
                    className={styles.retry}
                    onClick={retry}
                    disabled={retrying}
                  >
                    {retrying ? 'Trying…' : 'Try again'}
                  </button>
                </div>
              )}
              {link.description && <div dir="auto">{link.description}</div>}
              {link.note && (
                <div dir="auto" className={link.description ? styles.note : undefined}>
                  {link.note}
                </div>
              )}
              {link.trailer_url && (
                <a
                  className={styles.trailerLink}
                  href={link.trailer_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  draggable={false}
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
