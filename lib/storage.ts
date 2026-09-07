import 'server-only'
import { getSupabase } from './supabase'

/**
 * Screenshot storage (spec §5.1, resolved to Supabase Storage rather than R2 —
 * the images are compressed in the browser first, so the free 1GB holds
 * thousands of them and there's no second account to manage).
 *
 * The bucket is private. A screenshot can contain anything that was on your
 * phone, and a public bucket would make the image readable by URL alone,
 * which would quietly undo the gate on the rest of the app. Rows therefore
 * store the object *path*, and the list signs it at render time.
 */
const BUCKET = 'screenshots'

/** Long enough to cover reading the list and opening the full-screen viewer,
 *  short enough that a copied URL isn't a permanent handle to the image. */
const SIGNED_URL_TTL_SECONDS = 60 * 60

export async function uploadScreenshot(file: Blob, objectPath: string): Promise<void> {
  const { error } = await getSupabase()
    .storage.from(BUCKET)
    .upload(objectPath, file, {
      contentType: file.type || 'image/webp',
      upsert: false,
    })
  if (error) throw new Error(`screenshot upload failed: ${error.message}`)
}

/**
 * Signs many paths at once. The list can hold a screenshot per row, and
 * signing them one request at a time would put a round-trip per row on the
 * page's critical path.
 */
export async function signScreenshots(paths: string[]): Promise<Map<string, string>> {
  const signed = new Map<string, string>()
  if (paths.length === 0) return signed

  const { data, error } = await getSupabase()
    .storage.from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)

  if (error) {
    // A row without a thumbnail is still a usable row, so this degrades
    // rather than failing the whole list.
    console.error('storage: could not sign screenshot urls', error)
    return signed
  }

  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl)
  }
  return signed
}

export async function deleteScreenshot(objectPath: string): Promise<void> {
  const { error } = await getSupabase().storage.from(BUCKET).remove([objectPath])
  if (error) console.error('storage: could not delete screenshot', error)
}
