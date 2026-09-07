import type { Link } from './types'

/**
 * Sample rows for designing against, shaped exactly like what Supabase
 * returns. Enabled with MOCK_DATA=1 (`npm run dev:mock`) so a misconfigured
 * production deploy can never silently serve fake links.
 *
 * Covers the cases the layout has to survive: all four tags, titles long
 * enough to wrap, rows with and without notes, a watch row with a score badge
 * and trailer, a freeform tag alongside a core one, a row still awaiting
 * enrichment, a row whose enrichment failed, and a missing thumbnail.
 */

/** Warm-neutral placeholder thumbnails as inline SVG, so the design renders
 *  the same offline and nothing depends on a scraped host being up. */
function thumb(from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="80" height="80" fill="url(#g)"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

/** Portrait placeholder standing in for a saved screenshot. */
function screenshot(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#D9C9A8"/><stop offset="1" stop-color="#B99B6B"/></linearGradient></defs><rect width="360" height="640" fill="url(#g)"/><rect x="40" y="180" width="280" height="14" rx="7" fill="#F1ECE2" opacity="0.75"/><rect x="40" y="214" width="220" height="14" rx="7" fill="#F1ECE2" opacity="0.6"/><rect x="40" y="248" width="250" height="14" rx="7" fill="#F1ECE2" opacity="0.6"/><rect x="40" y="282" width="180" height="14" rx="7" fill="#F1ECE2" opacity="0.45"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

const base = {
  status: 'unread',
  type: 'link',
  enrichment: 'ok',
  enrich_error: null,
  imdb_rating: null,
  trailer_url: null,
  extracted_text: null,
} as const

export const MOCK_LINKS: Link[] = [
  {
    ...base,
    id: '1',
    url: 'https://www.variety.com/the-bear-season-3',
    domain: 'variety.com',
    title: 'The Bear, season 3',
    description:
      "A young chef returns home to run his family's Chicago sandwich shop after a family tragedy.",
    note: 'Her recommendation from Sunday.',
    image_url: thumb('#D9C9A8', '#B99B6B'),
    tags: ['watch', 'drama'],
    imdb_rating: '8.7',
    trailer_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    created_at: daysAgo(0),
  },
  {
    ...base,
    id: '2',
    url: 'https://www.zara.com/wool-overshirt-camel',
    domain: 'zara.com',
    title: 'Wool overshirt, camel',
    description: null,
    note: 'Compare to the Uniqlo one before buying.',
    image_url: thumb('#E0D2BC', '#C4A882'),
    tags: ['shopping', 'outerwear'],
    created_at: daysAgo(1),
  },
  {
    ...base,
    id: '3',
    url: 'https://www.bonappetit.com/recipe/braised-short-rib-polenta',
    domain: 'bonappetit.com',
    title: 'Braised short rib with polenta',
    description: null,
    note: 'For dinner Saturday, start 4hrs ahead.',
    image_url: thumb('#D6C4A0', '#A98A5C'),
    tags: ['recipe'],
    created_at: daysAgo(2),
  },
  {
    ...base,
    id: '4',
    url: 'https://www.newyorker.com/magazine/the-long-quiet-of-the-deep-sea',
    domain: 'newyorker.com',
    title: 'The long quiet of the deep sea',
    description: null,
    // No note and no description: the chevron slot must stay reserved and
    // invisible here so the WhatsApp icon doesn't shift against its neighbours.
    note: null,
    image_url: thumb('#CFC3AE', '#9E8E74'),
    tags: ['read', 'longread'],
    created_at: daysAgo(3),
  },
  {
    ...base,
    id: '5',
    url: 'https://www.imdb.com/title/dune-part-two',
    domain: 'imdb.com',
    title: 'Dune: Part Two',
    description:
      'Paul Atreides unites with the Fremen to seek revenge against the conspirators who destroyed his family.',
    note: null,
    image_url: thumb('#E2D3B4', '#BFA173'),
    tags: ['watch'],
    imdb_rating: '8.5',
    trailer_url: 'https://www.youtube.com/watch?v=Way9Dexny3w',
    created_at: daysAgo(4),
  },
  {
    ...base,
    id: '6',
    url: 'https://www.instagram.com/reel/C8xQz2kNq1p/',
    domain: 'instagram.com',
    // Instagram blocks OG scraping, so the note carried the meaning and Gemini
    // wrote the title from it alone (spec §2.3).
    title: 'Lemon ricotta pasta',
    description: null,
    note: 'The pasta one — ricotta, lemon zest, lots of pepper.',
    image_url: null,
    tags: ['recipe'],
    created_at: daysAgo(5),
  },
  {
    ...base,
    id: '7',
    url: 'https://www.made.com/standing-desk-oak',
    domain: 'made.com',
    // Just captured: enrichment hasn't run, so the domain stands in as the
    // title and renders muted rather than looking broken.
    title: null,
    description: null,
    note: null,
    image_url: null,
    tags: [],
    enrichment: 'pending',
    created_at: daysAgo(6),
  },
  {
    ...base,
    id: '9',
    url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
    domain: 'instagram.com',
    // Enrichment ran and lost. The row is still usable — it just never got a
    // title — and the panel carries the reason plus a retry.
    title: null,
    description: null,
    note: 'the pasta place in lisbon',
    image_url: null,
    tags: [],
    enrichment: 'failed',
    enrich_error: 'Gemini returned an empty response',
    created_at: daysAgo(6),
  },
  {
    ...base,
    id: '8',
    type: 'screenshot',
    url: '',
    domain: null,
    title: 'Lemon ricotta pasta, from a story',
    description:
      'Extracted: "Lemon ricotta pasta — 500g pasta, 250g ricotta, zest of 2 lemons, parmesan, black pepper." Saved from an Instagram story.',
    note: null,
    image_url: screenshot(),
    tags: ['recipe'],
    created_at: daysAgo(2),
  },
]
