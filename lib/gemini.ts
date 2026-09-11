import 'server-only'
import { ApiError, GoogleGenAI, Type, type ContentListUnion } from '@google/genai'
import { normalise } from './search'
import { CORE_TAGS } from './types'
import type { OgData } from './og'

/**
 * Step 3 of the enrichment pipeline (spec §3.3): turn a URL plus whatever the
 * scrape managed to get into a clean title, a one-line summary, and tags.
 *
 * `responseSchema` is doing real work here: it removes malformed JSON as a
 * class of bug, and the enum on `tags` means the model physically cannot
 * invent a fifth core tag (PLAN §7). One freeform tag is allowed, but in its
 * own field so it can never contaminate the four the chip bar renders.
 */
export interface GeminiResult {
  clean_title: string
  summary: string
  tags: string[]
  /** Bilingual search vocabulary — see `SEARCH_TERMS_PROPERTY` and
   *  lib/search.ts. Stored, never displayed. */
  keywords: string[]
  /** Only populated by the image path — OCR'd text from the screenshot. */
  extracted_text?: string
  /** 0-10, or null unless `tags` includes `read` and this is a specific
   *  book — see READ_TASTE_PROFILE. */
  reassurance_score: number | null
}

/**
 * Lite on purpose. This is extraction, not reasoning, and the full flash model
 * spends ~435 thinking tokens per call to title a link — measured at 24-31s a
 * call and enough quota to start returning 429s after a dozen links. The lite
 * model answers the same prompt in 2-5s on ~146 total tokens, with output that
 * was, if anything, better.
 *
 * Overridable, since model names move faster than this app will: 2.5-flash was
 * already closed to new API keys by the time this shipped.
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'

/** The SDK still defaults to v1beta, where the current flash models 404 (with
 *  an empty body, so the failure is silent unless you check the status). Every
 *  model from 3.x on is only served from v1. */
const API_VERSION = 'v1'

/** Generous relative to the ~3s a lite call takes, because the free tier
 *  queues concurrent requests rather than rejecting them — three at once has
 *  been measured pushing well past 15s. Two attempts plus the scrape and the
 *  watch chain still fit inside the route's 60s budget. */
const TIMEOUT_MS = 20_000

/**
 * The languages every row is made findable in. Hebrew and English because
 * that's what gets typed into the search box; a page in either one has to
 * answer to both (see lib/search.ts).
 */
const SEARCH_LANGUAGES = 'Hebrew and English'

/** How many terms to ask for. Enough to cover a category word, its synonyms
 *  and a brand in two languages; few enough that the model stays concrete
 *  instead of padding the list with the whole semantic field. */
const SEARCH_TERMS_TARGET = '8 to 14'

/**
 * The field that makes cross-language search possible at all. Shared by the
 * link, image and re-index paths so all three produce the same vocabulary.
 */
const SEARCH_TERMS_PROPERTY = {
  type: Type.ARRAY,
  description:
    `${SEARCH_TERMS_TARGET} short lowercase words someone might type months later to find ` +
    `this again. Every concept must appear in BOTH ${SEARCH_LANGUAGES}, whatever language the ` +
    'source is in. Include: the generic category word (jeans / מכנסיים), its everyday synonyms ' +
    'and singular and plural forms (pants, trousers, denim, מכנס, ג\'ינס, גינס), the brand or ' +
    'site name, and any distinguishing colour, material, cuisine or genre. ' +
    'Single words or two-word phrases, no sentences, no duplicates.',
  items: { type: Type.STRING },
}

/**
 * The same instruction, in the prompt as well as in the schema description.
 * Saying it twice is not belt-and-braces: asked only through the schema, the
 * lite model answers in the source language alone about half the time, which
 * is precisely the failure this whole feature exists to fix.
 *
 * The label differs because one prompt numbers its rules and the others
 * bullet them.
 */
