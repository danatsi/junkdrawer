'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import { AnimatePresence } from 'motion/react'
import { CORE_TAGS, type Link } from '@/lib/types'
import { LinkRow } from './LinkRow'
import { ScreenshotRow } from './ScreenshotRow'
import { SwipeableRow } from './SwipeableRow'
import { Toast } from './Toast'
import { SearchIcon, CloseIcon, PlusIcon, ChevronIcon } from './Icons'
import styles from './LinkList.module.css'

const ALL = 'all'

/** How often to re-fetch while something is still enriching. */
const POLL_MS = 3_000

/** Give up after this long. Enrichment sets `failed` on error, so a row that
 *  stays `pending` means the function died mid-flight and no amount of polling
 *  will resolve it — without a ceiling that row would poll forever. */
const POLL_BUDGET_MS = 120_000

/**
 * The All tab is grouped rather than endless (spec §4.1 gave it one flat
 * list). A filtered tab is already a single category, so it stays flat.
 *
 * Sections follow the chip bar's order, because that's the order the
 * categories are already learned in.
 */
const SECTION_ORDER = [...CORE_TAGS] as const

/** Keys are ids and CSS selectors as well as labels, hence the split. */
const PENDING_SECTION = { key: 'pending', label: 'adding details' } as const
const OTHER_SECTION = { key: 'other', label: 'everything else' } as const

interface Section {
  key: string
  label: string
  links: Link[]
  /** Rows still enriching have no tags yet, so they would all land in
   *  "everything else" — the bottom of the list, which is the worst place for
   *  the link you just shared. They get their own section on top, and it
   *  doesn't collapse: it empties itself as enrichment finishes. */
  pinned?: boolean
}

/** Exported for its own sake: the bucketing rules are worth checking without
 *  rendering anything. */
export function groupIntoSections(links: Link[]): Section[] {
  const buckets = new Map<string, Link[]>()
  const push = (key: string, link: Link) => {
    const bucket = buckets.get(key)
    if (bucket) bucket.push(link)
    else buckets.set(key, [link])
  }

  for (const link of links) {
    if (link.enrichment === 'pending') {
      push(PENDING_SECTION.key, link)
      continue
    }
    // A row can carry several core tags. It belongs to the first one in chip
    // order, so every row appears exactly once, the counts add up to the
    // total, and archiving can't leave a duplicate behind elsewhere.
    const category = SECTION_ORDER.find((tag) => link.tags.includes(tag))
    push(category ?? OTHER_SECTION.key, link)
  }

  const sections: Section[] = []
  const add = (key: string, label: string, pinned?: boolean) => {
    const bucket = buckets.get(key)
    // An empty section is noise: there's nothing to expand.
    if (bucket?.length) sections.push({ key, label, links: bucket, pinned })
  }

  add(PENDING_SECTION.key, PENDING_SECTION.label, true)
  for (const tag of SECTION_ORDER) add(tag, tag)
  add(OTHER_SECTION.key, OTHER_SECTION.label)
  return sections
}

/** Search matches title, domain, note, a screenshot's OCR'd text, and every
 *  tag — including the freeform ones that never get a chip, which is the main
 *  way to reach them. */
