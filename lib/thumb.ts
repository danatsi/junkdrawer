import type { Link } from './types'

/**
 * The floor of the thumbnail fallback: when there's no photo and no favicon,
 * derive a tile from the row itself. No network, no storage, never fails.
 *
 * Deterministic on purpose — the same domain always gets the same tile, so the
 * list stays recognisable between visits and a row doesn't change appearance
 * when it re-enriches.
 */
export interface GeneratedThumb {
  monogram: string
  background: string
}

/** Rotations around the palette's warm neutrals. Deliberately narrow: these
 *  sit behind the content and must never compete with the accent colour, which
 *  is reserved for status (spec §4.1). */
const TONES: [string, string][] = [
  ['#E4DBC9', '#CBBDA2'],
  ['#DED3BE', '#C2B195'],
  ['#E8DCC6', '#CFBE9C'],
  ['#DAD2C4', '#BCAF99'],
  ['#E6D9C4', '#C8B694'],
  ['#DCD0BB', '#BFAE90'],
]

export function generatedThumb(link: Link): GeneratedThumb {
  const seed = link.domain || link.title || link.url
  const [from, to] = TONES[hash(seed) % TONES.length]
  return {
    monogram: initial(link),
    background: `linear-gradient(135deg, ${from}, ${to})`,
  }
}

function initial(link: Link): string {
  const source = link.domain?.replace(/^www\./, '') || link.title || ''
  const letter = source.trim().charAt(0).toUpperCase()
  return /[A-Z0-9]/.test(letter) ? letter : '·'
}

/** FNV-1a. Small, stable across runs, and good enough to spread a handful of
 *  domains across six tones. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return Math.abs(h)
}