function searchTermsRule(label: string): string {
  return [
    `${label} ${SEARCH_TERMS_TARGET} lowercase words for finding this later. Every`,
    `   concept must appear in BOTH ${SEARCH_LANGUAGES} — both, even when the source is`,
    "   only in one of them. A Zara page written in English still needs מכנסיים, מכנס,",
    "   ג'ינס and גינס alongside jeans, pants, trousers and denim; a Hebrew recipe needs",
    '   chicken next to עוף. Plain category word first, then everyday synonyms, then the',
    '   brand or site name, then the colour, material, cuisine or genre. Never "link",',
    '   "page", "website", the tag names themselves, or — on a page of search results —',
    '   "search", "query", "results" or the name of the search engine. Terms describe the',
    '   thing, never how it was found.',
  ].join('\n')
}

/**
 * One fixed personal taste profile, used to score `read`-tagged books
 * (single-user app — there is no other reader to profile). There's no
 * external API for "will I like this", the way TMDb/OMDb answer "is this any
 * good" for films, so the model reasons it out from this description instead
 * of a lookup.
 */
const READ_TASTE_PROFILE = [
  'Likes: contemporary, character-driven fiction, especially first-person / close POV; smart, ' +
    'natural romance with believable chemistry and emotional depth; light and funny without being ' +
    'overly sweet or formulaic; messy, real, witty, psychologically nuanced characters; ' +
    'relationship stories with substance beyond will-they-won\'t-they; a warm, enjoyable read that ' +
    'stays warm rather than turning sad, dark, scary or humiliating.',
  'Dislikes: kitschy, cheesy or overly sentimental romance; the polished "American rom-com" feel ' +
    'once it curdles into formula; a narrator who tells you what a character feels instead of ' +
    'letting you experience it; stories that feel contrived, overly cute or emotionally ' +
    'manipulative; fantasy and anything far from realistic contemporary life; sad, scary, ' +
    'humiliating or bleak endings.',
].join('\n')

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    clean_title: {
      type: Type.STRING,
      description:
        'Under 8 words. Sentence case. No site name, no clickbait. ' +
        'Same language and script as the source.',
    },
    summary: {
      type: Type.STRING,
      description: 'Under 20 words, one sentence. Empty string if there is nothing to say.',
    },
    tags: {
      type: Type.ARRAY,
      description: 'Zero or more of the fixed vocabulary. Usually exactly one.',
      items: { type: Type.STRING, enum: [...CORE_TAGS] },
    },
    freeform_tag: {
      type: Type.STRING,
      description:
        'At most one extra specific lowercase tag (e.g. "pasta", "denim", "sci-fi"). ' +
        'Empty string if nothing specific applies.',
    },
    reassurance_score: {
      type: Type.INTEGER,
      description:
        'Only meaningful when tags includes "read" AND this is a specific book (never a ' +
        'store, reading list, or article about books in general) — otherwise always 0. ' +
        'An integer 0 (avoid) to 10 (a lock): how confidently THIS reader, described below, ' +
        'will enjoy THIS particular book. Reason only from the taste profile — never from ' +
        'the book\'s general popularity, star rating or bestseller status.\n' +
        READ_TASTE_PROFILE,
    },
    // Last on purpose: the model has already committed to a title, a summary
    // and a tag by the time it writes these, so the terms describe what it
    // decided the thing is rather than leading that decision.
    search_terms: SEARCH_TERMS_PROPERTY,
  },
  required: ['clean_title', 'summary', 'tags', 'freeform_tag', 'reassurance_score', 'search_terms'],
  propertyOrdering: ['clean_title', 'summary', 'tags', 'freeform_tag', 'reassurance_score', 'search_terms'],
}

/** The image schema adds OCR. Kept separate rather than making extracted_text
 *  optional on the shared schema, so the text path can't be asked for a field
 *  it has no way to fill. */
const IMAGE_RESPONSE_SCHEMA = {
  ...RESPONSE_SCHEMA,
  properties: {
    ...RESPONSE_SCHEMA.properties,
    extracted_text: {
      type: Type.STRING,
      description:
        'Every piece of text visible in the image, verbatim, in reading order. ' +
        'Empty string if the image has no legible text.',
    },
  },
  required: [...RESPONSE_SCHEMA.required, 'extracted_text'],
  propertyOrdering: [...RESPONSE_SCHEMA.propertyOrdering, 'extracted_text'],
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

let client: GoogleGenAI | null = null

function getClient(): GoogleGenAI {
  if (client) return client
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Missing required env var: GEMINI_API_KEY')
  client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } })
  return client
}

