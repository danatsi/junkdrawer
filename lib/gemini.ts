import 'server-only'
import { GoogleGenAI, Type } from '@google/genai'
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
}

/** Overridable without a code change, since Gemini's model names move faster
 *  than this app will. */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

const TIMEOUT_MS = 15_000

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

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

let client: GoogleGenAI | null = null

function getClient(): GoogleGenAI {
  if (client) return client
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Missing required env var: GEMINI_API_KEY')
  client = new GoogleGenAI({ apiKey })
  return client
}

export async function generateMetadata(input: {
  url: string
  domain: string | null
  note: string | null
  og: OgData
}): Promise<GeminiResult> {
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: buildPrompt(input),
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
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
  }

  const coreTags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const freeform = typeof raw.freeform_tag === 'string' ? raw.freeform_tag : ''

  return {
    clean_title: str(raw.clean_title),
    summary: str(raw.summary),
    tags: normaliseTags(coreTags, freeform),
  }
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
