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
 *   application/json      { url, note?, page? }
 *   multipart/form-data   url, note?, image?, page?
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
  /** JSON string of the page's own og: tags, read on-device. See
   *  `parseClientPage`. */
  let page: unknown

  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch (parseError) {
      // Reached when the runtime cannot parse the body at all, so there are no
      // fields to describe -- only the exception says anything. Shortcuts can
      // emit a multipart body the parser rejects when a form field is bound to
      // an empty or list-valued variable, and without this the request looks
      // identical to a missing url.
      console.warn(
        'capture: multipart parse failed:',
        parseError instanceof Error ? parseError.message : String(parseError),
        JSON.stringify({ contentType, length: request.headers.get('content-length') ?? 'unset' }),
      )
      return NextResponse.json({ error: 'Malformed multipart body' }, { status: 400 })
    }
    url = form.get('url')
    note = form.get('note')
    image = form.get('image')
    page = form.get('page')
  } else {
    let body: unknown
    try {
      body = await request.json()
    } catch (parseError) {
      console.warn(
        'capture: body parse failed:',
        parseError instanceof Error ? parseError.message : String(parseError),
        JSON.stringify({ contentType, length: request.headers.get('content-length') ?? 'unset' }),
      )
      return NextResponse.json({ error: 'Body must be JSON or multipart/form-data' }, { status: 400 })
    }
    ;({ url, note, page } = (body ?? {}) as {
      url?: unknown
      note?: unknown
      page?: unknown
    })
    // JSON callers may send the object inline rather than as a string.
    if (page && typeof page === 'object') page = JSON.stringify(page)
  }

  const result = await saveLink(url, note, image, page)

  if (!result.ok) {
    // A rejected capture is otherwise invisible. The Shortcut shows nothing on
    // failure, and the platform log records only the status, so a 400 from a
    // phone is undebuggable without this. Shapes and lengths, never values —
    // and never headers, which carry the token.
    console.warn(
      'capture rejected:',
      result.error,
      JSON.stringify({
        contentType: contentType.split(';')[0] || 'none',
        url: describe(url),
        note: describe(note),
        page: describe(page),
        image: describe(image),
      }),
    )
  }

  return result.ok
    ? NextResponse.json({ id: result.id, saved: true }, { status: 201 })
    : NextResponse.json({ error: result.error }, { status: result.status })
}

/** What arrived in a field, without saying what it said. A URL is the one
 *  exception: it is the thing most likely to be malformed, it is already in
 *  the row, and knowing it is a Safari page object rather than a string is
 *  the whole diagnosis. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return 'absent'
  if (typeof value === 'string') return value === '' ? 'empty string' : `string(${value.length})`
  if (value instanceof File) return `file(${value.type || 'no type'}, ${value.size}b)`
  return typeof value
}

/** Constant-time compare so the token can't be recovered by timing the
 *  response. Length is allowed to leak; the contents are not. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