/**
 * Transient upstream failures worth a second attempt. The free tier throws
 * 503 "experiencing high demand" often enough to matter — two in a dozen calls
 * while testing — and those come back in under two seconds, so retrying costs
 * almost nothing against the route's budget.
 *
 * A timeout is deliberately not retryable: it has already spent 30s, and a
 * second attempt wouldn't fit alongside the scrape and the watch chain.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRY_BACKOFF_MS = 1_500

export async function generateMetadata(input: {
  url: string
  domain: string | null
  note: string | null
  og: OgData
  /** What the person typed, when the URL is a page of search results. See
   *  `searchQueryOf` — on those pages this is the only real signal there is. */
  searchQuery?: string | null
}): Promise<GeminiResult> {
  return toResult(await withRetry(() => attempt(buildPrompt(input), RESPONSE_SCHEMA)))
}

/**
 * The screenshot path (spec §5.2). Same model, same schema shape plus OCR —
 * Gemini Flash is multimodal, so this is the text pipeline with an image part
 * bolted on rather than a separate service.
 */
export async function generateFromImage(input: {
  image: Buffer
  mimeType: string
  note: string | null
}): Promise<GeminiResult> {
  const contents = [
    {
      parts: [
        { inlineData: { mimeType: input.mimeType, data: input.image.toString('base64') } },
        { text: buildImagePrompt(input.note) },
      ],
    },
  ]
  return toResult(await withRetry(() => attempt(contents, IMAGE_RESPONSE_SCHEMA)))
}

/** Terms only. The re-index path (`/api/reindex`) has a row that was already
 *  enriched before `keywords` existed, and re-running the whole pipeline over
 *  it would re-scrape the page, re-upload the thumbnail and re-hit TMDb to
 *  arrive back at the title it already has. */
const SEARCH_TERMS_SCHEMA = {
  type: Type.OBJECT,
  properties: { search_terms: SEARCH_TERMS_PROPERTY },
  required: ['search_terms'],
}

export async function generateSearchTerms(input: {
  url: string
  domain: string | null
  title: string | null
  description: string | null
  note: string | null
  tags: string[]
  extracted_text: string | null
}): Promise<string[]> {
  const raw = await withRetry(() => attempt(buildSearchTermsPrompt(input), SEARCH_TERMS_SCHEMA))
  return normaliseKeywords(raw.search_terms)
}

function buildSearchTermsPrompt(input: {
  url: string
  domain: string | null
  title: string | null
  description: string | null
  note: string | null
  tags: string[]
  extracted_text: string | null
}): string {
  return [
    'Something is already saved in a personal link drawer. Produce only the',
    'search terms that would find it again.',
    '',
    `url: ${input.url}`,
    input.domain && `domain: ${input.domain}`,
    input.title && `title: ${input.title}`,
    input.description && `summary: ${input.description}`,
    input.note && `the person's own note: "${input.note}"`,
    input.tags.length ? `tags: ${input.tags.join(', ')}` : null,
    // Truncated: a full-page screenshot's OCR can run to thousands of
    // characters, and the first few hundred are what says what it is.
    input.extracted_text && `text in the image: ${input.extracted_text.slice(0, 600)}`,
    '',
    'Rules:',
    searchTermsRule('- search_terms:'),
  ]
    .filter(Boolean)
    .join('\n')
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || !RETRYABLE_STATUS.has(error.status)) throw error
    console.warn(`gemini: ${error.status} from upstream, retrying once`)
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS))
    return run()
  }
}

/** The call itself. Returns the parsed JSON object and nothing more, so the
 *  three callers can each read the fields they asked for. */
async function attempt(contents: ContentListUnion, schema: object): Promise<RawResult> {
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      // Deterministic-ish: this is extraction, not writing.
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  })

  const text = response.text
  if (!text) throw new Error('Gemini returned an empty response')

  // Schema-constrained, so this is well-formed JSON of the right shape — but
  // it's still parsed defensively, since a thrown error here would mark the
  // row `failed` and lose the scrape we already have.
  return JSON.parse(text) as RawResult
}

