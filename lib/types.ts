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
  status: LinkStatus
  imdb_rating: string | null
  trailer_url: string | null
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
