import { LinkList } from '@/components/LinkList'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { signScreenshots } from '@/lib/storage'
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
  return withSignedScreenshots((data ?? []) as Link[])
}

/**
 * Screenshot rows store a storage object path, not a URL, because the bucket
 * is private (see lib/storage.ts). Swap those paths for short-lived signed
 * URLs here, so the client components stay unaware that two different kinds of
 * thing live in `image_url`.
 */
async function withSignedScreenshots(links: Link[]): Promise<Link[]> {
  const paths = links
    .filter((l) => l.type === 'screenshot' && l.image_url)
    .map((l) => l.image_url as string)
  if (paths.length === 0) return links

  const signed = await signScreenshots(paths)
  return links.map((l) =>
    l.type === 'screenshot' && l.image_url
      ? { ...l, image_url: signed.get(l.image_url) ?? null }
      : l,
  )
}

export default async function Home() {
  return <LinkList links={await getLinks()} />
}
