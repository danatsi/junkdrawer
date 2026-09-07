import { NextResponse, after } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { parseUrl, domainOf } from '@/lib/url'
import { enrich } from '@/lib/enrich'

/** The scrape, the Gemini call and the watch chain run inside `after`, which
 *  shares the route's budget — so the ceiling has to cover all three, not just
 *  the insert. */
export const maxDuration = 60

/**
 * POST /api/capture — the iOS Shortcut's endpoint (spec §2.2).
 *
 * Body: { url: string, note?: string }
 * Auth: Authorization: Bearer <CAPTURE_TOKEN>
 *
 * Returns as soon as the row is stored. Enrichment runs afterwards and the
 * row is usable (domain as a stand-in title) until it finishes, so the
 * Shortcut never waits on a scrape or an LLM call.
 */
export async function POST(request: Request) {
  const expected = process.env.CAPTURE_TOKEN
  if (!expected) {
    console.error('CAPTURE_TOKEN is not set; refusing all captures')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!provided || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isSupabaseConfigured()) {
    console.error('Supabase env vars missing; cannot store captures')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const { url: rawUrl, note: rawNote } = (body ?? {}) as { url?: unknown; note?: unknown }
  const url = parseUrl(rawUrl)
  if (!url) {
    return NextResponse.json({ error: 'Missing or invalid http(s) url' }, { status: 400 })
  }

  // The Shortcut sends "" when the note prompt is skipped.
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null

  // Upsert on url: re-sharing a link updates the note rather than creating a
  // second row. Re-enrich, since a new note changes the title Gemini produces.
  const { data, error } = await getSupabase()
    .from('links')
    .upsert(
      {
        url: url.toString(),
        note,
        domain: domainOf(url),
        status: 'unread',
        enrichment: 'pending',
        enrich_error: null,
      },
      { onConflict: 'url' },
    )
    .select('id')
    .single()

  if (error) {
    console.error('capture: insert failed', error)
    return NextResponse.json({ error: 'Could not save link' }, { status: 500 })
  }

  // PLAN §4: the Shortcut's request ends here. `after` is Next 16's supported
  // way to keep working once the response is out — it wraps the platform's
  // waitUntil, so this survives the function returning on Vercel.
  const id = data.id as string
  after(async () => {
    await enrich({ id, url: url.toString(), note, domain: domainOf(url) })
  })

  return NextResponse.json({ id, saved: true }, { status: 201 })
}

/** Constant-time compare so the token can't be recovered by timing the
 *  response. Length is allowed to leak; the contents are not. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
