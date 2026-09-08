import 'server-only'
import { after } from 'next/server'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { enrich, enrichScreenshot } from './enrich'
import { parseUrl, domainOf } from './url'
import { parseClientPage } from './og'
import { uploadImage } from './storage'

/**
 * Saving a link, shared by the two things that can do it: the iOS Shortcut's
 * bearer-authenticated endpoint, and the in-app capture form. Both need
 * identical behaviour — same validation, same upsert, same deferred
 * enrichment — so neither should own the logic.
 */
/** Compressed on-device first, so anything larger is either a bug or not a
 *  screenshot. Also the bucket's own limit, enforced twice on purpose. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024

const ALLOWED_IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png'])

export type CaptureResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string }

/**
 * @param image Optional thumbnail captured on-device by the Shortcut. Large
 *   retailers block server-side scraping outright — Zara serves an Akamai
 *   interstitial, Amazon/Etsy/H&M/Argos return 403 — so the only reliable way
 *   to get a photo of the actual item is to take it from the page already
 *   rendered in your own browser, where there's nothing to block.
 * @param rawPage Optional JSON blob of the page's own og: tags, read by the
 *   Shortcut in that same browser. Cheaper than `image` for the same reason it
 *   is better: it is four short strings rather than a photo, the phone does no
 *   downloading or re-encoding, and the server fetches the picture itself from
 *   a CDN that — unlike the page HTML — does not bot-block.
 */
export async function saveLink(
  rawUrl: unknown,
  rawNote: unknown,
  image?: unknown,
  rawPage?: unknown,
): Promise<CaptureResult> {
  const url = parseUrl(rawUrl)
  if (!url) {
    return { ok: false, status: 400, error: 'Missing or invalid http(s) url' }
  }
  if (!isSupabaseConfigured()) {
    console.error('capture: Supabase env vars missing')
    return { ok: false, status: 500, error: 'Server misconfigured' }
  }

  // The Shortcut sends "" when the note prompt is skipped.
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null
  const href = url.toString()
  const domain = domainOf(url)

  // A supplied image wins outright over anything enrichment could scrape, so
  // it's stored up front and enrichment leaves it alone.
  let imageRef: string | null = null
  if (isUsableImage(image)) {
    try {
      const extension = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg'
      imageRef = await uploadImage('items', `${crypto.randomUUID()}.${extension}`, image)
    } catch (uploadError) {
      // Losing the thumbnail is not worth losing the link over.
      console.error('capture: item image upload failed', uploadError)
    }
  }

  // Upsert on url: re-sharing a link updates the note rather than creating a
  // second row. Re-enrich, since a new note changes the title Gemini produces.
  const { data, error } = await getSupabase()
    .from('links')
    .upsert(
      {
        url: href,
        note,
        domain,
        status: 'unread',
        enrichment: 'pending',
        enrich_error: null,
        ...(imageRef ? { image_url: imageRef, image_kind: 'photo' } : {}),
      },
      { onConflict: 'url' },
    )
    .select('id')
    .single()

  if (error) {
    console.error('capture: insert failed', error)
    return { ok: false, status: 500, error: 'Could not save link' }
  }

  // PLAN §4: the caller's request ends here. `after` is Next 16's supported way
  // to keep working once the response is out — it wraps the platform's
  // waitUntil, so this survives the function returning on Vercel.
  const id = data.id as string
  after(async () => {
    await enrich({
      id,
      url: href,
      note,
      domain,
      keepImage: Boolean(imageRef),
      page: parseClientPage(rawPage, href),
    })
  })

  return { ok: true, id }
}

function isUsableImage(value: unknown): value is File {
  return (
    value instanceof File &&
    value.size > 0 &&
    value.size <= MAX_SCREENSHOT_BYTES &&
    ALLOWED_IMAGE_TYPES.has(value.type)
  )
}

/**
 * Saving a screenshot (spec §5.4). Same shape as saveLink: store, return, and
 * let enrichment catch up afterwards.
 *
 * `url` holds a synthetic identifier rather than a link. The column is `not
 * null` with a unique index that the link upsert depends on, and a screenshot
 * has no address of its own — so it gets one that is obviously not a URL, and
 * `displayTitle` knows never to show it.
 */
export async function saveScreenshot(file: unknown, rawNote: unknown): Promise<CaptureResult> {
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, status: 400, error: 'No image received' }
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return { ok: false, status: 400, error: `Unsupported image type: ${file.type || 'unknown'}` }
  }
  if (file.size > MAX_SCREENSHOT_BYTES) {
    return { ok: false, status: 400, error: 'Image is too large even after compression' }
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, status: 500, error: 'Server misconfigured' }
  }

  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null
  const id = crypto.randomUUID()
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'webp'
  const objectPath = `${id}.${extension}`

  let imageRef: string
  try {
    imageRef = await uploadImage('screenshots', objectPath, file)
  } catch (error) {
    console.error('capture: screenshot upload failed', error)
    return { ok: false, status: 502, error: 'Could not store the image' }
  }

  const { data, error } = await getSupabase()
    .from('links')
    .insert({
      url: `screenshot:${id}`,
      note,
      domain: null,
      // A storage reference, not a URL: the bucket is private, so the list
      // signs it at render time (see lib/storage.ts).
      image_url: imageRef,
      image_kind: 'photo',
      type: 'screenshot',
      status: 'unread',
      enrichment: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    console.error('capture: screenshot insert failed', error)
    return { ok: false, status: 500, error: 'Could not save screenshot' }
  }

  const rowId = data.id as string
  const image = Buffer.from(await file.arrayBuffer())
  after(async () => {
    await enrichScreenshot({ id: rowId, image, mimeType: file.type, note })
  })

  return { ok: true, id: rowId }
}
