'use client'

import { useState } from 'react'
import { CORE_TAGS, type Link } from '@/lib/types'
import { LinkRow } from './LinkRow'
import styles from './LinkList.module.css'

const ALL = 'all'

/**
 * The chip bar is the fixed vocabulary, not derived from the data as the mock
 * did. Gemini may attach one freeform tag per link; those are stored and stay
 * searchable, but they don't get a chip — otherwise the bar grows unbounded.
 */
export function LinkList({ links }: { links: Link[] }) {
  const [activeTag, setActiveTag] = useState<string>(ALL)

  const visible = activeTag === ALL ? links : links.filter((l) => l.tags.includes(activeTag))

  return (
    <main className={styles.screen}>
      <div className={styles.header}>
        <h1 className={styles.wordmark}>Junk Drawer</h1>
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
      </div>

      {visible.length === 0 ? (
        <p className={styles.empty}>
          {links.length === 0
            ? 'Nothing saved yet. Share a link from your phone to get started.'
            : `Nothing tagged ${activeTag} yet.`}
        </p>
      ) : (
        visible.map((link) => <LinkRow key={link.id} link={link} />)
      )}
    </main>
  )
}
