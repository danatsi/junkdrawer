'use client'

import { useEffect } from 'react'
import { motion } from 'motion/react'
import styles from './Toast.module.css'

/** Undo window for an archive, in ms. */
export const UNDO_TIMEOUT_MS = 5000

export function Toast({
  message,
  actionLabel,
  onAction,
  onExpire,
}: {
  message: string
  actionLabel: string
  onAction: () => void
  onExpire: () => void
}) {
  // Re-armed whenever a new archive replaces the previous one, since the
  // parent remounts this with a fresh key.
  useEffect(() => {
    const timer = setTimeout(onExpire, UNDO_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [onExpire])

  return (
    <motion.div
      className={styles.toast}
      role="status"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <span>{message}</span>
      <button type="button" className={styles.undo} onClick={onAction}>
        {actionLabel}
      </button>
    </motion.div>
  )
}
