import 'server-only'
import { getSupabase } from './supabase'
import { fetchFirstImage } from './fetch-image'

/**
 * Favicons as fallback thumbnails.
 *
 * Most large retailers block server-side scraping outright — Zara serves an
 * Akamai interstitial, Amazon/Etsy/H&M/Argos return 403 — so there's often no
 * product image to be had at any price. The brand's own icon is the next best
 * thing: recognisable at 40px, and available even when the page isn't.
 *
 * Fetched and cached server-side rather than hot-linked from a favicon service.
 * Hot-linking would mean the browser telling that service every domain in your
 * drawer, which would undo the point of gating the app in the first place. One
 * fetch per domain, then it's served from our own bucket.
 */
const BUCKET = 'icons'

/** Public: a favicon is a public brand asset, so there's nothing to protect
 *  and this avoids signing a URL on every render. */
const PUBLIC_PREFIX = '/storage/v1/object/public'

/** Anything larger isn't a favicon. Guards against a redirect to a real page. */
const MAX_BYTES = 200 * 1024

export async function ensureFavicon(
  domain: string | null,
  declaredHref: string | undefined,
): Promise<string | null> {
  if (!domain) return null

  const objectPath = `${domain}.png`
  const cached = publicUrl(objectPath)

  // Cheap existence check: one HEAD-ish request beats re-fetching and
  // re-uploading the same icon for every row from the same shop.
  if (await exists(objectPath)) return cached

  const icon = await fetchFirstImage(
    [
      declaredHref,
      `https://${domain}/favicon.ico`,
      // Last resort. Only reached when the site declared nothing and has no
      // favicon at its conventional path, and it still never touches the
      // browser — this call is made from the server.
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
    ],
    MAX_BYTES,
  )
  if (!icon) return null

  const { error } = await getSupabase()
    .storage.from(BUCKET)
    .upload(objectPath, icon.body, { contentType: icon.contentType, upsert: true })

  if (error) {
    console.error('icons: could not cache favicon for', domain, error.message)
    return null
  }
  return cached
}

async function exists(objectPath: string): Promise<boolean> {
  const { data } = await getSupabase()
    .storage.from(BUCKET)
    .list('', { search: objectPath, limit: 1 })
  return Boolean(data?.some((entry) => entry.name === objectPath))
}

function publicUrl(objectPath: string): string {
  return `${process.env.SUPABASE_URL}${PUBLIC_PREFIX}/${BUCKET}/${objectPath}`
}
