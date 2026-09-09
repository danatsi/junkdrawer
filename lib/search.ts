/**
 * Search matching (spec §6 q4, PLAN §3 Phase 6).
 *
 * The drawer is bilingual and the query never is: a Zara link scraped in
 * English is looked for as "מכנסיים", a Hebrew recipe as "chicken". Substring
 * matching over the stored title can't bridge that, so search works in two
 * layers, and neither one alone is enough:
 *
 *  1. **Vocabulary** — enrichment asks Gemini for `keywords`: the words you'd
 *     plausibly type to find this row later, in Hebrew *and* English whatever
 *     the page's own language was. That's the only layer that can turn "jeans"
 *     into "מכנסיים"; no amount of string manipulation gets there.
 *  2. **Morphology** — this file. The vocabulary is a handful of terms, not
 *     every inflection of them, so matching has to be tolerant of the shape a
 *     word arrives in: "מכנס" against "מכנסיים", "חולצה" against "חולצות",
 *     "גינס" against "ג'ינס", "shirt" against "shirts".
 *
 * Deliberately no Postgres full-text search: `to_tsvector` has no Hebrew
 * configuration (there's no stemmer, so it degrades to `simple`), the list is
 * already fetched whole for the client filter, and a personal drawer holds
 * hundreds of rows rather than millions.
 */

import type { Link } from './types'

/** Everything a row contributes to matching. A structural type rather than
 *  `Link`, so this can be exercised with a literal. */
export type SearchableLink = Pick<
  Link,
  'title' | 'domain' | 'note' | 'description' | 'extracted_text' | 'tags' | 'keywords' | 'url'
>

/** Niqqud and cantillation marks. A Hebrew page occasionally ships them and a
 *  query never has them, so they're stripped from both sides. */
const HEBREW_POINTS = /[֑-ׇ]/g

/** Latin combining accents, left behind by the NFKD below. */
const LATIN_ACCENTS = /[̀-ͯ]/g

/** Geresh and gershayim, plus the ASCII and curly quotes standing in for them
 *  on a phone keyboard. This is what makes ג'ינס and גינס the same word —
 *  which is not a nicety: the apostrophe is optional in practice, so the
 *  spelling you save is routinely not the spelling you type. */
const QUOTES = /[׳״'"`´‘’“”]/g

/** Unicode-aware, so a Hebrew word is one token and so is a digit run. */
const WORD = /[\p{L}\p{N}]+/gu

export function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(LATIN_ACCENTS, '')
    .replace(HEBREW_POINTS, '')
    .replace(QUOTES, '')
    .toLowerCase()
}

/** Final letter forms fold to their medial ones, so a word carries the same
 *  spelling whether or not the suffix stripping below exposed it: מכנסיים ends
 *  in ם, and dropping the plural leaves מכנס with a מ. */
const FINAL_FORMS: Record<string, string> = {
  ך: 'כ',
  ם: 'מ',
  ן: 'נ',
  ף: 'פ',
  ץ: 'צ',
}

/**
 * Plural, dual and feminine endings, in folded form (ם is already מ by the
 * time these apply), longest first.
 *
 * Not a stemmer — a real one needs a lexicon. It's a list of the endings that
 * separate a word from the same word: מכנסיים/מכנס, חולצות/חולצה,
 * נעליים/נעל. Wrong for some words (a stripped ת mangles a few), which is
 * survivable because stripping is additive: both forms are kept and either can
 * match, so a bad strip adds a spurious form rather than losing the real one.
 */
const HEBREW_SUFFIXES = ['יימ', 'יות', 'ימ', 'ות', 'ה', 'ת', 'י']

/** Prefix particles — the ב/ל/מ/ה/ו/ש/כ that arrive glued to the noun, as in
 *  "במכנסיים". Only stripped off a long enough word, so מכנס doesn't shed its
 *  own first letter and start matching כנס. */
const HEBREW_PREFIXES = ['ב', 'ה', 'ו', 'כ', 'ל', 'מ', 'ש']

/** What's left after a strip has to still be a word. 4 for prefixes because a
 *  three-letter Hebrew root is usually a word in its own right. */
const MIN_AFTER_SUFFIX = 3
const MIN_AFTER_PREFIX = 4

/** Below this, a prefix match is meaningless — every third word starts with
 *  the same two letters. Shorter queries fall through to the substring pass. */
const MIN_PREFIX_MATCH = 3

/**
 * How much longer than the stored word a query may be and still count as a
 * prefix match of it. Two characters is an inflection the suffix rules didn't
 * catch; more than that is a different word, and matching it is actively
 * wrong — "bookcase" reached a row whose only term was "book" before this
 * cap existed.
 */