interface RawResult {
  clean_title?: unknown
  summary?: unknown
  tags?: unknown
  freeform_tag?: unknown
  reassurance_score?: unknown
  search_terms?: unknown
  extracted_text?: unknown
}

function toResult(raw: RawResult): GeminiResult {
  const coreTags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const freeform = typeof raw.freeform_tag === 'string' ? raw.freeform_tag : ''
  const tags = normaliseTags(coreTags, freeform)

  return {
    clean_title: str(raw.clean_title),
    summary: str(raw.summary),
    tags,
    keywords: normaliseKeywords(raw.search_terms),
    extracted_text: str(raw.extracted_text) || undefined,
    // The model is asked for 0 on anything that isn't a book (see
    // READ_TASTE_PROFILE) — that sentinel is only meaningful together with
    // the tag, so it's dropped here rather than trusted on its own.
    reassurance_score: tags.includes('read') ? clampScore(raw.reassurance_score) : null,
  }
}

function clampScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(10, Math.max(0, Math.round(value)))
}

function buildImagePrompt(note: string | null): string {
  return [
    'This is a screenshot someone saved to look at later.',
    'Read it and produce a clean title, a short summary, tags, and its text.',
    '',
    'Rules, in priority order:',
    // This rule is deliberately first and absolute. The note is usually vague
    // about *what* the thing is ("saw this on the tv last night") while being
    // useful about why it was saved, and letting it drive the title produced
    // "Television show recommendation" for a Blade Runner 2049 screenshot —
    // which then found nothing in TMDb. The image knows the title; the note
    // knows the reason.
    '1. If the image shows a film or TV show — a poster, a streaming app, a',
    '   review, a cast list — tag it "watch" and set clean_title to the exact',
    '   title of that film or show and NOTHING else. No description, no',
    '   commentary, no words from the note. It is looked up by that title, so',
    '   "Blade Runner 2049" works and "Television show recommendation" does not.',
    '2. Otherwise, clean_title describes what the screenshot shows, under 8',
    '   words, sentence case.',
    `3. tags: choose from ${CORE_TAGS.join(', ')}. Usually exactly one. Omit rather than guess.`,
    '4. freeform_tag: at most one specific lowercase word for what this is.',
    '5. reassurance_score: only if tags includes "read" and the image shows a',
    '   specific book (a cover, a listing, a page of one) — otherwise 0.',
    '   ' + READ_TASTE_PROFILE.replace(/\n/g, '\n   '),
    '6. summary: under 20 words describing what the screenshot shows.',
    '7. extracted_text: every legible piece of text, verbatim, in reading order.',
    searchTermsRule('8. search_terms:'),
    '9. Write clean_title and summary in the language and script of the text in',
    '   the image. Never transliterate it into Latin letters.',
    '10. Never refuse. If the image is unclear, describe what you can see.',
    note
      ? `\nThe person's own note: "${note}"\n` +
        'Use it for the summary and the tags — it says why this was worth saving. ' +
        'It must not change clean_title when rule 1 applies.'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}


function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Core tags first (the chip bar's order is meaningful), freeform last, no
 *  duplicates, nothing empty. */
export function normaliseTags(coreTags: string[], freeform: string): string[] {
  const core = CORE_TAGS.filter((tag) => coreTags.includes(tag))
  const extra = freeform
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9- ]/g, '')
    .trim()
  const out: string[] = [...core]
  if (extra && !out.includes(extra)) out.push(extra)
  return out
}

/** Enough to hold both languages' worth of terms for a rich page, with a
 *  ceiling so a model that decides to enumerate the dictionary can't turn one
 *  row into a substring match for everything. */
const MAX_KEYWORDS = 24
const MAX_KEYWORD_LENGTH = 40

