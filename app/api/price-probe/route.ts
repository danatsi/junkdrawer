import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { fetchPage } from '@/lib/og'
import { extractPrice, looksLikeInterstitial } from '@/lib/price'

export const maxDuration = 60

/** Each probe is one fetch of at most 512KB, so this fits a good few. */
const TIME_BUDGET_MS = 40_000

/** Enough rows to see the shape of the problem without spending a minute. */
const DEFAULT_LIMIT = 12

/**
 * GET /api/price-probe — can we actually read a price off these pages?
 *
 * A diagnostic, not a feature, and it exists because the alternative was
 * designing around a comment. `lib/og.ts` says large retailers answer a
 * server-side fetch with an interstitial or a 403, which was observed while
 * building the Shortcut metadata path and was about `og:title` — it has never
 * been checked for price, and it may not still be true.
 *
 * It has to run *here* rather than from a laptop or an agent's sandbox,
 * because bot-blocking is decided by the requesting IP and ASN. The only
 * measurement that predicts what a scheduled refresh would get is one taken
 * from the machine that would be doing the refreshing.
 *
 * Reports, per row: what came back, whether the body is a real page or a wall,
 * and whether a price was extractable and by which of the three methods. That
 * distinguishes the three outcomes that a bare failure conflates —
 * blocked, readable-but-unmarked, and readable-and-fine.
 *
 *   GET /api/price-probe                 the newest shopping rows
 *   GET /api/price-probe?limit=30        more of them
 *   GET /api/price-probe?url=https://…   one page, without saving anything
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const one = params.get('url')

  if (one) {
    return NextResponse.json({ results: [await probe(one, null)] })
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const limit = Math.min(Number(params.get('limit')) || DEFAULT_LIMIT, 60)
  const { data, error } = await getSupabase()
    .from('links')
    .select('id, url, title, domain')
    .eq('status', 'unread')
    .eq('type', 'link')
    .contains('tags', ['shopping'])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('price-probe: could not load rows', error)
    return NextResponse.json({ error: 'Could not load links' }, { status: 500 })
  }

  const rows = (data ?? []) as { id: string; url: string; title: string | null }[]
  const startedAt = Date.now()
  const results = []
  let ranOutOfTime = false

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      ranOutOfTime = true
      break
    }
    results.push(await probe(row.url, row.title))
  }

  // The headline: of the pages we could read at all, how many carry a price.
  const readable = results.filter((r) => r.verdict !== 'blocked' && r.verdict !== 'unreachable')
  return NextResponse.json({
    probed: results.length,
    of: rows.length,
    readable: readable.length,
    priced: results.filter((r) => r.price).length,
    byVerdict: tally(results.map((r) => r.verdict)),
    bySource: tally(results.map((r) => r.price?.source).filter(Boolean) as string[]),
    ranOutOfTime,
    results,
  })
}

type Verdict = 'priced' | 'no-price-markup' | 'blocked' | 'not-html' | 'unreachable'

async function probe(url: string, title: string | null) {
  const page = await fetchPage(url)

  let verdict: Verdict
  let price = null

  if (page.error) {
    verdict = 'unreachable'
  } else if (!page.ok) {
    // 403/429 is a bot wall saying so honestly; anything else non-HTML is its
    // own category so a PDF doesn't get counted as a block.
    verdict = page.contentType && !/text\/html|xhtml/i.test(page.contentType) ? 'not-html' : 'blocked'
  } else if (looksLikeInterstitial(page.html)) {
    verdict = 'blocked'
  } else {
    price = extractPrice(page.html)
    verdict = price ? 'priced' : 'no-price-markup'
  }

  return {
    url,
    title,
    verdict,
    status: page.status,
    contentType: page.contentType.split(';')[0] || null,
    bytes: page.html.length,
    price,
    error: page.error ?? null,
  }
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}
