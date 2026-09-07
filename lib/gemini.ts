import 'server-only'
import { ApiError, GoogleGenAI, Type, type ContentListUnion } from '@google/genai'
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
  /** Only populated by the image path — OCR'd text from the screenshot. */
  extracted_text?: string
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

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    clean_title: {
      type: Type.STRING,
      description: 'Under 8 words. Sentence case. No site name, no clickbait.',
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
  },
  required: ['clean_title', 'summary', 'tags', 'freeform_tag'],
  propertyOrdering: ['clean_title', 'summary', 'tags', 'freeform_tag'],
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
}): Promise<GeminiResult> {
  return withRetry(() => attempt(buildPrompt(input), RESPONSE_SCHEMA))
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
  return withRetry(() => attempt(contents, IMAGE_RESPONSE_SCHEMA))
}

async function withRetry(run: () => Promise<GeminiResult>): Promise<GeminiResult> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || !RETRYABLE_STATUS.has(error.status)) throw error
    console.warn(`gemini: ${error.status} from upstream, retrying once`)
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS))
    return run()
  }
}

async function attempt(contents: ContentListUnion, schema: object): Promise<GeminiResult> {
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
  const raw = JSON.parse(text) as {
    clean_title?: unknown
    summary?: unknown
    tags?: unknown
    freeform_tag?: unknown
    extracted_text?: unknown
  }

  const coreTags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const freeform = typeof raw.freeform_tag === 'string' ? raw.freeform_tag : ''

  return {
    clean_title: str(raw.clean_title),
    summary: str(raw.summary),
    tags: normaliseTags(coreTags, freeform),
    extracted_text: str(raw.extracted_text) || undefined,
  }
}

function buildImagePrompt(note: string | null): string {
  return [
    'This is a screenshot someone saved to look at later.',
    'Read it and produce a clean title, a short summary, tags, and its text.',
    note
      ? `\nthe person's own note: "${note}"\n` +
        'The note is the PRIMARY signal for what matters about this image.'
      : '',
    '',
    'Rules:',
    `- tags: choose from ${CORE_TAGS.join(', ')}. Usually exactly one. Omit rather than guess.`,
    // The whole point of the watch tag here: a screenshot of a film poster or
    // a streaming app should reach the same TMDb lookup a pasted link would.
    '- If the image shows a film or TV show — a poster, a streaming app, a',
    '  review, a cast list — tag it "watch" and make clean_title the exact',
    '  title of that film or show, nothing else. It gets looked up by name.',
    '- freeform_tag: at most one specific lowercase word for what this is.',
    '- clean_title: under 8 words, sentence case.',
    '- summary: under 20 words describing what the screenshot shows.',
    '- extracted_text: every legible piece of text, verbatim, in reading order.',
    '- Never refuse. If the image is unclear, describe what you can see.',
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

function buildPrompt({
  url,
  domain,
  note,
  og,
}: {
  url: string
  domain: string | null
  note: string | null
  og: OgData
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
    '- clean_title: under 8 words, sentence case, no site name or marketing padding.',
    '- summary: under 20 words, one sentence, plain and factual.',
    // Refusing is the one genuinely useless outcome: a row with no title at
    // all is worse than a row titled from its own URL.
    '- If the scraped data is thin or missing, infer from the URL path and domain.',
    '  Never refuse and never say you lack information — make your best inference.',
  ]
    .filter(Boolean)
    .join('\n')
}