const MAX_QUERY_OVERHANG = 2

function foldFinals(token: string): string {
  let out = ''
  for (const char of token) out += FINAL_FORMS[char] ?? char
  return out
}

function stripSuffix(token: string): string | null {
  for (const suffix of HEBREW_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= MIN_AFTER_SUFFIX) {
      return token.slice(0, -suffix.length)
    }
  }
  // Latin plurals. -ies keeps its stem spellable (stories -> story).
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith('es') && token.length > 3) return token.slice(0, -2)
  if (token.endsWith('s') && token.length > 3) return token.slice(0, -1)
  return null
}

/**
 * Every spelling of one token worth matching on: itself, without its ending,
 * without a glued-on particle, and without both.
 *
 * A set rather than a single stem because none of the rules above is reliable
 * enough to be destructive. Keeping the original means a wrong guess can only
 * ever add a match.
 */
export function forms(token: string): Set<string> {
  const base = foldFinals(token)
  const out = new Set<string>()

  const add = (word: string) => {
    out.add(word)
    const stripped = stripSuffix(word)
    if (stripped) out.add(stripped)
  }

  add(base)
  for (const prefix of HEBREW_PREFIXES) {
    if (base.startsWith(prefix) && base.length - 1 >= MIN_AFTER_PREFIX) {
      add(base.slice(1))
      break
    }
  }
  return out
}

function formsMatch(query: Set<string>, candidate: Set<string>): boolean {
  for (const q of query) {
    for (const c of candidate) {
      if (q === c) return true
      // A query that's the shorter word is the common case, and it can be much
      // shorter: "מכנס" should reach "מכנסיים" and "jean" should reach
      // "jeans".
      if (q.length >= MIN_PREFIX_MATCH && c.startsWith(q)) return true
      // The other direction is narrow on purpose — see MAX_QUERY_OVERHANG.
      if (
        c.length >= MIN_PREFIX_MATCH &&
        q.length - c.length <= MAX_QUERY_OVERHANG &&
        q.startsWith(c)
      ) {
        return true
      }
    }
  }
  return false
}

/** The path and slug, which is where a retailer puts the product name —
 *  /il/he/wide-leg-jeans-p12345 is often better than anything that scraped.
 *  Percent-encoded Hebrew slugs are common enough to be worth decoding. */
function urlWords(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '')
  const path = withoutScheme.slice(withoutScheme.indexOf('/') + 1).split(/[?#]/)[0]
  if (!path || path === withoutScheme) return ''
  try {
    return decodeURIComponent(path)
  } catch {
    // A stray % makes decoding throw; the undecoded path still has its Latin
    // words in it.
    return path
  }
}

/** A query compiled once and run against every row, rather than re-tokenised
 *  per row per keystroke. */
export interface CompiledQuery {
  readonly terms: ReadonlyArray<{ readonly text: string; readonly forms: Set<string> }>
}

export function compileQuery(input: string): CompiledQuery | null {
  const tokens = normalise(input).match(WORD)
  if (!tokens?.length) return null
  return { terms: tokens.map((text) => ({ text, forms: forms(text) })) }
}

/**
 * Matches title, domain, note, summary, a screenshot's OCR'd text, the URL
 * slug, every tag — including the freeform ones that never get a chip, which
 * is the main way to reach them — and the generated bilingual keywords.
 *
 * Multi-word queries are AND: "zara jeans" wants a row that answers to both,
 * which is how a two-word query is meant, and it doesn't require them to be
 * adjacent the way plain substring matching did.
 */
export function matchesQuery(link: SearchableLink, query: CompiledQuery): boolean {
  const haystack = normalise(
    [
      link.title,
      link.domain,
      link.note,
      link.description,
      link.extracted_text,
      urlWords(link.url),
      ...link.tags,
      // Defensive: a deploy that lands before its migration serves rows with
      // no `keywords` at all, and spreading undefined throws — which would
      // take the whole list down rather than just degrading search.
      ...(link.keywords ?? []),
    ]
      .filter(Boolean)
      .join(' '),
  )
  const candidates = (haystack.match(WORD) ?? []).map((token) => forms(token))

  return query.terms.every(
    (term) =>
      candidates.some((candidate) => formsMatch(term.forms, candidate)) ||
      // Substring is the fallback rather than the rule: it's what catches a
      // word inside a compound ("shirt" in "tshirt") and the first two letters
      // of something half-typed, both of which prefix matching on tokens
      // misses.
      haystack.includes(term.text),
  )
}
