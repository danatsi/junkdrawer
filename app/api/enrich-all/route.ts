import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { reenrich, type ReenrichTarget } from '@/lib/enrich'
import { isGeminiConfigured } from '@/lib/gemini'

export const maxDuration = 60

/**
 * Lower than the backfills' 35s, because what runs here is the whole pipeline
 * rather than one Gemini call: a scrape, a generation and the watch chain,
 * each with its own timeout, can add up to ~30s for a single stubborn row.
 * The check happens before a row starts, so the budget has to leave room for
 * the worst case to finish inside `maxDuration` — a row cut off by the
 * platform is the one outcome worth engineering against, since it would leave
 * the row mid-flight with nothing written.
 */
const TIME_BUDGET_MS = 25_000

/** Three in a row is a rate limit or a dead key, not bad luck with one page. */
const MAX_CONSECUTIVE_FAILURES = 3

const COLUMNS = 'id, url, domain, note, title, type, image_url, enrichment'

interface Row extends ReenrichTarget {
  title: string | null
  enrichment: string
}

/** What "broken" means: enrichment gave up, or never finished, or finished
 *  without managing to name the row. These are the rows a re-run can only
 *  improve, which is the whole basis for doing this in bulk. A `pending` row
 *  is included because enrichment sets `failed` on error — one still sitting
 *  at `pending` means the function died mid-flight and no amount of waiting
 *  will resolve it. */
function isBroken(row: Row): boolean {
  return row.enrichment !== 'ok' || !row.title?.trim()
}

/**
 * POST /api/enrich-all — re-run enrichment over the rows that need it.
 *
 * Deliberately not "re-enrich everything" by default. Re-running the pipeline
 * re-scrapes the page, re-uploads the thumbnail and re-hits TMDb, and it
 * overwrites a good title with whatever the site serves today — a retailer
 * answering with a bot page this morning would replace a title that is
 * currently fine. So the default set is only the rows a re-run cannot make
 * worse, and the blunt version is behind a flag you have to type.
 *
 * Incremental like the backfills: it works until its budget runs out and
 * reports what is left, so more rows than fit in one invocation is a matter of
 * calling it again rather than a stuck job. Rows go newest first.
 *
 *   POST /api/enrich-all          failed, stuck, and untitled rows
 *   POST /api/enrich-all?force=1  every unread row, accepting the above
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
    .order('created_at', { ascending: false })
  if (error) {
    console.error('enrich-all: could not load rows', error)
    return NextResponse.json({ error: 'Could not load links' }, { status: 500 })
  }

  const rows = ((data ?? []) as unknown as Row[]).filter((row) => force || isBroken(row))

  let enriched = 0
  let failed = 0
  let consecutiveFailures = 0
  let ranOutOfTime = false

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      ranOutOfTime = true
      break
    }

    try {
      // Flip the row to `pending` before working on it, the way the single-row
      // retry does. That is the only thing that makes a bulk run visible: the
      // list renders a pending row as "adding details" and polls while any
      // exists, so the drawer shows the run moving through it instead of
      // sitting unchanged until a reload. Per row rather than for the whole
      // batch, so what is marked as working actually is.
      await getSupabase()
        .from('links')
        .update({ enrichment: 'pending', enrich_error: null })
        .eq('id', row.id)

      await reenrich(row)
      // `enrich` doesn't throw — it catches its own failures and records them
      // on the row — so the only honest way to know how a row came out is to
      // read it back. A few milliseconds against the several seconds the row
      // just spent, and without it this route would report every row as a
      // success no matter what happened.
      const { data: after } = await getSupabase()
        .from('links')
        .select('enrichment')
        .eq('id', row.id)
        .maybeSingle()

      if (after?.enrichment === 'ok') {
        enriched += 1
        consecutiveFailures = 0
      } else {
        failed += 1
        consecutiveFailures += 1
      }
    } catch (cause) {
      // Only the screenshot path throws — a bucket that won't hand the image
      // back. Recorded on the row rather than only counted, because the
      // `pending` set above would otherwise be left standing and the row would
      // claim to be working on nothing.
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(`enrich-all: failed for ${row.id}:`, message)
      await getSupabase()
        .from('links')
        .update({ enrichment: 'failed', enrich_error: message.slice(0, 500) })
        .eq('id', row.id)
      failed += 1
      consecutiveFailures += 1
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error('enrich-all: stopping after repeated failures')
      break
    }
  }

  return NextResponse.json({
    // The set this run was working from, so a `remaining` of 0 with nothing
    // enriched reads as "nothing needed it" rather than as a silent no-op.
    selected: rows.length,
    enriched,
    failed,
    remaining: rows.length - enriched,
    ranOutOfTime,
  })
}
