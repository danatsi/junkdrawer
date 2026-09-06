import { dirname } from 'path'
import { fileURLToPath } from 'url'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // There's a stray package-lock.json in ~, which makes Turbopack infer the
  // workspace root as /Users/danat. Pin it to this project.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  images: {
    // Thumbnails come from arbitrary scraped og:image URLs, so the host list
    // can't be enumerated up front.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
}

export default nextConfig
