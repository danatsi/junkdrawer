import 'server-only'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { fetchOpenGraph } from './og'
import { generateMetadata, isGeminiConfigured } from './gemini'
import { fetchMovieData } from './movies'
import type { Link } from './types'

/**
 * The enrichment orchestrator (PLAN §4). Runs after the capture endpoint has
 * already answered, so nothing here is on the Shortcut's critical path.
 *
 * The ordering principle throughout: never lose data we already have. The
 * scrape result is written even if Gemini dies, and the Gemini result is
 * written even if the watch lookup dies. `failed` means "retry me", not
 * "throw away the partial row" — which is why the update is assembled
 * incrementally rather than in one all-or-nothing write at the end.
 */
export interface EnrichTarget {
  id: string
  url: string
  domain: string | null
  note: string | null
}

export async function enrich(link: EnrichTarget): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.error('enrich: Supabase not configured; skipping', link.id)
    return
  }

  const update: Partial<Link> = {}
  const startedAt = Date.now()

  try {
    // 1. Open Graph. Returns {} rather than throwing on any failure.
    const og = await fetchOpenGraph(link.url)
    if (og.title) update.title = og.title
    if (og.description) update.description = og.description
    if (og.image) update.image_url = og.image

    // 2. Gemini. Its title supersedes the scraped one (spec §4.5: titles are
    //    the generated clean title, not the raw page title).
    if (!isGeminiConfigured()) {
      throw new Error('GEMINI_API_KEY is not set')
    }
    const generated = await generateMetadata({
      url: link.url,
      domain: link.domain,
      note: link.note,
      og,
    })
    if (generated.clean_title) update.title = generated.clean_title
    if (generated.summary) update.description = generated.summary
    update.tags = generated.tags

    // 3. The watch sub-pipeline, only when Gemini said so.
    if (generated.tags.includes('watch')) {
      const movie = await fetchMovieData(generated.clean_title || og.title || '')
      // TMDb's overview is a real synopsis; prefer it over the 20-word summary.
      if (movie.description) update.description = movie.description
      if (movie.imdb_rating) update.imdb_rating = movie.imdb_rating
      if (movie.trailer_url) update.trailer_url = movie.trailer_url
    }

    await save(link.id, { ...update, enrichment: 'ok', enrich_error: null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The elapsed time is the fastest way to tell a timeout apart from an
    // upstream rejection when reading logs after the fact.
    console.error(`enrich: failed for ${link.id} after ${Date.now() - startedAt}ms:`, message)
    // Keep whatever did succeed, and record why the rest didn't. The row stays
    // usable; PLAN §4 explicitly wants the domain showing as a title over an
    // empty row.
    await save(link.id, {
      ...update,
      enrichment: 'failed',
      enrich_error: message.slice(0, 500),
    })
  }
}

async function save(id: string, patch: Partial<Link>): Promise<void> {
  const { error } = await getSupabase().from('links').update(patch).eq('id', id)
  if (error) {
    // Nothing left to fall back to — the row keeps its previous state and the
    // retry endpoint is the way out.
    console.error('enrich: could not write row', id, error)
  }
}
