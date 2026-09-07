import 'server-only'
import { after } from 'next/server'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { enrich } from './enrich'
import { parseUrl, domainOf } from './url'

/**
 * Saving a link, shared by the two things that can do it: the iOS Shortcut's
 * bearer-authenticated endpoint, and the in-app capture form. Both need
 * identical behaviour — same validation, same upsert, same deferred
 * enrichment — so neither should own the logic.
 */
export type CaptureResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string }

export async function saveLink(rawUrl: unknown, rawNote: unknown): Promise<CaptureResult> {
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

  // Upsert on url: re-sharing a link updates the note rather than creating a
  // second row. Re-enrich, since a new note changes the title Gemini produces.
  const { data, error } = await getSupabase()
    .from('links')
    .upsert(
      { url: href, note, domain, status: 'unread', enrichment: 'pending', enrich_error: null },
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
    await enrich({ id, url: href, note, domain })
  })

  return { ok: true, id }
}
