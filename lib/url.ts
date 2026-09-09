/** Parse and validate a shared URL. Returns null for anything that isn't
 *  http(s) — the Shortcut can hand over mailto:, javascript:, app deep links,
 *  or plain text if the share sheet was in an odd state. */
export function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url
}

/** Display domain: no scheme, no leading www. */
export function domainOf(url: URL): string {
  return url.hostname.replace(/^www\./, '')
}

/**
 * Query parameters that hold what someone typed, by search engine. The engines
 * agree on `q` often enough that the exceptions are the whole reason this is a
 * table.
 */
const ENGINE_PARAMS: Array<{ host: RegExp; param: string }> = [
  { host: /(^|\.)google\.[a-z.]+$/, param: 'q' },
  { host: /(^|\.)bing\.com$/, param: 'q' },
  { host: /(^|\.)duckduckgo\.com$/, param: 'q' },
  { host: /(^|\.)ecosia\.org$/, param: 'q' },
  { host: /(^|\.)brave\.com$/, param: 'q' },
  { host: /(^|\.)startpage\.com$/, param: 'query' },
  { host: /(^|\.)yandex\.[a-z.]+$/, param: 'text' },
  { host: /(^|\.)yahoo\.[a-z.]+$/, param: 'p' },
  { host: /(^|\.)baidu\.com$/, param: 'wd' },
]

/** Paths a site's own search lives at, and the parameters those use. Covers
 *  the shops: Amazon is `/s?k=`, Zara `/il/en/search?searchTerm=`, most of the
 *  rest `/search?q=`. Anchored to the end of the path rather than the whole of
 *  it, because a locale prefix in front of it is the norm. */
const SEARCH_PATHS = /(^|\/)(search|s|results|web|catalogsearch\/result)\/?$/
const SEARCH_PARAMS = ['q', 'k', 'query', 'search', 'searchTerm', 'searchterm', 'text', 'keyword']

/** Long enough to be a real query, short enough not to be a pasted paragraph
 *  or an encoded blob that happens to sit in a `q`. */
const MAX_QUERY_LENGTH = 120

/**
 * What the person typed, if this URL is a page of search results.
 *
 * This exists because a search URL is the one case where the page itself is
 * worth nothing and the URL is worth everything: a Google results page scrapes
 * as the bare title "Google Search" with no description and no image, while
 * the terms sitting in `?q=` are precisely what the person was looking for.
 * Handed to the model as the primary signal (see `buildPrompt`), it's the
 * difference between a row called "Google Search" and one called by the name
 * of the book.
 */
export function searchQueryOf(raw: string): string | null {
  const url = parseUrl(raw)
  if (!url) return null

  const host = url.hostname.replace(/^www\./, '')
  const engine = ENGINE_PARAMS.find((candidate) => candidate.host.test(host))
  const params = engine ? [engine.param] : SEARCH_PATHS.test(url.pathname) ? SEARCH_PARAMS : []

  for (const param of params) {
    // No '+' handling needed: URLSearchParams already reads it as a space, and
    // decoding it again would eat the pluses out of a query like "c++".
    const value = url.searchParams.get(param)?.trim()
    if (value && value.length <= MAX_QUERY_LENGTH) return value
  }
  return null
}
