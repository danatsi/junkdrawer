import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { parseStorageRef, removeImage } from '@/lib/storage'
import type { LinkStatus } from '@/lib/types'

const VALID_STATUSES: LinkStatus[] = ['unread', 'done']

/**
 * PATCH /api/links/[id] — archive a row, or restore it when undo is tapped.
 * Body: { status: 'unread' | 'done' }
 *
 * Archiving is non-destructive: the row stays in the table with status='done'
 * and simply drops out of the default list query.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const { status } = (body ?? {}) as { status?: unknown }
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as LinkStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    )
  }

  // With MOCK_DATA there's no table to write to; report success so the UI's
  // archive/undo flow can be exercised against sample rows.
  if (process.env.MOCK_DATA === '1') {
    return NextResponse.json({ id, status, mocked: true })
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const { error } = await getSupabase().from('links').update({ status }).eq('id', id)
  if (error) {
    console.error('links: could not update status', error)
    return NextResponse.json({ error: 'Could not update link' }, { status: 500 })
  }

  return NextResponse.json({ id, status })
}

/**
 * DELETE /api/links/[id] — remove a row for good.
 *
 * The deep tier of the swipe (spec §6 q2): archiving is the everyday gesture
 * and keeps the row, this is for something that shouldn't be in the drawer at
 * all. The client holds the delete back for the length of the undo window and
 * only calls this once that closes, so by the time the request arrives the
 * decision has already been given five seconds to be taken back — there is no
 * second confirmation here.
 *
 * Idempotent: deleting an id that's already gone is a 200 with `deleted: 0`,
 * because the client can legitimately send this twice (the undo timer and the
 * pagehide flush race each other when a tab closes on a fresh delete).
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (process.env.MOCK_DATA === '1') {
    return NextResponse.json({ id, deleted: 1, mocked: true })
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  // Read the image references before the row goes: they're the only record of
  // which objects in the buckets belonged to this row. A watch-tagged
  // screenshot has two — the screenshot and the show's poster.
  const { data } = await getSupabase()
    .from('links')
    .select('image_url, poster_url')
    .eq('id', id)
    .maybeSingle()

  const { error, count } = await getSupabase()
    .from('links')
    .delete({ count: 'exact' })
    .eq('id', id)
  if (error) {
    console.error('links: could not delete row', id, error)
    return NextResponse.json({ error: 'Could not delete link' }, { status: 500 })
  }

  // Best-effort, and deliberately after the row is gone. A screenshot is the
  // largest thing this app stores and orphaning it would be invisible, but a
  // bucket that refuses the delete is no reason to tell the client the row is
  // still there when it isn't.
  for (const value of [data?.image_url, data?.poster_url]) {
    const ref = parseStorageRef((value as string | null) ?? null)
    if (!ref) continue
    try {
      await removeImage(ref.bucket, ref.path)
    } catch (cause) {
      console.error('links: row deleted but its image remains', id, cause)
    }
  }

  return NextResponse.json({ id, deleted: count ?? 0 })
}
