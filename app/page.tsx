import { LinkList } from '@/components/LinkList'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { resolveImageRefs } from '@/lib/storage'
import { MOCK_LINKS } from '@/lib/mock-data'
import type { Link } from '@/lib/types'

// Links arrive via the Shortcut at any time, so never serve a cached list.
export const dynamic = 'force-dynamic'

async function getLinks(): Promise<Link[]> {
  // Opt-in by env rather than "fall back when unconfigured", so a production
  // deploy that's missing its Supabase vars shows an empty drawer instead of
  // silently serving convincing fake links.
  if (process.env.MOCK_DATA === '1') return MOCK_LINKS

  if (!isSupabaseConfigured()) {
    console.warn('Supabase env vars missing — rendering an empty list')
    return []
  }

  const { data, error } = await getSupabase()
    .from('links')
    .select('*')
    .eq('status', 'unread')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('page: could not load links', error)
    return []
  }
  return withResolvedImages((data ?? []) as Link[])
}

/**
 * Images we host ourselves are stored as `storage:<bucket>/<path>` rather than
 * a URL, because those buckets are private (see lib/storage.ts). Swap them for
 * short-lived signed URLs here, so client components never have to know that
 * `image_url` holds two different kinds of thing.
 */
async function withResolvedImages(links: Link[]): Promise<Link[]> {
  // Both image fields, in one batch. A watch-tagged screenshot carries two
  // hosted images at once — the screenshot and the show's poster — and signing
  // them in separate passes would double the round-trips for no gain.
  const refs = links
    .flatMap((l) => [l.image_url, l.poster_url])
    .filter((url): url is string => Boolean(url?.startsWith('storage:')))
  if (refs.length === 0) return links

  const resolved = await resolveImageRefs(refs)
  const swap = (url: string | null) =>
    url?.startsWith('storage:') ? (resolved.get(url) ?? null) : url

  return links.map((l) => ({
    ...l,
    image_url: swap(l.image_url),
    poster_url: swap(l.poster_url),
  }))
}

export default async function Home() {
  return <LinkList links={await getLinks()} />
}
