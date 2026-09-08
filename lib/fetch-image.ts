import 'server-only'

/**
 * A capped, validated image fetch — shared by the two things that pull images
 * off other people's servers: favicon caching (`lib/icons.ts`) and persisting
 * a scraped product photo (`lib/enrich.ts`).
 *
 * Every check here exists because a blocked or hostile site does not fail
 * cleanly. It returns 200 with an HTML interstitial from `/favicon.ico`, or
 * streams far more bytes than it declared, or points at an address that only
 * means something from inside the datacentre. So: the host must be publicly
 * routable, the content type must actually be an image, the body is capped
 * while it streams rather than after, and every failure is a `null` instead of
 * a throw — a row without a thumbnail is still a usable row.
 */

/** Long enough for a slow CDN, short enough to stay inside the enrichment
 *  budget when several of these run in sequence. Spans the whole chase, not
 *  each hop, so a redirect loop can't multiply it. */
const TIMEOUT_MS = 5_000

/** Enough for the http->https and apex->cdn hops that real image URLs take.
 *  Beyond that it isn't serving an image, it's leading somewhere. */
const MAX_REDIRECTS = 3

/** The same real-browser UA `lib/og.ts` sends, for the same reason: plenty of
 *  CDNs serve a bot page to anything that looks automated. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface FetchedImage {
  body: ArrayBuffer
  contentType: string
}

/**
 * Fetches one image, or null if it isn't one, is too big, or doesn't answer.
 *
 * @param maxBytes Hard ceiling. Enforced against `content-length` up front and
 *   again against the actual stream, because a declared length is a claim.
 */
export async function fetchImage(url: string, maxBytes: number): Promise<FetchedImage | null> {
  if (!isFetchableUrl(url)) return null

  try {
    const response = await chaseRedirects(url)
    if (!response || !response.ok) return null

    // A bot-blocked site will happily return an HTML page from an image URL.
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) return null

    // Cheap rejection before reading a byte, when the server is honest.
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return null

    const body = await readCapped(response, maxBytes)
    if (!body || body.byteLength === 0) return null

    return { body, contentType }
  } catch {
    // Timeout, DNS failure, refused connection, bad TLS.
    return null
  }
}

/**
 * Walks redirects by hand, checking every hop against `isFetchableUrl`.
 *
 * `redirect: 'follow'` would check only the URL we started with, and the
 * check is on the one thing an untrusted page controls. A scraped og:image
 * pointing at an attacker's host that answers 302 to 169.254.169.254 would
 * otherwise be followed without a second look, and the metadata response
 * stored in our bucket as a thumbnail. Node returns a real 3xx here rather
 * than the browser's opaque redirect, so the Location is readable.
 */
async function chaseRedirects(url: string): Promise<Response | null> {
  // One deadline for the whole chase, not one per hop.
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let current = url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(current)) return null

    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
    })
    if (response.status < 300 || response.status >= 400) return response

    const location = response.headers.get('location')
    // Nothing will read this body; release the socket rather than leak it.
    await response.body?.cancel().catch(() => {})
    if (!location) return null

    // Relative Locations are legal and common.
    try {
      current = new URL(location, current).href
    } catch {
      return null
    }
  }
  return null
}

/** First candidate that yields a real image. Used where there's a fallback
 *  chain to walk, as favicon lookup has. */
export async function fetchFirstImage(
  candidates: (string | undefined)[],
  maxBytes: number,
): Promise<FetchedImage | null> {
  for (const url of candidates) {
    if (!url) continue
    const found = await fetchImage(url, maxBytes)
    if (found) return found
  }
  return null
}

/**
 * Rejects anything that isn't an http(s) URL aimed at a publicly routable
 * host. The image URL reaching this function came out of a scraped page, so
 * it is only as trustworthy as that page — and a server-side fetch of a
 * caller-influenced URL is the shape of an SSRF. Loopback, link-local (which
 * is where cloud instance metadata lives) and the private ranges are the
 * addresses worth refusing.
 *
 * Deliberately does not resolve DNS: a hostname that *resolves* to a private
 * address still passes. Closing that needs resolve-then-pin, which Node's
 * `fetch` gives no hook for, so this raises the cost of the obvious attempt
 * rather than claiming to be airtight. Redirects, which used to be the bigger
 * hole, are re-checked per hop by `chaseRedirects`.
 */
function isFetchableUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase().replace(/^\[|]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (host === '0.0.0.0') return false

  // IPv6 loopback, link-local and unique-local (fc00::/7). Gated on the host
  // actually being an IPv6 literal: `fc` and `fd` are only meaningful as
  // address prefixes, and tested against a bare hostname they also reject
  // every real domain that happens to start with those two letters —
  // fdny.org, fcbarcelona.com. Only a colon can tell the two apart.
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80:')) return false
    if (host.startsWith('fc') || host.startsWith('fd')) return false
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0) return false
    if (a === 169 && b === 254) return false // instance metadata
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
  }
  return true
}

/**
 * Reads at most `maxBytes`, stopping as soon as the cap is passed. Buffering
 * the whole body and checking its size afterwards would mean a hostile URL
 * could still make us download it in full first.
 */
async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      // Over the cap is a rejection, not a truncation — half a JPEG is worse
      // than no thumbnail.
      if (total > maxBytes) return null
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}
