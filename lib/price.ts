import { parse, type HTMLElement } from 'node-html-parser'

/**
 * Pulling a price out of a product page.
 *
 * Three sources, in descending order of how much they can be trusted, because
 * they're written for descending audiences:
 *
 *  1. **JSON-LD** `Product.offers.price` — written for Google Shopping, which
 *     penalises a shop for getting it wrong, so it's the one number on the page
 *     with an incentive to be correct. Also the only one that reliably carries
 *     its currency.
 *  2. **`product:price:amount` / `og:price:amount` meta** — written for
 *     Facebook's product cards. Common, and usually right.
 *  3. **`itemprop="price"` microdata** — the old schema.org markup, still all
 *     over Israeli shops.
 *
 * Deliberately *not* a fourth source: the largest number that looks like money
 * in the page text. On a product page that lands on a "you might also like"
 * tile, a shipping threshold or an instalment plan about as often as on the
 * actual price, and a confidently wrong price is worse than none — the whole
 * point of the number is to be trusted at a glance.
 *
 * No `server-only` import: the parsing half is worth testing without a network
 * round-trip or a server bundle, and nothing here touches a secret.
 */
export type PriceSource = 'jsonld' | 'meta' | 'microdata'

export interface Price {
  /** Minor units are not used: shops quote 249.90, and a row displays it. */
  amount: number
  /** ISO 4217 where the page said so, else inferred from a symbol. Null when
   *  the page gave a number with nothing to say what it's denominated in — a
   *  bare 249 is not worth showing next to a ₪ that might be a $. */
  currency: string | null
  source: PriceSource
}

export function extractPrice(html: string): Price | null {
  const root = parse(html)
  return fromJsonLd(root) ?? fromMeta(root) ?? fromMicrodata(root)
}

/* --- 1. JSON-LD ---------------------------------------------------------- */

function fromJsonLd(root: HTMLElement): Price | null {
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script.text)
    } catch {
      // Sites ship invalid JSON-LD surprisingly often; skip and try the next.
      continue
    }
    const found = findOffer(parsed, 0)
    if (found) return found
  }
  return null
}

/**
 * Walks the document looking for an offer, rather than matching a shape.
 * Schema.org allows `offers` to be an Offer, an AggregateOffer, an array of
 * either, and the whole Product to be buried under `@graph` — the same
 * polymorphism `findStructuredImage` in og.ts has to cope with.
 */
function findOffer(node: unknown, depth: number): Price | null {
  if (depth > 8 || node == null || typeof node !== 'object') return null

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOffer(item, depth + 1)
      if (found) return found
    }
    return null
  }

  const record = node as Record<string, unknown>

  // An Offer, wherever it turned up. `lowPrice` is what an AggregateOffer
  // carries instead of `price`, and for a garment with per-size offers the
  // lowest is the one the page itself advertises.
  const amount = firstAmount(record.price, record.lowPrice)
  if (amount !== null) {
    const currency = firstCurrency(record.priceCurrency, record.currency)
    return { amount, currency, source: 'jsonld' }
  }

  // `offers` first, so a Product's own offer wins over anything nested deeper
  // in a breadcrumb or a related-items list.
  for (const key of ['offers', 'priceSpecification', '@graph', 'mainEntity', 'itemListElement']) {
    if (key in record) {
      const found = findOffer(record[key], depth + 1)
      if (found) return found
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@') || key === 'offers') continue
    const found = findOffer(value, depth + 1)
    if (found) return found
  }
  return null
}

function firstAmount(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = parseAmount(value)
    if (parsed !== null) return parsed
  }
  return null
}

function firstCurrency(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const code = normaliseCurrency(value)
      if (code) return code
    }
  }
  return null
}

/* --- 2. Meta tags -------------------------------------------------------- */

