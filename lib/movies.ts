import 'server-only'

/**
 * Step 4 of the enrichment pipeline (spec §3.3): the `watch` sub-pipeline.
 *
 * TMDb gives the overview, the IMDb id and the trailer; OMDb turns that IMDb
 * id into the actual IMDb rating, which reads differently from TMDb's own
 * vote_average and is the number wanted here (spec §3.4).
 *
 * Every step is optional and degrades independently. A film with no trailer,
 * or an OMDb outage, must still produce a normal row — so nothing in here
 * throws, and a partial result is a valid result.
 */
export type RatingSource = 'imdb' | 'tmdb'

export interface MovieData {
  /** Only set by the by-id path, where the title is authoritative rather than
   *  something we searched for. */
  title?: string
  description?: string
  imdb_rating?: string
  /** Which service the number came from. IMDb's and TMDb's read differently,
   *  so a row has to know: it decides what the badge is called and whether it
   *  can link anywhere. */
  rating_source?: RatingSource
  /** Kept so the badge can open the title on IMDb. Available whenever TMDb
   *  knows the title, independently of whether OMDb answered. */
  imdb_id?: string
  trailer_url?: string
  /** The show's own poster. For a screenshot row this is the whole point: what
   *  was saved is a photograph of a phone screen, and the thing it's *about*
   *  has a picture of its own that identifies it in a 44px square. */
  poster_url?: string
}

const TIMEOUT_MS = 5_000
const TMDB = 'https://api.themoviedb.org/3'

/** w342 rather than the original file. The largest this is ever drawn is a
 *  56px panel thumbnail, and an original poster is several MB. */
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

function posterUrl(path: string | null | undefined): string | undefined {
  return path ? `${POSTER_BASE}${path}` : undefined
}

export function isTmdbConfigured(): boolean {
  return Boolean(process.env.TMDB_API_KEY)
}

export async function fetchMovieData(title: string): Promise<MovieData> {
  const tmdbKey = process.env.TMDB_API_KEY
  if (!tmdbKey || !title.trim()) return {}

  const hit = await search(title, tmdbKey)
  if (!hit) return {}

  // Independent of each other, so there's no reason to wait serially.
  const [externalIds, videos] = await Promise.all([
    getJson<{ imdb_id?: string | null }>(
      `${TMDB}/${hit.media_type}/${hit.id}/external_ids?api_key=${tmdbKey}`,
    ),
    getJson<{ results?: TmdbVideo[] }>(
      `${TMDB}/${hit.media_type}/${hit.id}/videos?api_key=${tmdbKey}`,
    ),
  ])

  const imdbId = externalIds?.imdb_id || undefined
  const rating = pickRating(imdbId ? (await fetchOmdb(imdbId))?.rating : undefined, hit.vote_average)

  return {
    description: hit.overview?.trim() || undefined,
    trailer_url: pickTrailer(videos?.results),
    imdb_rating: rating?.value,
    rating_source: rating?.source,
    imdb_id: imdbId,
    poster_url: posterUrl(hit.poster_path),
  }
}

/**
 * The rating, from whichever service will give us one.
 *
 * IMDb's is still the number wanted (spec §3.4), and it's still tried first.
 * But it was for a long time the *only* number: OMDb is the sole source of it,
 * and OMDb goes quiet for at least four ordinary reasons — no API key, no
 * imdb_id from TMDb, a literal "N/A" for anything recent or any per-season TV
 * entry, and a 1,000/day quota. Any of those and the row showed no rating at
 * all, while TMDb's own average sat unread in the search response we had
 * already paid for. A slightly different number beats no number.
 */
function pickRating(
  omdbRating: string | undefined,
  tmdbVote: number | undefined,
): { value: string; source: RatingSource } | undefined {
  if (omdbRating) return { value: omdbRating, source: 'imdb' }
  // TMDb reports 0 for a title nobody has voted on, which is an absence rather
  // than a score of zero — and would render as a confident "0.0".
  if (typeof tmdbVote === 'number' && tmdbVote > 0) {
    return { value: tmdbVote.toFixed(1), source: 'tmdb' }
  }
  return undefined
}

/**
 * An IMDb title URL identifies the thing exactly — but only as an opaque id.
 * `tt1442437` contains no words, so nothing downstream can infer a title from
 * it; it has to be resolved. IMDb also blocks scraping, which means this is
 * the only place the real title can come from.
 */
export function extractImdbId(rawUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (!/(^|\.)imdb\.com$/i.test(url.hostname)) return undefined
  const match = /^\/title\/(tt\d+)/i.exec(url.pathname)
  return match?.[1].toLowerCase()
}

/**
 * The same data as fetchMovieData, keyed off an IMDb id instead of a title —
 * so it can't land on the wrong film, which searching by name can. Both
 * halves stay optional: OMDb alone still yields a title and a rating, TMDb
 * alone still yields a synopsis and a trailer.
 */
