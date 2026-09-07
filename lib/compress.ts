/**
 * Browser-side screenshot compression (spec §5.1).
 *
 * An iPhone screenshot is a 1–4MB full-resolution PNG. Shrinking it before it
 * leaves the phone is what makes Supabase's 1GB free tier hold thousands
 * rather than hundreds, and it's also the difference between a capture that
 * feels instant on mobile data and one that doesn't.
 *
 * Runs in the browser deliberately: the bytes never need to cross the network
 * at full size, and the server never has to hold an image decoder.
 */

/** Long edge. Enough to read a screenshot's text later, well short of the
 *  ~1179px a modern iPhone actually captures at 3x. */
const MAX_DIMENSION = 1400

/** WebP at this quality is visually indistinguishable for screenshots — flat
 *  colour and text, not photographs — at a fraction of PNG's size. */
const QUALITY = 0.8

export interface CompressionResult {
  file: File
  originalBytes: number
  compressedBytes: number
}

export async function compressImage(input: File): Promise<CompressionResult> {
  const bitmap = await createImageBitmap(input)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get a 2d canvas context')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', QUALITY),
  )
  if (!blob) throw new Error('Could not encode the image')

  // Pathological case: an already-tiny image can come out larger as WebP.
  // Keeping the original is both smaller and fewer moving parts.
  if (blob.size >= input.size && input.type === 'image/jpeg') {
    return { file: input, originalBytes: input.size, compressedBytes: input.size }
  }

  return {
    file: new File([blob], 'screenshot.webp', { type: 'image/webp' }),
    originalBytes: input.size,
    compressedBytes: blob.size,
  }
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.round(bytes / 1024)}KB`
}