/**
 * Lowercased, de-duplicated and bounded. Duplicates are collapsed on their
 * search-normalised form, so ג'ינס and גינס — which the prompt deliberately
 * asks for both of — count as one term and only one survives; that costs
 * nothing, because `lib/search.ts` normalises the query the same way and
 * matches either spelling against whichever one was kept.
 */
export function normaliseKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const term = item.trim().toLowerCase().slice(0, MAX_KEYWORD_LENGTH)
    // Anything with no letter or digit in it can't be typed at, so it's noise.
    if (!/[\p{L}\p{N}]/u.test(term)) continue
    const key = normalise(term)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length === MAX_KEYWORDS) break
  }
  return out
}

function buildPrompt({
  url,
  domain,
  note,
  og,
  searchQuery,
}: {
  url: string
  domain: string | null
  note: string | null
  og: OgData
  searchQuery?: string | null
}): string {
  const scraped = [
    og.title && `page title: ${og.title}`,
    og.description && `page description: ${og.description}`,
  ]
    .filter(Boolean)
    .join('\n')

  return [
    'You are cataloguing a link someone saved to read or act on later.',
    'Produce a clean title, a short summary, and tags.',
    '',
    `url: ${url}`,
    domain && `domain: ${domain}`,
    scraped || 'scraped page data: none — the site blocked it or has no metadata',
    // A results page is the one case where the page is worth nothing and the
    // URL is worth everything: what scrapes is "Google Search" with no
    // description and no image, while the terms in ?q= are the actual subject.
    // Left to itself the model titles the row after the search engine, which
    // is how a search for a book was saved as "Google Search".
    searchQuery
      ? `\nthis is a page of SEARCH RESULTS. the person searched for: "${searchQuery}"\n` +
        'Those words are the subject of this row. Work out what they were looking for and ' +
        'name it: if they name a book, film, product, place or person, use that name as ' +
        'clean_title. Never add specifics the query does not support — if the words are all ' +
        'there is, the title is the words, tidied.\n' +
        'Nothing in this row may describe the search itself. Not the title, not the summary, ' +
        'not the tags, not the search terms: no "search", no "results", no "query", no ' +
        'search engine name. The summary says what the thing is, or what kind of thing it ' +
        'appears to be, and is empty rather than saying that results were searched for. If ' +
        'the query is too vague to tell what was meant, leave the summary empty — a glossed ' +
        'explanation of the words is worse than nothing — and let search_terms be the ' +
        'query\'s own words plus their direct translation, nothing inferred. "dolly all the ' +
        'time" is not enough to know whether that is a person or a doll, and terms guessed ' +
        'from the wrong reading make the row answer to searches it has nothing to do with.'
      : '',
    // Spec §3.3: the note beats the page text, because it records why the
    // person actually saved the thing.
    note
      ? `\nthe person's own note: "${note}"\n` +
        'The note is the PRIMARY signal. Where it conflicts with the page data, ' +
        'follow the note — it records their intent.'
      : '',
    '',
    'Rules:',
    `- tags: choose from ${CORE_TAGS.join(', ')}. Usually exactly one. Omit rather than guess.`,
    '- freeform_tag: at most one specific lowercase word for what this actually is.',
    '- reassurance_score: only if tags includes "read" and this is a specific book (never a ' +
      'store, reading list, or article about books in general) — otherwise 0.\n' +
      READ_TASTE_PROFILE,
    searchTermsRule('- search_terms:'),
    '- clean_title: under 8 words, sentence case, no site name or marketing padding.',
    '- summary: under 20 words, one sentence, plain and factual.',
    // A Hebrew book page came back titled "achi lo eshet hayil". Latin letters
    // are the model's default for everything, and a transliteration is
    // unreadable to someone who reads the script it came from.
    '- Write clean_title and summary in the language and script of the page itself.',
    '  Never transliterate or translate Hebrew, Arabic, Cyrillic or CJK into Latin letters.',
    // Refusing is the one genuinely useless outcome: a row with no title at
    // all is worse than a row titled from its own URL.
    '- If the scraped data is thin or missing, infer from the URL path and domain.',
    '  Never refuse and never say you lack information — make your best inference.',
  ]
    .filter(Boolean)
    .join('\n')
}