function fromMeta(root: HTMLElement): Price | null {
  const meta = new Map<string, string>()
  for (const el of root.querySelectorAll('meta')) {
    const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').toLowerCase()
    const value = el.getAttribute('content')?.trim()
    if (key && value && !meta.has(key)) meta.set(key, value)
  }

  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find(Boolean)

  const amount = parseAmount(
    pick('product:price:amount', 'og:price:amount', 'product:price', 'twitter:data1'),
  )
  if (amount === null) return null

  return {
    amount,
    currency: firstCurrency(
      pick('product:price:currency', 'og:price:currency', 'product:currency', 'twitter:label1'),
      // A symbol in the amount itself is better than nothing.
      pick('product:price:amount', 'og:price:amount'),
    ),
    source: 'meta',
  }
}

/* --- 3. Microdata -------------------------------------------------------- */

function fromMicrodata(root: HTMLElement): Price | null {
  for (const el of root.querySelectorAll('[itemprop="price"]')) {
    // `content` is the machine-readable form and is preferred where present;
    // the text is what's left for markup that never had one.
    const amount = parseAmount(el.getAttribute('content') ?? el.text)
    if (amount === null) continue

    const currencyEl = root.querySelector('[itemprop="priceCurrency"]')
    return {
      amount,
      currency: firstCurrency(
        currencyEl?.getAttribute('content') ?? currencyEl?.text,
        el.getAttribute('content') ?? el.text,
      ),
      source: 'microdata',
    }
  }
  return null
}

/* --- Parsing ------------------------------------------------------------- */

const SYMBOLS: [RegExp, string][] = [
  [/₪|ils|nis|שח|ש"ח/i, 'ILS'],
  [/€|eur/i, 'EUR'],
  [/£|gbp/i, 'GBP'],
  [/\$|usd/i, 'USD'],
]

/** A three-letter code as written, or the currency a symbol stands for. */
export function normaliseCurrency(value: string): string | null {
  const trimmed = value.trim()
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase()
  for (const [pattern, code] of SYMBOLS) {
    if (pattern.test(trimmed)) return code
  }
  return null
}

/**
 * A price out of whatever the page wrote it as: `249.90`, `"249,90"`, `1.234,56`,
 * `"₪1,249.00"`, or a bare number.
 *
 * The hard part is that `.` and `,` swap roles between locales, and this app's
 * shops are in both camps — an Israeli site writes `1,249.90` and a German one
 * `1.249,90`. So the *last* separator decides, and only when it's followed by
 * one or two digits; anything else is a thousands separator. `1.234` is one
 * thousand two hundred and thirty four, not one and a bit.
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null

  const digits = value.replace(/[^\d.,]/g, '')
  if (!digits || !/\d/.test(digits)) return null

  const lastComma = digits.lastIndexOf(',')
  const lastDot = digits.lastIndexOf('.')
  const separator = Math.max(lastComma, lastDot)

  let normalised: string
  if (separator === -1) {
    normalised = digits
  } else {
    const fraction = digits.length - separator - 1
    normalised =
      fraction >= 1 && fraction <= 2
        ? digits.slice(0, separator).replace(/[.,]/g, '') + '.' + digits.slice(separator + 1)
        : digits.replace(/[.,]/g, '')
  }

  const amount = Number(normalised)
  // Zero is not a price, and neither is a number so large it's an id that
  // happened to be sitting in a price field.
  return Number.isFinite(amount) && amount > 0 && amount < 10_000_000 ? amount : null
}

/**
 * Whether a 200 response is actually the product page or a wall wearing one's
 * status code. Bot protection usually answers 200 with a few hundred bytes of
 * challenge markup, which is indistinguishable from a real page by status
 * alone — and is the thing that has to be told apart to know whether a price
 * is genuinely unavailable or merely wasn't looked for properly.
 */
export function looksLikeInterstitial(html: string): boolean {
  if (html.length < 1_500) return true
  return /just a moment|checking your browser|enable javascript to|attention required|access denied|px-captcha|_incapsula_|akamai (?:bot manager|reference)|cf-browser-verification|hcaptcha|recaptcha challenge/i.test(
    html.slice(0, 4_000),
  )
}
