import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    // Thumbnails come from arbitrary scraped og:image URLs, so the host list
    // can't be enumerated up front.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
}

export default nextConfig