function matchesQuery(link: Link, query: string): boolean {
  const haystack = [
    link.title,
    link.domain,
    link.note,
    link.description,
    link.extracted_text,
    ...link.tags,
  ]
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
  // Which panels are open. Lifted out of the rows so several can be open at
  // once (the spec §6 q5 decision) *and* something above them can close them
  // all — a row owning its own boolean can do the first but not the second.
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())
  // Collapsed rather than expanded ids: the default is open, so an empty set
  // is the default state and a new category doesn't arrive collapsed.
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  // Enrichment finishes after this page was rendered, so without a nudge a
  // freshly captured row would sit on "adding details" until a manual reload.
  // Counted off the full server list, not the filtered view, so a tag filter
  // or an open search box can't stall the poll.
  const pendingCount = links.filter((l) => l.enrichment === 'pending').length

  useEffect(() => {
    if (pendingCount === 0) return

    let elapsed = 0
    const timer = setInterval(() => {
      elapsed += POLL_MS
      if (elapsed >= POLL_BUDGET_MS) {
        clearInterval(timer)
        return
      }
      router.refresh()
    }, POLL_MS)

    return () => clearInterval(timer)
    // pendingCount rather than a boolean: a newly captured row restarts the
    // budget instead of inheriting the tail of the previous one.
  }, [pendingCount, router])

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

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      // delete() reports whether it removed anything, which is the toggle.
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const toggleOpen = useCallback((id: string) => {
    setOpenIds((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  function closeSearch() {
    setSearchOpen(false)
    setQuery('')
  }

  const trimmedQuery = query.trim().toLowerCase()
  const visible = links
    .filter((l) => !archivedIds.has(l.id))
    .filter((l) => activeTag === ALL || l.tags.includes(activeTag))
    .filter((l) => !trimmedQuery || matchesQuery(l, trimmedQuery))

  const sections = activeTag === ALL ? groupIntoSections(visible) : null

  const renderRow = (link: Link) => (
    <SwipeableRow key={link.id} onArchive={() => archive(link)}>
      {link.type === 'screenshot' ? (
        <ScreenshotRow
          link={link}
          open={openIds.has(link.id)}
          onToggle={() => toggleOpen(link.id)}
        />
      ) : (
        <LinkRow link={link} open={openIds.has(link.id)} onToggle={() => toggleOpen(link.id)} />
      )}
    </SwipeableRow>
  )

  // The render below unmounts a collapsed section's rows, and a query
  // overrides the collapse state so a hit can't hide inside a shut section.
  // Shared with it so the two can't drift.
  const isSectionCollapsed = (section: Section) =>
    !section.pinned && !trimmedQuery && collapsedSections.has(section.key)

  // Sections only exist on the all tab, and a search forces them all open, so
  // there's nothing to collapse in either of those cases.
  const collapsibleKeys = trimmedQuery
    ? []
    : (sections ?? []).filter((section) => !section.pinned).map((section) => section.key)
  // Only rows actually on screen. A panel left open inside a section that was
  // then collapsed is unmounted, and counting it kept the button reading
  // "Collapse all" once everything visible was already shut — a click that
  // closed something nobody could see and appeared to do nothing.
  const onScreen = sections
    ? sections.filter((section) => !isSectionCollapsed(section)).flatMap((section) => section.links)
    : visible
  const canCollapse =
    collapsibleKeys.some((key) => !collapsedSections.has(key)) ||
    onScreen.some((link) => openIds.has(link.id))

  // One control for both, because "collapse all" leaving a row's panel hanging
  // open would read as a bug rather than a distinction.
  function collapseAll() {
    setCollapsedSections(new Set(collapsibleKeys))
    setOpenIds(new Set())
  }

  // Sections only. Row panels are closed by default and hold a paragraph each,
  // so throwing every one of them open is not what "expand all" is asking for —
  // it means put the list back the way it starts.
  function expandAll() {
    setCollapsedSections(new Set())
  }

  return (
    <main className={styles.screen}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h1 className={styles.wordmark}>Junk Drawer</h1>
          {!searchOpen && (
            <div className={styles.headerActions}>
              <button
                type="button"
                className={styles.searchToggle}
                aria-label="Search links"
                onClick={() => setSearchOpen(true)}
              >
                <SearchIcon />
              </button>
              {/* Stand-in for the Shortcut, for saving from a desktop browser. */}
              <NextLink className={styles.searchToggle} href="/capture" aria-label="Add a link">
                <PlusIcon />
              </NextLink>
            </div>
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

      {/* Sits above the sections rather than in the header: it acts on the
          list, not the app. Tied to the sections existing rather than to
          there being something to close, so it holds its place instead of
          shoving the list down the moment a panel opens, and so it can still
          be found once everything is shut. A search forces every section
          open, which leaves it nothing to do. */}
      {collapsibleKeys.length > 0 && (
        <div className={styles.listActions}>
          <button
            type="button"
            className={styles.collapseAll}
            onClick={canCollapse ? collapseAll : expandAll}
          >
            {canCollapse ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className={styles.empty}>{emptyMessage(links.length, trimmedQuery, activeTag)}</p>
      ) : sections ? (
        sections.map((section) => {
          const collapsed = isSectionCollapsed(section)
          const bodyId = `section-${section.key}`

          return (
            <section key={section.key}>
              {section.pinned ? (
                <div className={`${styles.sectionHeader} ${styles.sectionHeaderStatic}`}>
                  {sectionLabel(section)}
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.sectionHeader}
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  onClick={() => toggleSection(section.key)}
                >
                  <span
                    className={`${styles.sectionChevron} ${
                      collapsed ? styles.sectionChevronClosed : ''
                    }`}
                  >
                    <ChevronIcon />
                  </span>
                  {sectionLabel(section)}
                </button>
              )}
              {!collapsed && <div id={bodyId}>{section.links.map(renderRow)}</div>}
            </section>
          )
        })
      ) : (
        visible.map(renderRow)
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

/** The count is part of the label rather than pushed to the right edge: it
 *  reads as one phrase, and tells you what a collapsed section is holding. */
function sectionLabel(section: Section) {
  return (
    <>
      <span className={styles.sectionName}>{section.label}</span>
      <span className={styles.sectionCount}>{section.links.length}</span>
    </>
  )
}

function emptyMessage(total: number, query: string, activeTag: string): string {
  if (query) return `Nothing matching “${query}”.`
  if (total === 0) return 'Nothing saved yet. Share a link from your phone to get started.'
  return `Nothing tagged ${activeTag} yet.`
}
