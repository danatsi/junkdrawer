import { NextResponse } from 'next/server'
import { saveScreenshot } from '@/lib/capture'

/** Upload, vision call and the watch chain all run inside `after`, which
 *  shares this route's budget. */
export const maxDuration = 60

/**
 * POST /api/capture/screenshot — the image counterpart of /api/capture
 * (spec §5.4), for the iOS Shortcut's image share path.
 *
 * Body: either
 *   multipart/form-data   `image` file, optional `note`   (the in-app form)
 *   image/*               the raw bytes, optional `?note=`  (the Shortcut)
 *
 * The second shape exists because Shortcuts cannot reliably put a file in a
 * form field. Its "Form" body renders an image variable to text — the field
 * arrives as a zero-length string and the bytes never leave the phone — while
 * its "File" body sends the image as the whole request. So the Shortcut uses
 * File and the note rides along in the query string.
 *
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

  // Anything that isn't a form is treated as the image itself. The type comes
  // from the bytes rather than the header: the Shortcut's "File" body does not
  // announce `image/jpeg` -- it sent something this route first mistook for a
  // malformed form -- and a header a client controls is worth less here than
  // four bytes it cannot fake.
  const declared = request.headers.get('content-type') ?? ''
  if (!declared.includes('multipart/form-data')) {
    const bytes = await request.arrayBuffer()
    const sniffed = sniffImageType(bytes)
    if (!sniffed) {
      console.warn(
        'screenshot rejected (raw body): unrecognised bytes',
        JSON.stringify({ declared: declared || 'none', bytes: bytes.byteLength, head: head(bytes) }),
      )
      return NextResponse.json({ error: 'Body is not a JPEG, PNG or WebP image' }, { status: 400 })
    }
    const note = new URL(request.url).searchParams.get('note')
    const file = new File([bytes], `screenshot.${sniffed.split('/')[1]}`, { type: sniffed })
    const result = await saveScreenshot(file, note)
    if (!result.ok) {
      console.warn(
        'screenshot rejected (raw body):',
        result.error,
        JSON.stringify({ declared: declared || 'none', sniffed, bytes: bytes.byteLength }),
      )
    }
    return result.ok
      ? NextResponse.json({ id: result.id, saved: true }, { status: 201 })
      : NextResponse.json({ error: result.error }, { status: result.status })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch (parseError) {
    console.warn(
      'screenshot: form parse failed:',
      parseError instanceof Error ? parseError.message : String(parseError),
      request.headers.get('content-type') ?? 'no content-type',
    )
    return NextResponse.json({ error: 'Body must be multipart/form-data' }, { status: 400 })
  }

  const image = form.get('image')
  const result = await saveScreenshot(image, form.get('note'))

  if (!result.ok) {
    // Same reasoning as /api/capture: a rejected share is invisible from the
    // phone, and the platform log carries only the status. The likeliest
    // failure here is the Shortcut sending the image as a *text* form field,
    // which arrives as a string rather than a File and is indistinguishable
    // from an empty upload without this.
    console.warn(
      'screenshot rejected:',
      result.error,
      JSON.stringify({
        image:
          image instanceof File
            ? `file(${image.type || 'no type'}, ${image.size}b, name=${image.name || 'unnamed'})`
            : image === null
              ? 'absent'
              : `${typeof image}(${String(image).length} chars)`,
        fields: [...form.keys()],
      }),
    )
  }

  return result.ok
    ? NextResponse.json({ id: result.id, saved: true }, { status: 201 })
    : NextResponse.json({ error: result.error }, { status: result.status })
}

/**
 * The image formats the bucket accepts, identified by their magic bytes.
 * HEIC is recognised only so the error can say so: iOS hands one over
 * whenever the Shortcut skips its Convert step, and "not an image" would send
 * you looking in the wrong place.
 */
function sniffImageType(buffer: ArrayBuffer): string | null {
  const b = new Uint8Array(buffer)
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  const ascii = (start: number, end: number) => String.fromCharCode(...b.slice(start, end))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** First bytes as hex, for a log line that has to explain an unrecognised
 *  body without quoting someone's picture into it. */
function head(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer).slice(0, 12)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join(' ')
}

/** Constant-time compare so the token can't be recovered by timing the
 *  response. Length is allowed to leak; the contents are not. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
