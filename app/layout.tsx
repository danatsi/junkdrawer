import type { Metadata, Viewport } from 'next'
import { Lora, Inter } from 'next/font/google'
import './globals.css'

const lora = Lora({ subsets: ['latin'], weight: ['500'], variable: '--font-lora' })
const inter = Inter({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Junk Drawer',
  description: "Links you don't want to lose but don't want to deal with right now.",
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Junk Drawer', statusBarStyle: 'default' },
  icons: { apple: '/apple-touch-icon.png', icon: '/icon-192.png' },
}

export const viewport: Viewport = {
  themeColor: '#F1ECE2',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lora.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  )
}
