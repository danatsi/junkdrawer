import 'server-only'
import { createHash } from 'node:crypto'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { fetchOpenGraph, isPlaceholderTitle, mergeOg, type OgData } from './og'
import { ensureFavicon } from './icons'
import { fetchImage } from './fetch-image'
import { uploadImage } from './storage'
import { searchQueryOf } from './url'
import { generateFromImage, generateMetadata, isGeminiConfigured } from './gemini'
import { extractImdbId, fetchMovieData, fetchMovieDataByImdbId, type MovieData } from './movies'
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
  /** Set when the capture already stored a photo taken from the rendered page.
   *  Nothing scraped can beat that, so enrichment leaves the image alone. */
  keepImage?: boolean
  /** Metadata the Shortcut read from the page in your own browser. Beats the
   *  scrape wherever the two disagree — see `parseClientPage`. */
  page?: OgData | null
}

export async function enrich(link: EnrichTarget): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.error('enrich: Supabase not configured; skipping', link.id)
    return
  }

  const update: Partial<Link> = {}
  const startedAt = Date.now()

  try {
    // 1. Open Graph. Returns {} rather than throwing on any failure. Where
    //    the Shortcut sent what the page said, that wins: it read the real
    //    page, and this fetch may well have been handed an interstitial.
    const og = mergeOg(await fetchOpenGraph(link.url), link.page)

    // 1b. An IMDb title URL is the case where a failed scrape is not merely
    //     thin data. IMDb blocks the fetch above (it answers 202 with a bot
    //     page), leaving step 2 nothing but `/title/tt1442437/` — and an
    //     opaque id is the one input it cannot infer a title from without
    //     inventing one, which it will, confidently and wrongly. Resolving
    //     the id here means the title is looked up rather than guessed, and
    //     the real title and synopsis stand in for the missing scrape.
    const imdbId = extractImdbId(link.url)
    let movie: MovieData | undefined
    if (imdbId) {
      movie = await fetchMovieDataByImdbId(imdbId)
      if (movie.title) og.title = movie.title
      if (movie.description) og.description = movie.description
    }

    // 1c. A page of search results is the one case where the page's own
    //     metadata describes the page instead of the thing: the title is the
    //     engine's name, the description its tagline, the image its logo. All
    //     three are dropped rather than ranked, because none of them can ever
    //     be the answer — a Google results page for a book was saved as
    //     "Google Search" by trusting the first of them. What was typed is in
    //     the URL, and that is the subject (see `searchQueryOf`).
    const searchQuery = searchQueryOf(link.url)
    if (searchQuery) {
      og.title = undefined
      og.description = undefined
      og.image = undefined
    }

    // The page's own title wins when it has one. It is free, it is exact, and
    // it is in the language the page is written in — a Hebrew book came back
    // as "achi lo eshet hayil" when the model was the one naming rows. Site
    // chrome is already stripped in og.ts, so what's left needs no rewriting.
    const scrapedTitle = og.title && !isPlaceholderTitle(og.title, link.url) ? og.title : undefined
    if (scrapedTitle) update.title = scrapedTitle
    // The terms stand in as the title until the model improves on them below.
    // Without that floor, a Gemini failure on a search URL leaves the row
    // showing "google.com", when what was typed is the one thing we know.
    else if (searchQuery) update.title = searchQuery
    if (og.description) update.description = og.description
    // A scraped image is copied into our own bucket rather than hot-linked.
    // Hot-linking would have the browser fetch from the retailer's CDN on
    // every render, telling that CDN which item you saved — the same objection
    // `lib/icons.ts` already makes for favicons, and sharper here, because a
    // product image URL identifies the specific thing rather than the shop.
    // A failure here deliberately leaves `image_url` unset so the favicon
    // fallback below takes over; falling back to the hot-link would defeat
    // the point.
    if (og.image && !link.keepImage) {
      const stored = await persistScrapedImage(og.image)
      if (stored) {
        update.image_url = stored
        update.image_kind = 'photo'
      }
    }

    // 2. Gemini. Still the source of tags and the summary, but it only names
    //    the row when the scrape came back with nothing usable — a blocked
    //    site, a bot interstitial, or a bare site name. Then a title inferred
    //    from the URL beats no title at all.
    if (!isGeminiConfigured()) {
      throw new Error('GEMINI_API_KEY is not set')
    }
    const generated = await generateMetadata({
      url: link.url,
      domain: link.domain,
      note: link.note,
      og,
      searchQuery,
    })
    if (generated.clean_title && !scrapedTitle) update.title = generated.clean_title
    if (generated.summary) update.description = generated.summary
    update.tags = generated.tags
    // Guarded rather than assigned outright, unlike `tags`: an empty tag list
    // is a real answer ("nothing in the vocabulary fits"), an empty keyword
    // list never is, so a thin retry mustn't wipe terms that already work.
    if (generated.keywords.length) update.keywords = generated.keywords

    // 3. The watch sub-pipeline. An IMDb link resolved itself by id in 1b;
    //    everything else needs Gemini to have recognised a film or show, and
    //    gets looked up by name.
    if (!movie && generated.tags.includes('watch')) {
      movie = await fetchMovieData(generated.clean_title || og.title || '')
    }
    if (movie) {
      // TMDb's overview is a real synopsis; prefer it over the 20-word summary.
      if (movie.description) update.description = movie.description
      if (movie.imdb_rating) update.imdb_rating = movie.imdb_rating
      if (movie.trailer_url) update.trailer_url = movie.trailer_url
      // Only the by-id path sets a title, and there it's the canonical one —
      // this row *is* that film or show, so it outranks a rephrasing of it.
      if (movie.title) update.title = movie.title
    }

    // No usable photo — most large retailers block scraping entirely, so this
    // is the common case rather than the exception. The brand's own icon is
    // still recognisable at 40px and beats an empty square.
    if (!update.image_url && !link.keepImage) {
      const favicon = await ensureFavicon(link.domain, og.iconHref)
      if (favicon) {
        update.image_url = favicon
        update.image_kind = 'icon'
      }
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

/**
 * The screenshot variant (spec §5.2). There's no page to scrape, so step 1 is
 * a vision call instead of Open Graph — but everything after that is shared,
 * including the watch sub-pipeline. That matters: a screenshot of a film
 * poster reaches exactly the same TMDb and OMDb lookup a pasted IMDb link
 * would, because that chain keys off the `watch` tag and the title, and has no
 * idea where either came from.
 */
export async function enrichScreenshot(input: {
  id: string
  image: Buffer
  mimeType: string
  note: string | null
}): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.error('enrich: Supabase not configured; skipping', input.id)
    return
  }

  const update: Partial<Link> = {}
  const startedAt = Date.now()

  try {
    if (!isGeminiConfigured()) throw new Error('GEMINI_API_KEY is not set')

    const generated = await generateFromImage(input)
    if (generated.clean_title) update.title = generated.clean_title
    if (generated.summary) update.description = generated.summary
    if (generated.extracted_text) update.extracted_text = generated.extracted_text
    update.tags = generated.tags
    if (generated.keywords.length) update.keywords = generated.keywords

    if (generated.tags.includes('watch')) {
      const movie = await fetchMovieData(generated.clean_title)
      if (movie.description) update.description = movie.description
      if (movie.imdb_rating) update.imdb_rating = movie.imdb_rating
      if (movie.trailer_url) update.trailer_url = movie.trailer_url
    }

    await save(input.id, { ...update, enrichment: 'ok', enrich_error: null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`enrich: screenshot failed for ${input.id} after ${Date.now() - startedAt}ms:`, message)
    await save(input.id, {
      ...update,
      enrichment: 'failed',
      enrich_error: message.slice(0, 500),
    })
  }
}

/** A product photo, not a screenshot — generous enough for a retailer's
 *  full-size image, mean enough that an unbounded CDN response is refused. */
const MAX_SCRAPED_IMAGE_BYTES = 2 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/**
 * Copies a scraped image into the private `items` bucket and returns its
 * `storage:` reference, or null if it couldn't be had. `app/page.tsx` swaps
 * that reference for a signed URL at render time, so this needs no cooperation
 * from the components.
 */
async function persistScrapedImage(imageUrl: string): Promise<string | null> {
  const fetched = await fetchImage(imageUrl, MAX_SCRAPED_IMAGE_BYTES)
  if (!fetched) return null

  // The bare type, since a CDN may send "image/jpeg; charset=binary".
  const mimeType = fetched.contentType.split(';')[0].trim().toLowerCase()
  const extension = EXTENSIONS[mimeType]
  if (!extension) return null

  // Content-addressed on the source URL rather than a random id: re-sharing a
  // link re-enriches it (capture upserts on url), and a fresh name per run
  // would leave the previous copy orphaned in the bucket every time.
  const name = createHash('sha256').update(imageUrl).digest('hex').slice(0, 32)

  try {
    return await uploadImage(
      'items',
      `${name}.${extension}`,
      new Blob([fetched.body], { type: mimeType }),
      { upsert: true },
    )
  } catch (error) {
    // Same reasoning as the capture path: losing the thumbnail is not worth
    // losing the enrichment over.
    console.error('enrich: could not store scraped image', imageUrl, error)
    return null
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
