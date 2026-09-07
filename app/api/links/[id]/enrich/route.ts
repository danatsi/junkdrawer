import { NextResponse, after } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { enrich, enrichScreenshot } from '@/lib/enrich'
import { downloadImage, parseStorageRef } from '@/lib/storage'

/** Same budget as capture — it runs the same three steps. */
export const maxDuration = 60

/**
 * POST /api/links/[id]/enrich — re-run enrichment for one row (PLAN §4).
 *
 * The way out of a `failed` row: a Gemini outage or a site that was blocking
 * scrapers an hour ago shouldn't need a re-share from the phone. Reachable
 * only behind the site gate, same as the rest of /api/links.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  // Read the row first: enrichment needs the url, note and domain, and this
  // also means a bad id 404s instead of silently queueing work for nothing.
  const { data, error } = await getSupabase()
    .from('links')
    .select('id, url, note, domain, type, image_url')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('enrich: could not load row', id, error)
    return NextResponse.json({ error: 'Could not load link' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'No such link' }, { status: 404 })
  }

  // Back to pending so the row shows as working again rather than sitting on
  // a stale error while the retry runs.
  await getSupabase()
    .from('links')
    .update({ enrichment: 'pending', enrich_error: null })
    .eq('id', id)

  const rowId = data.id as string
  const note = (data.note as string | null) ?? null

  after(async () => {
    // A screenshot has no page to scrape and its `url` is a synthetic
    // identifier, so re-running the link pipeline over it produces a title
    // from the note alone — which is how a Blade Runner 2049 screenshot came
    // back as "Television show recommendation". Fetch the image back out of
    // storage and re-run the vision path instead.
    if (data.type === 'screenshot') {
      const ref = parseStorageRef((data.image_url as string | null) ?? null)
      if (!ref) {
        console.error('enrich: screenshot row has no usable image ref', rowId)
        return
      }
      const { image, mimeType } = await downloadImage(ref.bucket, ref.path)
      await enrichScreenshot({ id: rowId, image, mimeType, note })
      return
    }

    await enrich({
      id: rowId,
      url: data.url as string,
      note,
      domain: (data.domain as string | null) ?? null,
    })
  })

  return NextResponse.json({ id, enrichment: 'pending' }, { status: 202 })
}
