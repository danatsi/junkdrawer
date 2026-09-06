'use client'

import { useEffect } from 'react'
import { motion } from 'motion/react'
import { CloseIcon } from './Icons'
import styles from './ImageViewer.module.css'

/**
 * Full-screen screenshot viewer (spec §5.5): a darkened backdrop over the
 * current screen rather than a route change, dismissed by the backdrop, the
 * close control, or Escape.
 */
export function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
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
      onClick={onClose}
    >
      <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
        <CloseIcon />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.image} src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </motion.div>
  )
}
