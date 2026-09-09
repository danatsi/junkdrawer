'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import { AnimatePresence } from 'motion/react'
import { CORE_TAGS, type Link } from '@/lib/types'
import { compileQuery, matchesQuery } from '@/lib/search'
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

/** The two tiers of the swipe: shallow archives, deep deletes. */
type SwipeAction = 'archive' | 'delete'

/** The row a swipe just took out of the list, held for the undo window. */
interface Pending {
  link: Link
  action: SwipeAction
}

/**
 * The one write in the app with no way back, which is why it isn't sent when
 * the gesture completes — the toast holds it, and `commit` sends it once the
 * undo window has closed over it. There's no soft-delete column behind this:
 * the undo is the delay itself.
 */
async function destroy(id: string, { keepalive = false } = {}): Promise<void> {
  try {
    await fetch(`/api/links/${id}`, { method: 'DELETE', keepalive })
  } catch {
    // Same reasoning as a failed status write: the row has already left the
    // list, and the next load is a better place to disagree than mid-toast.
    console.error('Could not delete link')
  }
}

export function LinkList({ links }: { links: Link[] }) {
  const [activeTag, setActiveTag] = useState<string>(ALL)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Swiped-away rows are tracked by id and filtered out of the server list
  // rather than copied into state. The server list stays the single source of
  // truth, so a refresh can't be clobbered, and undo restores a row to its
  // original position without having to remember an index.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState<Pending | null>(null)
  // Which row has its action tray uncovered. Owned here rather than by each
  // row so that swiping one closes the last: a single id can hold "only one
  // at a time", and a boolean per row can't.
  const [swipedId, setSwipedId] = useState<string | null>(null)
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

  const remove = useCallback(
    (link: Link, action: SwipeAction) => {
      setRemovedIds((current) => new Set(current).add(link.id))
      // The tray goes with the row. Left set, it would reopen under the row
      // that undo puts back.
      setSwipedId(null)
      setPending({ link, action })
      // An archive is written straight away because it's reversible either
      // way: the row is still in the table and undo just sets it back. A
      // delete isn't sent at all until the undo window closes — see `commit`.
      if (action === 'archive') void setStatus(link.id, 'done')
    },
    [setStatus],
  )

  const undo = useCallback(() => {
    if (!pending) return
    setRemovedIds((current) => {
      const next = new Set(current)
      next.delete(pending.link.id)
      return next
    })
    setPending(null)
    if (pending.action === 'archive') void setStatus(pending.link.id, 'unread')
    // Undoing a delete is nothing more than never having sent it.
  }, [pending, setStatus])

  /** The undo window closed: whatever was being held back now happens. */
  const commit = useCallback(() => {
    if (pending?.action === 'delete') void destroy(pending.link.id)
    setPending(null)
  }, [pending])

  // The row is gone from the list the moment it's swiped, but the request that
  // makes that true is five seconds behind it — so a tab closed inside the
  // window would resurrect a row the person watched leave. Sent on the way out
  // instead, with `keepalive` so it survives the page being torn down.
  useEffect(() => {
    if (pending?.action !== 'delete') return
    const id = pending.link.id
    const flush = () => void destroy(id, { keepalive: true })
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [pending])

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

  // Compiled once per keystroke rather than once per row: tokenising and
  // stemming the query is the expensive half, and it doesn't depend on the row.
  const compiled = useMemo(() => compileQuery(query), [query])
  const visible = links
    .filter((l) => !removedIds.has(l.id))
    .filter((l) => activeTag === ALL || l.tags.includes(activeTag))
    .filter((l) => !compiled || matchesQuery(l, compiled))

  const sections = activeTag === ALL ? groupIntoSections(visible) : null

  const renderRow = (link: Link) => (
    <SwipeableRow
      key={link.id}
      open={swipedId === link.id}
      // Closing is scoped to this row so that a row settling shut can't clear
      // the tray another row has just opened.
      onOpenChange={(open) =>
        setSwipedId((current) => (open ? link.id : current === link.id ? null : current))
      }
      onArchive={() => remove(link, 'archive')}
      onDelete={() => remove(link, 'delete')}
    >
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
    !section.pinned && !compiled && collapsedSections.has(section.key)

  // Sections only exist on the all tab, and a search forces them all open, so
  // there's nothing to collapse in either of those cases.
  const collapsibleKeys = compiled
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
              // Typing Hebrew into an LTR field puts the caret and the
              // punctuation on the wrong side; the rest of the app already
              // leans on dir="auto" for exactly this.
              dir="auto"
              placeholder="Search in Hebrew or English"
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
        <p className={styles.empty}>{emptyMessage(links.length, query.trim(), activeTag)}</p>
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
        {pending && (
          <Toast
            key={pending.link.id}
            message={pending.action === 'delete' ? 'Deleted' : 'Archived'}
            actionLabel="Undo"
            onAction={undo}
            onExpire={commit}
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
