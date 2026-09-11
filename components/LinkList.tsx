'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import { AnimatePresence, motion } from 'motion/react'
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

/** Keys are ids and CSS selectors as well as labels, hence the split. The
 *  labels are sentence case because they're phrases; a tag's own label is
 *  capitalised where it's used as one (see `capitalise`). */
const PENDING_SECTION = { key: 'pending', label: 'Adding details' } as const
const OTHER_SECTION = { key: 'other', label: 'Everything else' } as const

/** The spring the sliding tab pill rides on. Short and slightly damped —
 *  quick enough to keep up with a series of taps, soft enough to read as one
 *  object moving rather than a background snapping on. */
const TAB_SPRING = { type: 'spring', stiffness: 520, damping: 38 } as const

/** Tags are stored lowercase; as a section title one is a proper label. */
function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

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
  for (const tag of SECTION_ORDER) add(tag, capitalise(tag))
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
    const response = await fetch(`/api/links/${id}`, { method: 'DELETE', keepalive })
    // `fetch` rejects on a network failure and nothing else, so a server that
    // refused — a 404 from the site gate, a 500 from a bad key — arrives here
    // looking exactly like success. Unlogged, the two were indistinguishable:
    // the row was gone from the list either way and came back on the next load.
    if (!response.ok) console.error(`Could not delete link ${id}: ${response.status}`)
  } catch {
    // Same reasoning as a failed status write: the row has already left the
    // list, and the next load is a better place to disagree than mid-toast.
    console.error(`Could not delete link ${id}: request failed`)
  }
}

