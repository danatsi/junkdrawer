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
    imdb_rating: imdbId ? await fetchImdbRating(imdbId) : undefined,
  }
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

async function fetchImdbRating(imdbId: string): Promise<string | undefined> {
  const key = process.env.OMDB_API_KEY
  if (!key) return undefined

  const data = await getJson<{ imdbRating?: string }>(
    `https://www.omdbapi.com/?apikey=${key}&i=${encodeURIComponent(imdbId)}`,
  )
  // OMDb returns the string "N/A" rather than omitting the field.
  const rating = data?.imdbRating?.trim()
  return rating && rating !== 'N/A' ? rating : undefined
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
