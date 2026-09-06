import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { parseUrl, domainOf } from '@/lib/url'

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
  const { data, error } = await supabase
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

  return NextResponse.json({ id: data.id, saved: true }, { status: 201 })
}

/** Constant-time compare so the token can't be recovered by timing the
 *  response. Length is allowed to leak; the contents are not. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
