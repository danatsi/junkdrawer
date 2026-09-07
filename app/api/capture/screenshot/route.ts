import { NextResponse } from 'next/server'
import { saveScreenshot } from '@/lib/capture'

/** Upload, vision call and the watch chain all run inside `after`, which
 *  shares this route's budget. */
export const maxDuration = 60

/**
 * POST /api/capture/screenshot — the image counterpart of /api/capture
 * (spec §5.4), for the iOS Shortcut's image share path.
 *
 * Body: multipart/form-data with `image` (and optional `note`)
 * Auth: Authorization: Bearer <CAPTURE_TOKEN>
 *
 * Expects an already-compressed image. The browser form shrinks it before
 * upload and the Shortcut should too — a raw 4MB iPhone PNG is rejected by the
 * size limit rather than quietly filling the bucket.
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

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Body must be multipart/form-data' }, { status: 400 })
  }

  const result = await saveScreenshot(form.get('image'), form.get('note'))
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
