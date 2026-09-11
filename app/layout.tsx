import type { Metadata, Viewport } from 'next'
import './globals.css'

/**
 * No webfont. The type is SF, which the device already has (see globals.css),
 * so the family is a `font-family` declaration and nothing more — one fewer
 * render-blocking request than the IBM Plex setup this replaced, and the same
 * face every other app on the phone is set in.
 *
 * That also retires the bilingual problem Plex was chosen to solve. The
 * original objection to a two-family stack was that a Latin family with a
 * Hebrew one behind it never agreed on weight. SF doesn't have that failure:
 * SF Hebrew is part of the same family, so `font-weight: 600` means one thing
 * across a mixed title.
 */
export const metadata: Metadata = {
  title: 'Junk Drawer',
  description: "Links you don't want to lose but don't want to deal with right now.",
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Junk Drawer', statusBarStyle: 'default' },
  icons: { apple: '/apple-touch-icon.png', icon: '/icon-192.png' },
}

export const viewport: Viewport = {
  // Follows the device, like the rest of the palette. A single colour here
  // would leave the status bar disagreeing with the app in one appearance.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
    { media: '(prefers-color-scheme: light)', color: '#F2F2F7' },
  ],
  width: 'device-width',
  initialScale: 1,
  // Lets the layout reach the physical edges of the screen; everything that
  // would otherwise land under the home indicator or a rounded corner pads
  // itself back out with env(safe-area-inset-*).
  viewportFit: 'cover',
  // Deliberately not disabling zoom. Pinching a row of Hebrew to read it is
  // exactly the kind of thing this app gets used for, and HIG treats zoom as
  // an accessibility guarantee rather than a default to override.
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
