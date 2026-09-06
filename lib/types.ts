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
  domain: string | null
  tags: string[]
  status: LinkStatus
  imdb_rating: string | null
  trailer_url: string | null
  type: LinkType
  enrichment: EnrichmentState
  enrich_error: string | null
  created_at: string
}

/** What a row shows before enrichment finishes: the domain stands in for the
 *  title, since there's nothing better yet. */
export function displayTitle(link: Link): string {
  return link.title?.trim() || link.domain || link.url
}
