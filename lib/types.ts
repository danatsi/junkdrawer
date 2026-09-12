/** Mirrors the `links` table in PLAN.md §2. */
export type LinkStatus = 'unread' | 'done'
export type LinkType = 'link' | 'screenshot'
export type EnrichmentState = 'pending' | 'ok' | 'failed'

/** The four fixed tags rendered as filter chips. Gemini may add at most one
 *  freeform tag beyond these; freeform tags are stored and searchable but
 *  never get a chip. */
export const CORE_TAGS = ['shopping', 'watch', 'recipe', 'read'] as const
export type CoreTag = (typeof CORE_TAGS)[number]

export interface Link {
  id: string
  url: string
  note: string | null
  title: string | null
  description: string | null
  image_url: string | null
  /** Whether image_url is a real photo or a site favicon standing in for one.
   *  Null when there's no image. Only 'photo' is rendered as a thumbnail — an
   *  'icon' is stored but deliberately not shown, because a favicon shrunk
   *  into the 40px square reads as clutter; those rows get the derived
   *  monogram tile instead (see LinkRow). */
  image_kind: 'photo' | 'icon' | null
  domain: string | null
  tags: string[]
  /** Generated search vocabulary — the words you'd type to find this row,
   *  in Hebrew and English whatever language the page was in. Never rendered;
   *  see lib/search.ts for why substring matching on the title isn't enough. */
  keywords: string[]
  status: LinkStatus
  imdb_rating: string | null
  /** Which service `imdb_rating` came from. IMDb's number is preferred and
   *  tried first, but it has a single fragile source (OMDb), so TMDb's own
   *  average stands in rather than leaving the row unrated. */
  rating_source: 'imdb' | 'tmdb' | null
  /** Set whenever TMDb recognised the title, rating or no rating. What makes
   *  the score badge a link to IMDb. */
  imdb_id: string | null
  trailer_url: string | null
  /** The film or show's own poster, `watch`-tagged rows only. Outranks
   *  `image_url` as the row's thumbnail — on a screenshot row especially,
   *  where `image_url` is a photograph of a phone screen and this is the
   *  picture that says which show it is. `image_url` still holds the
   *  screenshot, which is what the panel and the viewer show. */
  poster_url: string | null
  /** 0-10, `read`-tagged rows only: how confidently the fixed taste profile
   *  in lib/gemini.ts predicts this specific book will land. Null for
   *  anything that isn't a specific book — the watch tag's imdb_rating, but
   *  reasoned out by Gemini rather than looked up, since there's no API for
   *  "will I like it". */
  reassurance_score: number | null
  /** One sentence saying why the score is what it is, in terms of the taste
   *  profile — what the book is doing that this reader likes or doesn't.
   *  Shown in the row's expanded panel, under the synopsis. Null wherever
   *  `reassurance_score` is. */
  reassurance_reason: string | null
  type: LinkType
  enrichment: EnrichmentState
  enrich_error: string | null
  /** OCR'd text from a screenshot (spec §5.3). Null for link rows. */
  extracted_text: string | null
  created_at: string
}

/** What a row shows before enrichment finishes: the domain stands in for the
 *  title, since there's nothing better yet. A screenshot has no domain and its
 *  `url` is only an internal identifier, so it falls back to a plain word
 *  rather than leaking that identifier into the UI. */
export function displayTitle(link: Link): string {
  const title = link.title?.trim()
  if (title) return title
  if (link.type === 'screenshot') return 'Screenshot'
  return link.domain || link.url
}
