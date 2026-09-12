import type { Link } from '@/lib/types'
import { HeartIcon, StarIcon } from './Icons'
import styles from './LinkRow.module.css'

/**
 * The number a row wears at rest: an IMDb or TMDb rating for a film or show,
 * the taste score for a book.
 *
 * Shared by both row types because the badge is the same object in both, and
 * the screenshot row had already drifted into its own slightly different copy
 * once — it rendered the taste score and silently dropped the rating.
 *
 * A link when we know which title this is, plain text when we don't. Nothing
 * about the badge changes shape between those two cases: a rating that
 * sometimes has a chevron or an underline would make the ones without look
 * broken, and the tap target is the whole capsule either way.
 */
export function ScoreBadge({ link }: { link: Link }) {
  const rating = link.imdb_rating
  const value = rating ?? (link.reassurance_score !== null ? `${link.reassurance_score}/10` : null)
  if (!value) return null

  // TMDb's average and IMDb's read differently, so the row says which it has
  // rather than letting a TMDb number pass as IMDb's. Only in the accessible
  // name — on screen both are a star and a number.
  const label = rating
    ? `${link.rating_source === 'tmdb' ? 'TMDb' : 'IMDb'} rating ${rating}`
    : `How much you'll like this: ${link.reassurance_score} out of 10`

  // A star is what a rating is, everywhere. The book number is not a rating —
  // nobody voted on it, it's a guess about one reader — so it gets a heart,
  // and the two stop looking like the same measurement in different units.
  const body = (
    <>
      {rating ? <StarIcon /> : <HeartIcon />}
      {value}
    </>
  )

  if (rating && link.imdb_id) {
    return (
      <a
        className={`${styles.score} ${styles.scoreLink}`}
        href={`https://www.imdb.com/title/${link.imdb_id}/`}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        aria-label={`${label} — open on IMDb`}
        // The row is a link too. Without this the tap opens the saved page
        // underneath as well as IMDb.
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </a>
    )
  }

  return (
    <span className={`${styles.score} ${rating ? '' : styles.scoreLove}`} aria-label={label}>
      {body}
    </span>
  )
}