export function LinkList({ links }: { links: Link[] }) {
  const [activeTag, setActiveTag] = useState<string>(ALL)
  // Whether the large title has started to leave, which is what hands the
  // title over to the compact bar (HIG: large titles collapse on scroll).
  const [scrolled, setScrolled] = useState(false)
  // Focus alone reveals Cancel, before anything has been typed — the iOS
  // search bar offers the way out as soon as it takes the keyboard.
  const [searchActive, setSearchActive] = useState(false)
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
  // Rows swiped away as deletes whose request hasn't gone out yet.
  //
  // A ref rather than state, because the undo window used to be held by a
  // timer inside the toast, and every path that took the toast away took the
  // request with it: a second swipe replaced `pending` and cleared the first
  // row's timer, and moving to another page in the app unmounted the list
  // without firing `pagehide`. Either way the row was gone from the list and
  // still sitting in the table. Now the hold lives here, outside the render
  // that owns the toast, and every path that closes the window flushes it.
  //
  // Taking the id back out of the set is what claims the send, so a flush that
  // races another one — the timer against the tab closing — still sends once.
  const unsentDeletes = useRef<Set<string>>(new Set())
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

  // Passive, and writes a boolean rather than the offset: React bails out of
  // the re-render while the answer is unchanged, so this costs nothing for the
  // length of a scroll.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

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

  const flushDelete = useCallback((id: string, options?: { keepalive?: boolean }) => {
    if (unsentDeletes.current.delete(id)) void destroy(id, options)
  }, [])

  const remove = useCallback(
    (link: Link, action: SwipeAction) => {
      setRemovedIds((current) => new Set(current).add(link.id))
      // The tray goes with the row. Left set, it would reopen under the row
      // that undo puts back.
      setSwipedId(null)
      // This swipe takes the toast off whatever row had it, and the toast is
      // the only way back — so a delete that row was still holding is due now,
      // whether this swipe is a delete or an archive.
      if (pending?.action === 'delete') flushDelete(pending.link.id)
      setPending({ link, action })
      // An archive is written straight away because it's reversible either
      // way: the row is still in the table and undo just sets it back. A
      // delete isn't sent at all until the undo window closes — see `commit`.
      if (action === 'archive') void setStatus(link.id, 'done')
      else unsentDeletes.current.add(link.id)
    },
    [pending, setStatus, flushDelete],
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
    else unsentDeletes.current.delete(pending.link.id)
  }, [pending, setStatus])

  /** The undo window closed: whatever was being held back now happens. */
  const commit = useCallback(() => {
    if (pending?.action === 'delete') flushDelete(pending.link.id)
    setPending(null)
  }, [pending, flushDelete])

  // The row is gone from the list the moment it's swiped, but the request that
  // makes that true is five seconds behind it — so anything that ends this
  // component inside the window would resurrect a row the person watched
  // leave. Both ways out are covered, because they are genuinely different
  // events: closing the tab fires `pagehide` and never unmounts, while moving
  // to another page in the app unmounts and fires no `pagehide` at all.
  //
  // `keepalive` on both, since a request begun as the document is torn down
  // needs to outlive it, and it costs nothing when the page survives.
  useEffect(() => {
    const flushAll = () => {
      for (const id of [...unsentDeletes.current]) flushDelete(id, { keepalive: true })
    }
    window.addEventListener('pagehide', flushAll)
    return () => {
      window.removeEventListener('pagehide', flushAll)
      flushAll()
    }
  }, [flushDelete])

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
    setSearchActive(false)
    setQuery('')
    searchRef.current?.blur()
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
      {/* The compact bar. It holds the trailing button at all times and takes
          over the title once the large one has scrolled away. The title here
          is a second copy of the <h1> below, so it's hidden from assistive
          tech rather than announced twice. */}
      <div className={`${styles.navBar} ${scrolled ? styles.navBarScrolled : ''}`}>
        <div className={styles.navSpacer} />
        <span
          aria-hidden="true"
          className={`${styles.navTitle} ${scrolled ? styles.navTitleVisible : ''}`}
        >
          Junk Drawer
        </span>
        {/* Stand-in for the Shortcut, for saving from a desktop browser. */}
        <NextLink className={styles.barButton} href="/capture" aria-label="Add a link">
          <PlusIcon />
        </NextLink>
      </div>

      <h1 className={styles.largeTitle}>Junk Drawer</h1>

      {/* Always on screen, under the title, rather than behind an icon: it's
          where iOS puts a search bar, and a filter you can see is one you
          remember you have. */}
      <div className={styles.searchRow}>
        <div className={styles.searchField}>
          <span className={styles.searchGlyph}>
            <SearchIcon />
          </span>
          <input
            ref={searchRef}
            className={styles.searchInput}
            type="search"
            // Typing Hebrew into an LTR field puts the caret and the
            // punctuation on the wrong side; the rest of the app already
            // leans on dir="auto" for exactly this.
            dir="auto"
            placeholder="Search"
            aria-label="Search links in Hebrew or English"
            value={query}
            onFocus={() => setSearchActive(true)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
          />
          {query && (
            <button
              type="button"
              className={styles.searchClear}
              aria-label="Clear search"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <CloseIcon />
            </button>
          )}
        </div>
        {(searchActive || query) && (
          <button type="button" className={styles.searchCancel} onClick={closeSearch}>
            Cancel
          </button>
        )}
      </div>

      <div className={styles.tabs} role="group" aria-label="Filter by tag">
        {[ALL, ...CORE_TAGS].map((tag) => (
          <button
            key={tag}
            type="button"
            className={`${styles.tab} ${tag === activeTag ? styles.tabActive : ''}`}
            aria-pressed={tag === activeTag}
            onClick={() => setActiveTag(tag)}
          >
            {/* Rendered only under the active tab, and the same element
                throughout: `layoutId` is what makes it travel to the tab you
                tapped instead of disappearing here and reappearing there. */}
            {tag === activeTag && (
              <motion.span layoutId="tabPill" className={styles.tabPill} transition={TAB_SPRING} />
            )}
            <span className={styles.tabLabel}>{tag}</span>
          </button>
        ))}
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
            <section key={section.key} className={styles.section}>
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
                  {sectionLabel(section)}
                  <span
                    className={`${styles.sectionChevron} ${
                      collapsed ? styles.sectionChevronClosed : ''
                    }`}
                  >
                    <ChevronIcon />
                  </span>
                </button>
              )}
              {!collapsed && (
                <div id={bodyId} className={styles.group}>
                  {section.links.map(renderRow)}
                </div>
              )}
            </section>
          )
        })
      ) : (
        // A filtered tab is one category, so it's a single group with no
        // header — the segmented control above it already says which.
        <div className={styles.section}>
          <div className={styles.group}>{visible.map(renderRow)}</div>
        </div>
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
