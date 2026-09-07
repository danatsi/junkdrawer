import 'server-only'
import { getSupabase } from './supabase'

/**
 * Private image storage.
 *
 * Two buckets, both private: `screenshots` for captured screenshots, `items`
 * for product photos the Shortcut grabs off the rendered page. Private because
 * both reveal things about you — what was on your phone, what you're shopping
 * for — and a public bucket would make them readable by URL alone, quietly
 * undoing the gate on the rest of the app. (Favicons live in a separate public
 * bucket; they're public brand assets with nothing to protect.)
 *
 * Rows don't store a URL for these. They store `storage:<bucket>/<path>`, and
 * the list swaps that for a short-lived signed URL at render time. The prefix
 * is what lets one rule cover both buckets and coexist with the plain https
 * URLs that scraped images and favicons use.
 */
export type Bucket = 'screenshots' | 'items'

const MARKER = 'storage:'

/** Long enough to read the list and open the full-screen viewer, short enough
 *  that a copied URL isn't a permanent handle to the image. */
const SIGNED_URL_TTL_SECONDS = 60 * 60

export function storageRef(bucket: Bucket, objectPath: string): string {
  return `${MARKER}${bucket}/${objectPath}`
}

export function parseStorageRef(value: string | null): { bucket: Bucket; path: string } | null {
  if (!value?.startsWith(MARKER)) return null
  const rest = value.slice(MARKER.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { bucket: rest.slice(0, slash) as Bucket, path: rest.slice(slash + 1) }
}

export async function uploadImage(
  bucket: Bucket,
  objectPath: string,
  file: Blob,
): Promise<string> {
  const { error } = await getSupabase()
    .storage.from(bucket)
    .upload(objectPath, file, { contentType: file.type || 'image/webp', upsert: false })
  if (error) throw new Error(`${bucket} upload failed: ${error.message}`)
  return storageRef(bucket, objectPath)
}

/**
 * Resolves every `storage:` reference in one pass, batched per bucket. The
 * list can hold an image per row, and signing them one request at a time would
 * put a round-trip per row on the page's critical path.
 */
export async function resolveImageRefs(refs: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()

  const byBucket = new Map<Bucket, string[]>()
  for (const ref of refs) {
    const parsed = parseStorageRef(ref)
    if (!parsed) continue
    const paths = byBucket.get(parsed.bucket) ?? []
    paths.push(parsed.path)
    byBucket.set(parsed.bucket, paths)
  }

  for (const [bucket, paths] of byBucket) {
    const { data, error } = await getSupabase()
      .storage.from(bucket)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)

    if (error) {
      // A row without a thumbnail is still a usable row, so this degrades
      // rather than failing the whole list.
      console.error(`storage: could not sign urls for ${bucket}`, error)
      continue
    }
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) {
        resolved.set(storageRef(bucket, entry.path), entry.signedUrl)
      }
    }
  }
  return resolved
}

/** Fetches an image back out of storage, for re-running enrichment on a row
 *  whose original upload is long gone from memory. */
export async function downloadImage(
  bucket: Bucket,
  objectPath: string,
): Promise<{ image: Buffer; mimeType: string }> {
  const { data, error } = await getSupabase().storage.from(bucket).download(objectPath)
  if (error || !data) throw new Error(`${bucket} download failed: ${error?.message ?? 'no data'}`)
  return {
    image: Buffer.from(await data.arrayBuffer()),
    mimeType: data.type || 'image/webp',
  }
}
