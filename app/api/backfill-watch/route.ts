import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { fetchMovieData, isTmdbConfigured } from '@/lib/movies'
import { persistScrapedImage } from '@/lib/enrich'
import type { Link } from '@/lib/types'

export const maxDuration = 60

/** Leaves room to answer inside `maxDuration`. Each row is a TMDb search, two
 *  more TMDb calls, an OMDb call and a poster download, so the check is before
 *  each row rather than after. */
const TIME_BUDGET_MS = 40_000

/** Three in a row is a dead key or a rate limit, not bad luck with one title. */
const MAX_CONSECUTIVE_FAILURES = 3

const COLUMNS = 'id, title, tags, imdb_rating, rating_source, imdb_id, trailer_url, poster_url'

type Row = Pick<
  Link,
  'id' | 'title' | 'tags' | 'imdb_rating' | 'rating_source' | 'imdb_id' | 'trailer_url' | 'poster_url'
>

/**
 * POST /api/backfill-watch — fill in the watch fields on rows that predate
 * them: the poster, and the ratings that OMDb alone never produced.
 *
 * Deliberately *not* a re-run of enrichment. Doing that over an old row would
 * re-scrape the page, re-hit Gemini and overwrite a good title with whatever
 * the site serves today — the same objection `/api/reindex` documents. This
 * runs only the watch sub-pipeline, keyed on the title the row already has,
 * and writes only the five fields that sub-pipeline owns. A row's title,
 * description, tags and keywords are never touched.
 *
 * Incremental in the same way `/api/reindex` is: it works until its budget
 * runs out and reports what's left, so a big drawer is a matter of calling it
 * again rather than a stuck job.
 *
 *   POST /api/backfill-watch          rows missing a rating or a poster
 *   POST /api/backfill-watch?force=1  every watch row, e.g. to re-rate
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  // Without TMDb there is no search, no poster and no imdb_id to ask OMDb
  // about, so every row would fail identically.
  if (!isTmdbConfigured()) {
    return NextResponse.json({ error: 'TMDB_API_KEY is not set' }, { status: 500 })
  }

  const force = new URL(request.url).searchParams.get('force') === '1'
  const startedAt = Date.now()

  const { data, error } = await getSupabase()
    .from('links')
    .select(COLUMNS)
    .eq('status', 'unread')
    .contains('tags', ['watch'])
    .order('created_at', { ascending: false })
  if (error) {
    console.error('backfill-watch: could not load rows', error)
    return NextResponse.json({ error: 'Could not load links' }, { status: 500 })
  }

  const rows = ((data ?? []) as unknown as Row[]).filter(
    // A row with no title can't be looked up by one, so it isn't a candidate.
    (row) => row.title?.trim() && (force || !row.imdb_rating || !row.poster_url),
  )

  let updated = 0
  let failed = 0
  let consecutiveFailures = 0
  let ranOutOfTime = false

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      ranOutOfTime = true
      break
    }

    try {
      const movie = await fetchMovieData(row.title as string)

      // Only ever additive. A row that already has a rating keeps it — this is
      // for filling gaps, not for overwriting a number that's already good —
      // unless `force` says otherwise.
      const patch: Partial<Link> = {}
      if (movie.imdb_rating && (force || !row.imdb_rating)) {
        patch.imdb_rating = movie.imdb_rating
        patch.rating_source = movie.rating_source ?? null
      }
      if (movie.imdb_id && (force || !row.imdb_id)) patch.imdb_id = movie.imdb_id
      if (movie.trailer_url && (force || !row.trailer_url)) patch.trailer_url = movie.trailer_url
      if (movie.poster_url && (force || !row.poster_url)) {
        const poster = await persistScrapedImage(movie.poster_url)
        if (poster) patch.poster_url = poster
      }

      if (Object.keys(patch).length === 0) {
        // TMDb didn't recognise the title. Counted rather than written, so the
        // response says how many rows this couldn't help.
        failed += 1
        consecutiveFailures += 1
      } else {
        const { error: writeError } = await getSupabase()
          .from('links')
          .update(patch)
          .eq('id', row.id)
        if (writeError) throw new Error(writeError.message)
        updated += 1
        consecutiveFailures = 0
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`backfill-watch: failed for ${row.id}:`, message)
      failed += 1
      consecutiveFailures += 1
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error('backfill-watch: stopping after repeated failures')
      break
    }
  }

  return NextResponse.json({
    updated,
    failed,
    remaining: rows.length - updated,
    ranOutOfTime,
  })
}
