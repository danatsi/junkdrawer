import 'server-only'
import { parse } from 'node-html-parser'

/**
 * Step 1 of the enrichment pipeline (spec §3.3): a plain HTTP fetch and four
 * meta tags. No API, no key, no cost.
 *
 * Every failure mode here is expected rather than exceptional — sites block
 * datacentre IPs, return PDFs, hang, or ship no Open Graph tags at all. All of
 * those return empty data instead of throwing, because Gemini can still infer
 * a decent title from the URL alone (spec §3.3 step 3) and the row is already
 * live and usable either way.
 */
export interface OgData {
  title?: string
  description?: string
  image?: string
}

/** Long enough for a slow CDN, short enough that the watch sub-pipeline still
 *  fits inside the route's budget. */
const TIMEOUT_MS = 5_000

/** Some sites stream megabytes of markup. The meta tags are in <head>, so
 *  there's no reason to buffer more than the start of the document. */
const MAX_BYTES = 512 * 1024

/** A real browser UA. Plenty of sites serve a bot page (or a 403) to anything
 *  that looks automated, and the goal here is the same HTML a person sees. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export async function fetchOpenGraph(url: string): Promise<OgData> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
  } catch {
    // Timeout, DNS failure, refused connection, bad TLS.
    return {}
  }

  if (!response.ok) return {}

  // A PDF or an image would parse into meaningless soup.
  const contentType = response.headers.get('content-type') ?? ''
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return {}

  let html: string
  try {
    html = await readCapped(response)
  } catch {
    return {}
  }

  return parseOpenGraph(html, response.url || url)
}

/** Exported for its own sake: parsing is the part worth testing without a
 *  network round-trip. */
export function parseOpenGraph(html: string, baseUrl: string): OgData {
  const root = parse(html)

  const meta = new Map<string, string>()
  for (const el of root.querySelectorAll('meta')) {
    // og:* uses `property`, twitter:* and description use `name`.
    const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').toLowerCase()
    const value = el.getAttribute('content')?.trim()
    if (key && value && !meta.has(key)) meta.set(key, value)
  }

  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find(Boolean)

  const title = pick('og:title', 'twitter:title') ?? root.querySelector('title')?.text?.trim()
  const description = pick('og:description', 'twitter:description', 'description')
  const image = pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image')

  return {
    title: clean(title),
    description: clean(description),
    // og:image is often a site-relative path.
    image: image ? absolute(image, baseUrl) : undefined,
  }
}

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined
  // Scraped titles are full of collapsed whitespace and stray entities.
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed ? collapsed.slice(0, 500) : undefined
}

function absolute(image: string, baseUrl: string): string | undefined {
  try {
    const resolved = new URL(image, baseUrl)
    // A data: or javascript: image is not something the browser should be
    // asked to load from a row.
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : undefined
  } catch {
    return undefined
  }
}

/** Reads at most MAX_BYTES of the body, so a hostile or merely enormous page
 *  can't be buffered in full. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, total))
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    const room = total - offset
    if (room <= 0) break
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    out.set(slice, offset)
    offset += slice.length
  }
  return out
}
