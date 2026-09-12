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
 * A rating always goes somewhere. It used to link only when `imdb_id` was
 * known, which in practice meant almost never: that column is filled by
 * enrichment or by the backfill route, so every row saved before either of
 * those existed rendered as plain text. Tapping a rating did nothing, with
 * nothing on screen to say why — and the badge had deliberately been made to
 * look the same either way, which turned "this one has no id" into "this
 * feature is broken".
 *
 * So the id is now an optimisation rather than a precondition: with it the
 * link goes straight to the title, without it to IMDb's search for the title's
 * own name, which lands one tap away. Only a row with no title at all can't
 * be pointed anywhere.
 */
function imdbHref(link: Link): string | null {
  if (link.imdb_id) return `https://www.imdb.com/title/${link.imdb_id}/`
  const title = link.title?.trim()
  // s=tt keeps the results to titles rather than people and companies.
  return title ? `https://www.imdb.com/find/?q=${encodeURIComponent(title)}&s=tt` : null
}
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

  const href = rating ? imdbHref(link) : null

  if (href) {
    return (
      <a
        className={`${styles.score} ${styles.scoreLink}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        aria-label={`${label} — ${link.imdb_id ? 'open' : 'find'} on IMDb`}
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
