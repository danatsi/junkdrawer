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
 *
 * Also the mixed-script cases, which are easy to break and impossible to spot
 * without them in the list: Hebrew titles that have to lay out right-to-left
 * off their own first strong character, a Hebrew title with Latin runs inside
 * it, and a Hebrew screenshot. And an `icon` row, which must show the derived
 * monogram tile rather than the favicon it stores.
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

/** Portrait, and in a colour no other placeholder uses, so a row wearing a
 *  poster is obviously not wearing its own screenshot. */
function poster(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3D5A80"/><stop offset="1" stop-color="#16222E"/></linearGradient></defs><rect width="342" height="513" fill="url(#g)"/><rect x="34" y="380" width="200" height="18" rx="9" fill="#F1ECE2" opacity="0.85"/><rect x="34" y="416" width="130" height="14" rx="7" fill="#F1ECE2" opacity="0.55"/></svg>`
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
  poster_url: null,
  reassurance_score: null,
  reassurance_reason: null,
  extracted_text: null,
  image_kind: null,
  keywords: [] as string[],
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
    image_kind: 'photo' as const, image_url: thumb('#D9C9A8', '#B99B6B'),
    tags: ['watch', 'drama'],
    keywords: [
      'the bear',
      'הדוב',
      'series',
      'סדרה',
      'chef',
      'שף',
      'kitchen',
      'מטבח',
      'drama',
      'דרמה',
    ],
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
    image_kind: 'photo' as const, image_url: thumb('#E0D2BC', '#C4A882'),
    tags: ['shopping', 'outerwear'],
    keywords: [
      'overshirt',
      'חולצת מעל',
      'shirt',
      'חולצה',
      'jacket',
      'ג\'קט',
      'wool',
      'צמר',
      'camel',
      'קאמל',
      'zara',
      'זארה',
      'outerwear',
      'מעיל',
    ],
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
    image_kind: 'photo' as const, image_url: thumb('#D6C4A0', '#A98A5C'),
    tags: ['recipe'],
    keywords: [
      'short rib',
      'צלעות',
      'beef',
      'בקר',
      'polenta',
      'פולנטה',
      'braised',
      'מבושל',
      'recipe',
      'מתכון',
      'dinner',
      'ארוחת ערב',
    ],
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
    image_kind: 'photo' as const, image_url: thumb('#CFC3AE', '#9E8E74'),
    tags: ['read', 'longread'],
    keywords: [
      'deep sea',
      'מעמקי הים',
      'ocean',
      'אוקיינוס',
      'article',
      'כתבה',
      'longread',
      'קריאה ארוכה',
      'new yorker',
      'ניו יורקר',
    ],
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
    image_kind: 'photo' as const, image_url: thumb('#E2D3B4', '#BFA173'),
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
    id: '10',
    url: 'https://e-vrit.co.il/product/hachi-lo-eshet-chayil',
    domain: 'e-vrit.co.il',
    // The row this whole change exists for. The page title was
    // "הכי לא אשת חיל - סופי קינסלה | עברית - חנות ספרים"; og.ts cuts the site
    // chrome off the end and the author survives. Handing it to the model
    // instead is what used to return "achi lo eshet hayil".
    title: 'הכי לא אשת חיל - סופי קינסלה',
    description: 'רומן קומי על אישה שמנסה להיות מושלמת בכל החזיתות ונכשלת בכולן.',
    note: 'אמא המליצה. לקנות לפני הטיסה.',
    image_kind: 'photo' as const, image_url: thumb('#DCCDB2', '#B59A6E'),
    tags: ['read'],
    // Contemporary, funny, first-person romantic comedy — squarely the sweet
    // spot the taste profile in lib/gemini.ts describes. The reason carries a
    // reservation, which is the case worth designing the panel against: the
    // sentence has to be able to argue with its own number.
    reassurance_score: 8,
    reassurance_reason:
      'First-person, genuinely funny about a woman falling apart, though Kinsella tips into farce where you want the feelings to stay real.',
    created_at: daysAgo(1),
    keywords: [
      'book',
      'ספר',
      'novel',
      'רומן',
      'sophie kinsella',
      'סופי קינסלה',
      'comedy',
      'קומדיה',
      'ebook',
      'ספר דיגיטלי',
    ],
  },
  {
    ...base,
    id: '11',
    url: 'https://www.foodish.co.il/recipe/challah',
    domain: 'foodish.co.il',
    // Latin runs inside a Hebrew title. dir="auto" keys off the first strong
    // character, so the line stays right-to-left and "180C" sits where it
    // belongs instead of jumping to the far end.
    title: 'חלה מתוקה של שישי - 180C, 40 דקות',
    description: null,
    note: 'להכפיל את הכמות, יוצא קטן מדי.',
    image_kind: 'photo' as const, image_url: thumb('#E3D6BB', '#C0A578'),
    tags: ['recipe'],
    created_at: daysAgo(3),
  },
  {
    ...base,
    id: '14',
    url: 'https://www.zara.com/il/en/wide-leg-high-waist-jeans-p05585045.html',
    domain: 'zara.com',
    // The row the bilingual keywords exist for: nothing on this page is in
    // Hebrew, and it still has to come back for מכנס, מכנסיים, גינס and
    // ג'ינס. `keywords` is the only field here that can answer any of them.
    title: 'Wide leg high waist jeans',
    description: null,
    note: 'Size 38, wait for the sale.',
    image_kind: 'photo' as const, image_url: thumb('#CBBFA8', '#8E7C5E'),
    tags: ['shopping', 'denim'],
    keywords: [
      'jeans',
      "ג'ינס",
      'גינס',
      'pants',
      'מכנסיים',
      'מכנס',
      'trousers',
      'denim',
      'דנים',
      'wide leg',
      'גזרה רחבה',
      'zara',
      'זארה',
    ],
    created_at: daysAgo(0),
  },
  {
    ...base,
    id: '15',
    url: 'https://www.castro.com/he/p/t-shirt-oversize-white',
    domain: 'castro.com',
    // The other half of the same case, mirrored: a Hebrew page that has to
    // answer to "tshirt" and "shirt".
    title: 'טי שירט אוברסייז לבנה',
    description: null,
    note: null,
    image_kind: 'photo' as const, image_url: thumb('#E6DCC7', '#B5A489'),
    tags: ['shopping', 'basics'],
    keywords: [
      'tshirt',
      't-shirt',
      'shirt',
      'חולצה',
      'חולצות',
      'טי שירט',
      'top',
      'טופ',
      'oversize',
      'אוברסייז',
      'white',
      'לבן',
      'castro',
      'קסטרו',
    ],
    created_at: daysAgo(1),
  },
  {
    ...base,
    id: '12',
    url: 'https://www.ikea.com/il/he/p/billy-bookcase',
    domain: 'ikea.com',
    // Nothing scraped but a favicon. image_kind 'icon' is stored and ignored:
    // the row renders the monogram tile, so its left edge matches every other
    // row instead of holding a 40px logo.
    title: 'BILLY ספריה, לבן',
    description: null,
    note: null,
    image_kind: 'icon' as const,
    image_url: 'https://www.ikea.com/favicon.ico',
    tags: ['shopping'],
    created_at: daysAgo(4),
    keywords: [
      'bookcase',
      'ספריה',
      'shelf',
      'מדף',
      'shelves',
      'מדפים',
      'billy',
      'בילי',
      'ikea',
      'איקאה',
      'furniture',
      'רהיטים',
      'white',
      'לבן',
    ],
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
    image_kind: 'photo' as const, image_url: screenshot(),
    tags: ['recipe'],
    keywords: [
      'pasta',
      'פסטה',
      'ricotta',
      'ריקוטה',
      'lemon',
      'לימון',
      'recipe',
      'מתכון',
      'instagram',
      'אינסטגרם',
    ],
    created_at: daysAgo(2),
  },
  {
    ...base,
    id: '16',
    type: 'screenshot',
    url: '',
    domain: null,
    // The row this whole change exists for. What was saved is a photograph of
    // a streaming app, which at 44px is an unreadable smear indistinguishable
    // from every other screenshot in the list. Enrichment recognised the show,
    // so the row wears the show's poster and its IMDb rating and files itself
    // under watch — while `image_url` still holds the screenshot, which is
    // what the panel and the full-screen viewer show.
    title: 'Slow Horses',
    description:
      'A dysfunctional team of MI5 agents exiled to Slough House for their career-ending mistakes.',
    note: null,
    image_kind: 'photo' as const,
    image_url: screenshot(),
    poster_url: poster(),
    tags: ['watch'],
    imdb_rating: '8.3',
    trailer_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    extracted_text: 'Slow Horses\nSeason 4\nApple TV+\n6 episodes',
    keywords: [
      'slow horses',
      'סלואו הורסס',
      'series',
      'סדרה',
      'spy',
      'ריגול',
      'mi5',
      'apple tv',
      'thriller',
      'מותחן',
    ],
    created_at: daysAgo(1),
  },
  {
    ...base,
    id: '13',
    type: 'screenshot',
    url: '',
    domain: null,
    // A screenshot whose OCR came back in Hebrew. Its title and panel text run
    // through the same dir="auto" as the link rows.
    title: 'שעות פתיחה - המעבדה',
    description: 'צילום מסך של שעות הפתיחה: ראשון עד חמישי, 09:00-18:00, שישי עד 14:00.',
    note: null,
    image_kind: 'photo' as const, image_url: screenshot(),
    tags: ['read'],
    extracted_text: 'המעבדה\nראשון-חמישי 09:00-18:00\nשישי 09:00-14:00',
    keywords: [
      'opening hours',
      'שעות פתיחה',
      'hamaabada',
      'המעבדה',
      'venue',
      'מקום',
      'schedule',
      'לוח זמנים',
    ],
    created_at: daysAgo(5),
  },
]
