'use client'

import { useEffect } from 'react'
import { motion, useMotionValue, useTransform, animate, type PanInfo } from 'motion/react'
import { CloseIcon } from './Icons'
import styles from './ImageViewer.module.css'

/**
 * Full-screen screenshot viewer (spec §5.5): a darkened backdrop over the
 * current screen rather than a route change, dismissed by dragging the image
 * away, by the backdrop, by the close control, or by Escape.
 */

/** How far the image has to travel to count as thrown away. Generous enough
 *  that a scroll that turned into a drag doesn't close the viewer by
 *  accident, short enough that the gesture doesn't feel like work. */
const DISMISS_DISTANCE = 110

/** …or a flick, however short. px/s. */
const DISMISS_VELOCITY = 500

/** The point at which the scrim is fully gone. Further than the dismiss
 *  distance, so the photo is never floating over the bare list while still
 *  attached to a finger that could still put it back. */
const FADE_DISTANCE = 320

const SPRING = { type: 'spring', stiffness: 550, damping: 45 } as const

export function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  const y = useMotionValue(0)

  // Both driven by the drag rather than animated on their own, so the whole
  // thing tracks the finger: the further the image goes, the more of the list
  // underneath shows through, and the smaller it gets — which is what reads
  // as "putting it back where it came from" rather than "sliding it off".
  const scrimOpacity = useTransform(y, [-FADE_DISTANCE, 0, FADE_DISTANCE], [0, 1, 0])
  const scale = useTransform(y, [-FADE_DISTANCE, 0, FADE_DISTANCE], [0.72, 1, 0.72])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // The list behind must not scroll while the viewer is open.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  function handleDragEnd(_: unknown, info: PanInfo) {
    const thrown =
      Math.abs(info.offset.y) > DISMISS_DISTANCE || Math.abs(info.velocity.y) > DISMISS_VELOCITY
    // Let go short of it and the image goes home. Spring rather than a
    // duration, so a slow release settles gently and a fast one snaps.
    if (thrown) onClose()
    else animate(y, 0, SPRING)
  }

  return (
    <motion.div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {/* The backdrop is its own element rather than the overlay's background:
          it has to fade with the drag, and the overlay's own opacity is
          already spoken for by the enter and exit transitions. */}
      <motion.div className={styles.scrim} style={{ opacity: scrimOpacity }} onClick={onClose} />

      {/* Fades with the scrim. Left at full strength it hangs over the list
          while the photo is halfway home, which reads as chrome that forgot
          it was being dismissed. */}
      <motion.button
        type="button"
        className={styles.close}
        aria-label="Close"
        onClick={onClose}
        style={{ opacity: scrimOpacity }}
      >
        <CloseIcon />
      </motion.button>

      <motion.img
        className={styles.image}
        src={src}
        alt={alt}
        draggable={false}
        drag="y"
        // Home is 0 in both directions, and dragElastic near 1 means the image
        // still tracks the finger almost exactly while being sprung back to it.
        // Up as well as down: the gesture is "get this out of the way", and
        // which way you flick it is not information.
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.9}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        style={{ y, scale }}
      />
    </motion.div>
  )
}
