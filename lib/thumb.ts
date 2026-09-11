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

/** iOS system colours, each shading into its own darker variant — the
 *  treatment Contacts and Files use for an item with no image of its own: a
 *  saturated tile carrying a white monogram.
 *
 *  Six hues, and systemRed is deliberately not among them. That colour means
 *  "this destroys something" everywhere else on the platform, and the app
 *  spends it on exactly one control (the delete action); a row that merely
 *  happened to hash to red would spend it again for nothing. */
const TONES: [string, string][] = [
  ['#0A84FF', '#0060DF'], // blue
  ['#5E5CE6', '#3634A3'], // indigo
  ['#30D158', '#248A3D'], // green
  ['#FF9F0A', '#C93400'], // orange
  ['#BF5AF2', '#8944AB'], // purple
  ['#64D2FF', '#0071A4'], // teal
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
