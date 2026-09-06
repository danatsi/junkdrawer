import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
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
