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
export interface MovieData {
  /** Only set by the by-id path, where the title is authoritative rather than
   *  something we searched for. */
  title?: string
  description?: string
  imdb_rating?: string
  trailer_url?: string
}

const TIMEOUT_MS = 5_000
const TMDB = 'https://api.themoviedb.org/3'

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

  return {
    description: hit.overview?.trim() || undefined,
    trailer_url: pickTrailer(videos?.results),
    imdb_rating: imdbId ? (await fetchOmdb(imdbId))?.rating : undefined,
  }
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

  return {
    // OMDb's is the title IMDb itself shows, which is what the saved link said.
    title: omdb?.title ?? hit?.title,
    description: hit?.overview?.trim() || omdb?.plot,
    imdb_rating: omdb?.rating,
    trailer_url: pickTrailer(videos?.results),
  }
}

/** /find returns movies and shows in separate buckets, neither of which
 *  carries media_type — the bucket it arrived in is the media type. */
async function findByImdbId(
  imdbId: string,
  key: string,
): Promise<{ id: number; media_type: 'movie' | 'tv'; title?: string; overview?: string } | undefined> {
  const data = await getJson<{ movie_results?: TmdbFound[]; tv_results?: TmdbFound[] }>(
    `${TMDB}/find/${encodeURIComponent(imdbId)}?api_key=${key}&external_source=imdb_id`,
  )

  const movie = data?.movie_results?.[0]
  if (movie) return { id: movie.id, media_type: 'movie', title: movie.title, overview: movie.overview }

  const tv = data?.tv_results?.[0]
  if (tv) return { id: tv.id, media_type: 'tv', title: tv.name, overview: tv.overview }

  return undefined
}

interface TmdbFound {
  id: number
  /** Films carry `title`, shows carry `name`. */
  title?: string
  name?: string
  overview?: string
}

interface TmdbHit {
  id: number
  media_type: 'movie' | 'tv'
  overview?: string
  popularity?: number
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
