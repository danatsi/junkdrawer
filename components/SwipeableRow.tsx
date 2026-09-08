'use client'

import { useRef } from 'react'
import { motion, useMotionValue, useTransform, animate, type PanInfo } from 'motion/react'
import styles from './SwipeableRow.module.css'

/** Fraction of the row's width the swipe must pass to commit on release. */
const COMMIT_THRESHOLD = 0.4

/**
 * Left-swipe to archive. Releasing past 40% of the row's width springs the row
 * out and calls onArchive; anything short of that springs back.
 *
 * Spring easing rather than a CSS ease, per spec §4.4 — the gesture should feel
 * physical, and the overshoot is what sells that.
 */
export function SwipeableRow({
  onArchive,
  children,
}: {
  onArchive: () => void
  children: React.ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const x = useMotionValue(0)
  // Whether the pointer actually travelled during this gesture. The row body
  // is a link, so the release at the end of a swipe lands as a click and opens
  // it — archiving the row and navigating away in the same motion. Nothing
  // upstream suppresses that, so the gesture has to say whether it was a drag
  // or a tap and the click has to be caught before it reaches the anchor.
  const draggedRef = useRef(false)

  // The archive backdrop stays hidden until the drag actually starts, so it
  // never flashes behind a stationary row.
  const backdropOpacity = useTransform(x, [-80, -8, 0], [1, 0.5, 0])

  /** Past a few pixels it is a swipe, not a tap with a shaky thumb. */
  function handleDrag(_: unknown, info: PanInfo) {
    if (Math.abs(info.offset.x) > 4) draggedRef.current = true
  }

  function handleDragEnd(_: unknown, info: PanInfo) {
    const width = containerRef.current?.offsetWidth ?? 0
    const passedThreshold = width > 0 && info.offset.x < -width * COMMIT_THRESHOLD

    if (passedThreshold) {
      animate(x, -width, {
        type: 'spring',
        stiffness: 500,
        damping: 40,
        onComplete: onArchive,
      })
    } else {
      animate(x, 0, { type: 'spring', stiffness: 500, damping: 40 })
    }
  }

  return (
    <div
      className={styles.container}
      ref={containerRef}
      // Capture phase: the anchor is a descendant, so this is the only place
      // the click can be stopped before it navigates.
      onClickCapture={(e) => {
        if (!draggedRef.current) return
        e.preventDefault()
        e.stopPropagation()
        draggedRef.current = false
      }}
      // A gesture that never moves must leave the flag clear, or the tap after
      // a swipe would be swallowed too.
      onPointerDownCapture={() => {
        draggedRef.current = false
      }}
    >
      <motion.div className={styles.backdrop} style={{ opacity: backdropOpacity }} aria-hidden="true">
        Archive
      </motion.div>
      <motion.div
        className={styles.sheet}
        style={{ x }}
        drag="x"
        // Vertical scrolling must win until the gesture is clearly horizontal.
        dragDirectionLock
        dragConstraints={{ left: -10_000, right: 0 }}
        dragElastic={{ left: 1, right: 0 }}
        dragMomentum={false}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
      >
        {children}
      </motion.div>
    </div>
  )
}
