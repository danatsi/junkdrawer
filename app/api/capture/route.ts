import { NextResponse } from 'next/server'
import { saveLink } from '@/lib/capture'

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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const { url, note } = (body ?? {}) as { url?: unknown; note?: unknown }
  const result = await saveLink(url, note)

  return result.ok
    ? NextResponse.json({ id: result.id, saved: true }, { status: 201 })
    : NextResponse.json({ error: result.error }, { status: result.status })
}

/** Constant-time compare so the token can't be recovered by timing the
 *  response. Length is allowed to leak; the contents are not. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
