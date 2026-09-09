import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { generateSearchTerms, isGeminiConfigured } from '@/lib/gemini'

export const maxDuration = 60

/** Leaves room to answer inside `maxDuration`. A row that starts inside the
 *  budget can still take its full 20s timeout, so the check is before each
 *  call rather than after. */
const TIME_BUDGET_MS = 35_000

/** Three failures in a row is a rate limit or a dead key, not bad luck with
 *  one row — and the next twenty calls will fail the same way. Stopping keeps
 *  the response honest about where it got to. */
const MAX_CONSECUTIVE_FAILURES = 3

/** Fields the terms are derived from, plus the column being filled — which is
 *  read back rather than filtered on in the query, so that "has no keywords
 *  yet" doesn't depend on how PostgREST compares an empty array literal.
 *  Everything else here was already written by enrichment; this route adds
 *  vocabulary and changes nothing else. */
const COLUMNS = 'id, url, domain, title, description, note, tags, extracted_text, keywords'

interface Row {
  id: string
  url: string
  domain: string | null
  title: string | null
  description: string | null
  note: string | null
  tags: string[]
  extracted_text: string | null
  keywords: string[] | null
}

/**
 * POST /api/reindex — backfill `keywords` on rows enriched before the column
 * existed (see lib/search.ts).
 *
 * A one-off in principle, but not written as a script: the keys and the
 * Supabase client are already wired up here, and a script would need its own
 * env loading and its own copy of the Gemini setup to do the same work.
 *
 * It re-generates the terms only — not the whole pipeline. Re-running
 * enrichment over an old row would re-scrape the page, re-upload the
 * thumbnail and re-hit TMDb just to arrive back at the title it already has,
 * and would overwrite a good title with whatever the site serves today.
 *
 * Deliberately incremental: it works until its time budget runs out and
 * reports what's left, so a drawer with more rows than fit in one function
 * invocation is a matter of calling it again rather than a stuck job. Rows are
 * taken newest first, on the grounds that recent saves are the ones being
 * searched for.
 *
 *   POST /api/reindex           only rows with no keywords
 *   POST /api/reindex?force=1   every row, for when the prompt has changed
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured() || !isGeminiConfigured()) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const force = new URL(request.url).searchParams.get('force') === '1'
  const startedAt = Date.now()

  // Archived rows are excluded from the list query and so from search: terms
  // for them would cost a Gemini call each to be matched against by nothing.
  const { data, error } = await getSupabase()
    .from('links')
    .select(COLUMNS)
    .eq('status', 'unread')
    .order('created_at', { ascending: false })
  if (error) {
    console.error('reindex: could not load rows', error)
    return NextResponse.json({ error: 'Could not load links' }, { status: 500 })
  }

  const rows = ((data ?? []) as unknown as Row[]).filter((row) => force || !row.keywords?.length)
  let updated = 0
  let failed = 0
  let consecutiveFailures = 0
  let ranOutOfTime = false

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      ranOutOfTime = true
      break
    }

    try {
      const keywords = await generateSearchTerms({
        url: row.url,
        domain: row.domain,
        title: row.title,
        description: row.description,
        note: row.note,
        tags: row.tags ?? [],
        extracted_text: row.extracted_text,
      })
      // No terms is not worth a write: the row keeps its empty array and comes
      // back round on the next call rather than looking done.
      if (keywords.length === 0) {
        failed += 1
        consecutiveFailures += 1
      } else {
        const { error: writeError } = await getSupabase()
          .from('links')
          .update({ keywords })
          .eq('id', row.id)
        if (writeError) throw new Error(writeError.message)
        updated += 1
        consecutiveFailures = 0
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`reindex: failed for ${row.id}:`, message)
      failed += 1
      consecutiveFailures += 1
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error('reindex: stopping after repeated failures')
      break
    }
  }

  return NextResponse.json({
    updated,
    failed,
    // What a second call would pick up: the candidate set as it was before
    // any of this ran, less what succeeded.
    remaining: rows.length - updated,
    ranOutOfTime,
  })
}
