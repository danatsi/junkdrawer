import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { generateReassurance, isGeminiConfigured } from '@/lib/gemini'
import type { Link } from '@/lib/types'

export const maxDuration = 60

/** Leaves room to answer inside `maxDuration`. A row that starts inside the
 *  budget can still take the Gemini call's full 20s timeout, so the check is
 *  before each call rather than after. */
const TIME_BUDGET_MS = 35_000

/** Three in a row is a rate limit or a dead key, not bad luck with one book. */
const MAX_CONSECUTIVE_FAILURES = 3

const COLUMNS = 'id, url, domain, title, description, note, extracted_text, reassurance_score'

type Row = Pick<
  Link,
  'id' | 'url' | 'domain' | 'title' | 'description' | 'note' | 'extracted_text' | 'reassurance_score'
>

/**
 * POST /api/backfill-books — score the books that were already in the drawer
 * before the taste scoring existed.
 *
 * Like `/api/backfill-watch`, and unlike a re-run of enrichment: re-running
 * the whole pipeline would re-scrape the page, re-upload the thumbnail and
 * overwrite a good title with whatever the site serves today. This asks Gemini
 * the one question that's missing, from the title, summary, note and OCR the
 * row already has, and writes only the two fields that answer it.
 *
 * `read` covers more than books — articles, longreads, a shop — so the model
 * is asked to say whether the row is one specific book at all, and rows that
 * aren't are left alone rather than given a number that means nothing. Those
 * stay candidates on later runs, which is why `skipped` is reported
 * separately: it explains a `remaining` that never reaches zero.
 *
 *   POST /api/backfill-books          rows with no score yet
 *   POST /api/backfill-books?force=1  every read row, e.g. after a prompt change
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured() || !isGeminiConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const force = new URL(request.url).searchParams.get('force') === '1'
  const startedAt = Date.now()

  const { data, error } = await getSupabase()
    .from('links')
    .select(COLUMNS)
    .eq('status', 'unread')
    .contains('tags', ['read'])
    .order('created_at', { ascending: false })
  if (error) {
    console.error('backfill-books: could not load rows', error)
    return NextResponse.json({ error: 'Could not load links' }, { status: 500 })
  }

  const rows = ((data ?? []) as unknown as Row[]).filter(
    // Nothing to identify a book by means nothing to judge.
    (row) => row.title?.trim() && (force || row.reassurance_score === null),
  )

  let updated = 0
  let skipped = 0
  let failed = 0
  let consecutiveFailures = 0
  let ranOutOfTime = false

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      ranOutOfTime = true
      break
    }

    try {
      const result = await generateReassurance({
        url: row.url,
        domain: row.domain,
        title: row.title,
        description: row.description,
        note: row.note,
        extracted_text: row.extracted_text,
      })

      if (!result.is_book || result.score === null) {
        // A longread, a bookshop, or a title too vague to place. Left null
        // rather than scored, because a guess about the wrong book is worse
        // than no badge.
        skipped += 1
        consecutiveFailures = 0
        continue
      }

      const { error: writeError } = await getSupabase()
        .from('links')
        .update({ reassurance_score: result.score, reassurance_reason: result.reason })
        .eq('id', row.id)
      if (writeError) throw new Error(writeError.message)
      updated += 1
      consecutiveFailures = 0
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`backfill-books: failed for ${row.id}:`, message)
      failed += 1
      consecutiveFailures += 1
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error('backfill-books: stopping after repeated failures')
      break
    }
  }

  return NextResponse.json({
    updated,
    // Rows that are tagged `read` but aren't a book. They stay candidates on
    // later runs; they're few, and re-checking one costs a single call.
    skipped,
    failed,
    remaining: rows.length - updated - skipped,
    ranOutOfTime,
  })
}
