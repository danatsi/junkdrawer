'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { saveLink, saveScreenshot } from '@/lib/capture'
import { UNLOCK_COOKIE, isValidUnlockToken } from '@/lib/unlock'

export interface CaptureState {
  status: 'idle' | 'saved' | 'error'
  message?: string
}

/**
 * Stand-in for the iOS Shortcut, so links can be saved from a desktop browser
 * without building the Shortcut first.
 *
 * The gate is re-checked here rather than trusted from proxy.ts: Next's own
 * docs warn that Server Functions are POSTs to the page's route, so a matcher
 * change or moving this file could silently drop proxy coverage. Cheap to
 * verify, and it means the check can't be routed around.
 */
export async function captureLink(
  _previous: CaptureState,
  formData: FormData,
): Promise<CaptureState> {
  const token = (await cookies()).get(UNLOCK_COOKIE)?.value
  if (!isValidUnlockToken(token)) {
    return { status: 'error', message: 'Not unlocked.' }
  }

  const image = formData.get('image')
  const hasImage = image instanceof File && image.size > 0

  const result = hasImage
    ? await saveScreenshot(image, formData.get('note'))
    : await saveLink(formData.get('url'), formData.get('note'))

  if (!result.ok) {
    return { status: 'error', message: result.error }
  }

  // The list is force-dynamic, but this clears any cached render so the new
  // row is there the moment you navigate back.
  revalidatePath('/')
  return {
    status: 'saved',
    message: hasImage
      ? 'Screenshot saved. Reading it in the background…'
      : 'Saved. Enriching in the background…',
  }
}
