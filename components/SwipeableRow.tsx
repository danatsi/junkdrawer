'use client'

import { useEffect, useRef } from 'react'
import { motion, useMotionValue, animate, type PanInfo } from 'motion/react'
import styles from './SwipeableRow.module.css'

/** Each action button's width, and so how far the row slides to uncover them.
 *  Wide enough for the labels at the row's own type size; narrow enough that
 *  two of them still leave most of the row on screen, so you can see what
 *  you're about to act on. Must match `--tray-button` in the stylesheet. */
const BUTTON_WIDTH = 88
const TRAY_WIDTH = BUTTON_WIDTH * 2

/** Fraction of the tray the drag must pass to settle open on release. Under
 *  half, because the gesture is a flick rather than a careful pull. */
const OPEN_THRESHOLD = 0.4

/** A fast flick opens the tray however short it was. px/s. */
const FLICK_VELOCITY = 400

const SPRING = { type: 'spring', stiffness: 500, damping: 40 } as const

/**
 * Left-swipe to uncover two actions: archive and delete.
 *
 * An earlier cut committed on release instead — archive past 40% of the row's
 * width, delete past 75%. One gesture, two outcomes, chosen by how far your
 * thumb happened to travel. It read as a trap: the destructive option was the
 * one you got by swiping harder, and by the time you were deep enough for it
 * your thumb was over the label that said so. So the gesture no longer decides
 * anything. It uncovers two buttons and you tap one.
 *
 * Which row is open is owned by the list (`open`/`onOpenChange`), so opening
 * one closes any other — two trays hanging open at once would put four buttons
 * on screen with nothing saying which row they belong to.
 *
 * Spring easing rather than a CSS ease, per spec §4.4 — the gesture should feel
 * physical, and the overshoot is what sells that.
 */
export function SwipeableRow({
  open,
  onOpenChange,
  onArchive,
  onDelete,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchive: () => void
  onDelete: () => void
  children: React.ReactNode
}) {
  const x = useMotionValue(0)
  // Whether the pointer actually travelled during this gesture. The row body
  // is a link, so the release at the end of a swipe lands as a click and opens
  // it — uncovering the actions and navigating away in the same motion.
  // Nothing upstream suppresses that, so the gesture has to say whether it was
  // a drag or a tap and the click has to be caught before it reaches the
  // anchor.
  const draggedRef = useRef(false)

  // Follows the list's state, which is what makes "opening one closes the
  // other" work: the row that lost its turn animates shut without knowing why.
  useEffect(() => {
    animate(x, open ? -TRAY_WIDTH : 0, SPRING)
  }, [open, x])

  /** Past a few pixels it is a swipe, not a tap with a shaky thumb. */
  function handleDrag(_: unknown, info: PanInfo) {
    if (Math.abs(info.offset.x) > 4) draggedRef.current = true
  }

  function handleDragEnd(_: unknown, info: PanInfo) {
    const shouldOpen =
      info.offset.x < -TRAY_WIDTH * OPEN_THRESHOLD || info.velocity.x < -FLICK_VELOCITY
    // Animated here as well as in the effect above: releasing an already-open
    // row back into the open position doesn't change the list's state, so the
    // effect wouldn't run and the row would stay wherever the drag left it.
    animate(x, shouldOpen ? -TRAY_WIDTH : 0, SPRING)
    onOpenChange(shouldOpen)
  }

  return (
    <div className={styles.container}>
      {/* Behind the row, uncovered as it slides. Out of the reading order
          while shut: they're real buttons sitting under an opaque surface, and
          tabbing onto something invisible is worse than not reaching it. */}
      <div className={styles.tray} aria-hidden={!open}>
        <button
          type="button"
          className={styles.action}
          tabIndex={open ? 0 : -1}
          onClick={onArchive}
        >
          Archive
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.destructive}`}
          tabIndex={open ? 0 : -1}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
      <motion.div
        className={styles.sheet}
        style={{ x }}
        drag="x"
        // Vertical scrolling must win until the gesture is clearly horizontal.
        dragDirectionLock
        // Stops at the tray rather than sliding the row off the screen: the
        // buttons are the point, and there's nothing further left to reach.
        dragConstraints={{ left: -TRAY_WIDTH, right: 0 }}
        // A little give past the tray so the gesture doesn't hit a wall, and
        // none at all on the right, where home is the edge of the row.
        dragElastic={{ left: 0.15, right: 0 }}
        dragMomentum={false}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        // Capture phase, and on the sheet rather than the container: the anchor
        // is a descendant, so this is the only place the click can be stopped
        // before it navigates — and putting it here leaves taps on the tray
        // buttons alone.
        onClickCapture={(e) => {
          // An open tray makes the row body a way to shut it again, which is
          // the obvious thing to reach for and otherwise navigates instead.
          if (!draggedRef.current && !open) return
          e.preventDefault()
          e.stopPropagation()
          draggedRef.current = false
          if (open) onOpenChange(false)
        }}
        // A gesture that never moves must leave the flag clear, or the tap
        // after a swipe would be swallowed too.
        onPointerDownCapture={() => {
          draggedRef.current = false
        }}
      >
        {children}
      </motion.div>
    </div>
  )
}