export async function fetchMovieDataByImdbId(imdbId: string): Promise<MovieData> {
  const tmdbKey = process.env.TMDB_API_KEY
  const [omdb, hit] = await Promise.all([
    fetchOmdb(imdbId),
    tmdbKey ? findByImdbId(imdbId, tmdbKey) : undefined,
  ])

  const videos =
    hit && tmdbKey
      ? await getJson<{ results?: TmdbVideo[] }>(
          `${TMDB}/${hit.media_type}/${hit.id}/videos?api_key=${tmdbKey}`,
        )
      : undefined

  const rating = pickRating(omdb?.rating, hit?.vote_average)

  return {
    // OMDb's is the title IMDb itself shows, which is what the saved link said.
    title: omdb?.title ?? hit?.title,
    description: hit?.overview?.trim() || omdb?.plot,
    imdb_rating: rating?.value,
    rating_source: rating?.source,
    // The id this whole lookup was keyed on, so it's known even when both
    // OMDb and TMDb come back with nothing.
    imdb_id: imdbId,
    trailer_url: pickTrailer(videos?.results),
    poster_url: posterUrl(hit?.poster_path),
  }
}

/** /find returns movies and shows in separate buckets, neither of which
 *  carries media_type — the bucket it arrived in is the media type. */
async function findByImdbId(
  imdbId: string,
  key: string,
): Promise<
  | {
      id: number
      media_type: 'movie' | 'tv'
      title?: string
      overview?: string
      poster_path?: string | null
      vote_average?: number
    }
  | undefined
> {
  const data = await getJson<{ movie_results?: TmdbFound[]; tv_results?: TmdbFound[] }>(
    `${TMDB}/find/${encodeURIComponent(imdbId)}?api_key=${key}&external_source=imdb_id`,
  )

  const movie = data?.movie_results?.[0]
  if (movie) {
    return {
      id: movie.id,
      media_type: 'movie',
      title: movie.title,
      overview: movie.overview,
      poster_path: movie.poster_path,
      vote_average: movie.vote_average,
    }
  }

  const tv = data?.tv_results?.[0]
  if (tv) {
    return {
      id: tv.id,
      media_type: 'tv',
      title: tv.name,
      overview: tv.overview,
      poster_path: tv.poster_path,
      vote_average: tv.vote_average,
    }
  }

  return undefined
}

interface TmdbFound {
  id: number
  /** Films carry `title`, shows carry `name`. */
  title?: string
  name?: string
  overview?: string
  poster_path?: string | null
  vote_average?: number
}

interface TmdbHit {
  id: number
  media_type: 'movie' | 'tv'
  overview?: string
  popularity?: number
  poster_path?: string | null
  vote_average?: number
}

interface TmdbVideo {
  key?: string
  site?: string
  type?: string
  official?: boolean
}

async function search(title: string, key: string): Promise<TmdbHit | undefined> {
  const url = `${TMDB}/search/multi?api_key=${key}&query=${encodeURIComponent(title)}`
  const data = await getJson<{ results?: (TmdbHit & { media_type?: string })[] }>(url)

  // /search/multi also returns people, which have no overview or trailer.
  return data?.results?.find(
    (r): r is TmdbHit => r.media_type === 'movie' || r.media_type === 'tv',
  )
}

/** Prefers an official YouTube trailer, then any YouTube trailer, then any
 *  YouTube video at all — a teaser still beats no link. */
function pickTrailer(videos: TmdbVideo[] | undefined): string | undefined {
  if (!videos?.length) return undefined
  const youtube = videos.filter((v) => v.site === 'YouTube' && v.key)
  const chosen =
    youtube.find((v) => v.type === 'Trailer' && v.official) ??
    youtube.find((v) => v.type === 'Trailer') ??
    youtube[0]
  return chosen?.key ? `https://www.youtube.com/watch?v=${chosen.key}` : undefined
}

interface OmdbData {
  title?: string
  plot?: string
  rating?: string
}

async function fetchOmdb(imdbId: string): Promise<OmdbData | undefined> {
  const key = process.env.OMDB_API_KEY
  if (!key) return undefined

  const data = await getJson<{ Title?: string; Plot?: string; imdbRating?: string }>(
    `https://www.omdbapi.com/?apikey=${key}&i=${encodeURIComponent(imdbId)}`,
  )
  if (!data) return undefined

  return { title: usable(data.Title), plot: usable(data.Plot), rating: usable(data.imdbRating) }
}

/** OMDb returns the string "N/A" rather than omitting a field. */
function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed !== 'N/A' ? trimmed : undefined
}

/** Returns undefined on any failure. Callers treat every field as optional,
 *  so a dead endpoint just means a slightly thinner row. */
async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}
