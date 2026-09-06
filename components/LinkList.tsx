'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { CORE_TAGS, type Link } from '@/lib/types'
import { LinkRow } from './LinkRow'
import { ScreenshotRow } from './ScreenshotRow'
import { SwipeableRow } from './SwipeableRow'
import { Toast } from './Toast'
import { SearchIcon, CloseIcon } from './Icons'
import styles from './LinkList.module.css'

const ALL = 'all'

/** Search matches title, domain, note and every tag — including the freeform
 *  ones that never get a chip, which is the main way to reach them. */
function matchesQuery(link: Link, query: string): boolean {
  const haystack = [link.title, link.domain, link.note, link.description, ...link.tags]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

export function LinkList({ links }: { links: Link[] }) {
  const [activeTag, setActiveTag] = useState<string>(ALL)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Archived rows are tracked by id and filtered out of the server list rather
  // than copied into state. The server list stays the single source of truth,
  // so a refresh can't be clobbered, and undo restores a row to its original
  // position without having to remember an index.
  const [archivedIds, setArchivedIds] = useState<ReadonlySet<string>>(new Set())
  const [archived, setArchived] = useState<Link | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  const setStatus = useCallback(async (id: string, status: 'unread' | 'done') => {
    try {
      await fetch(`/api/links/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
    } catch {
      // The row already moved optimistically; a failed write self-corrects on
      // the next load rather than yanking the row back mid-gesture.
      console.error('Could not update link status')
    }
  }, [])

  const archive = useCallback(
    (link: Link) => {
      setArchivedIds((current) => new Set(current).add(link.id))
      setArchived(link)
      void setStatus(link.id, 'done')
    },
    [setStatus],
  )

  const undo = useCallback(() => {
    if (!archived) return
    setArchivedIds((current) => {
      const next = new Set(current)
      next.delete(archived.id)
      return next
    })
    setArchived(null)
    void setStatus(archived.id, 'unread')
  }, [archived, setStatus])

  function closeSearch() {
    setSearchOpen(false)
    setQuery('')
  }

  const trimmedQuery = query.trim().toLowerCase()
  const visible = links
    .filter((l) => !archivedIds.has(l.id))
    .filter((l) => activeTag === ALL || l.tags.includes(activeTag))
    .filter((l) => !trimmedQuery || matchesQuery(l, trimmedQuery))

  return (
    <main className={styles.screen}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h1 className={styles.wordmark}>Junk Drawer</h1>
          {!searchOpen && (
            <button
              type="button"
              className={styles.searchToggle}
              aria-label="Search links"
              onClick={() => setSearchOpen(true)}
            >
              <SearchIcon />
            </button>
          )}
        </div>

        {searchOpen ? (
          <div className={styles.searchBar}>
            <input
              ref={searchRef}
              className={styles.searchField}
              type="search"
              placeholder="Search titles, tags, notes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
            />
            <button
              type="button"
              className={styles.searchToggle}
              aria-label="Close search"
              onClick={closeSearch}
            >
              <CloseIcon />
            </button>
          </div>
        ) : (
          <div className={styles.chips}>
            {[ALL, ...CORE_TAGS].map((tag) => (
              <button
                key={tag}
                type="button"
                className={`${styles.chip} ${tag === activeTag ? styles.chipActive : ''}`}
                aria-pressed={tag === activeTag}
                onClick={() => setActiveTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <p className={styles.empty}>{emptyMessage(links.length, trimmedQuery, activeTag)}</p>
      ) : (
        visible.map((link) => (
          <SwipeableRow key={link.id} onArchive={() => archive(link)}>
            {link.type === 'screenshot' ? (
              <ScreenshotRow link={link} />
            ) : (
              <LinkRow link={link} />
            )}
          </SwipeableRow>
        ))
      )}

      <AnimatePresence>
        {archived && (
          <Toast
            key={archived.id}
            message="Archived"
            actionLabel="Undo"
            onAction={undo}
            onExpire={() => setArchived(null)}
          />
        )}
      </AnimatePresence>
    </main>
  )
}

function emptyMessage(total: number, query: string, activeTag: string): string {
  if (query) return `Nothing matching “${query}”.`
  if (total === 0) return 'Nothing saved yet. Share a link from your phone to get started.'
  return `Nothing tagged ${activeTag} yet.`
}
