import { dirname } from 'path'
import { fileURLToPath } from 'url'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // There's a stray package-lock.json in ~, which makes Turbopack infer the
  // workspace root as /Users/danat. Pin it to this project.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // No `images` block on purpose. Nothing imports next/image — every thumbnail
  // is a plain <img>, because at 40px the optimizer costs more than it saves
  // (see components/LinkRow.tsx). A `remotePatterns: hostname: '**'` used to
  // sit here for scraped og:image hosts that "can't be enumerated up front";
  // scraped images now live in our own bucket, so nothing loads from an
  // arbitrary host any more, and leaving the wildcard would keep
  // /_next/image willing to proxy any URL on the internet.
}

export default nextConfig
