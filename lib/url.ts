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
