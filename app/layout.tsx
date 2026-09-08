import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans_Hebrew } from 'next/font/google'
import './globals.css'

/**
 * One family for both scripts, which is the entire point of it.
 *
 * The list is mixed Hebrew and Latin, often inside a single title. Two
 * families — a Latin one with a Hebrew one behind it in the stack — did render
 * each script in a face designed for it, but the two never agreed on weight:
 * Hebrew came out visibly thinner than Latin at the same `font-weight`, and
 * correcting that needs a per-script weight, which no single CSS declaration
 * can express. IBM Plex Sans Hebrew draws both scripts as one system, so a
 * mixed title is one voice and `font-weight: 500` means the same thing on
 * either side of it.
 *
 * This also retires the workaround in globals.css. With two families the stack
 * had to name real families rather than `var(--font-*)`, because next/font
 * folds a metric-matched `local(Arial)` face into the variable with no
 * unicode-range, and it answered every Hebrew glyph before the stack reached
 * the Hebrew family. With one family there is nothing behind it to shadow, so
 * the variable is usable as-is and the CLS adjustment comes back for free.
 *
 * Both subsets are requested and unicode-range keeps that honest: a list with
 * no Hebrew in it never downloads the Hebrew file.
 */
const plex = IBM_Plex_Sans_Hebrew({
  subsets: ['latin', 'hebrew'],
  weight: ['400', '500', '600'],
  variable: '--font-plex',
})

export const metadata: Metadata = {
  title: 'Junk Drawer',
  description: "Links you don't want to lose but don't want to deal with right now.",
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Junk Drawer', statusBarStyle: 'default' },
  icons: { apple: '/apple-touch-icon.png', icon: '/icon-192.png' },
}

export const viewport: Viewport = {
  themeColor: '#16171A',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={plex.variable}
    >
      <body>{children}</body>
    </html>
  )
}
