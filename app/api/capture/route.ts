import { NextResponse } from 'next/server'
import { saveLink } from '@/lib/capture'

/** The scrape, the Gemini call and the watch chain run inside `after`, which
 *  shares the route's budget — so the ceiling has to cover all three, not just
 *  the insert. */
export const maxDuration = 60

/**
 * POST /api/capture — the iOS Shortcut's endpoint (spec §2.2).
 *
 * Accepts either shape:
 *   application/json      { url, note? }
 *   multipart/form-data   url, note?, image?
 *
 * The multipart form exists so the Shortcut can send a thumbnail it grabbed
 * from the page already rendered on your phone. That's the only reliable way
 * to get a photo of the actual item: the big retailers block server-side
 * scraping, but nothing blocks your own browser.
 *
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

  const contentType = request.headers.get('content-type') ?? ''

  let url: unknown
  let note: unknown
  let image: unknown

  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Malformed multipart body' }, { status: 400 })
    }
    url = form.get('url')
    note = form.get('note')
    image = form.get('image')
  } else {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Body must be JSON or multipart/form-data' }, { status: 400 })
    }
    ;({ url, note } = (body ?? {}) as { url?: unknown; note?: unknown })
  }

  const result = await saveLink(url, note, image)

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
