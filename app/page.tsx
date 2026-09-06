import { LinkList } from '@/components/LinkList'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
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
  return (data ?? []) as Link[]
}

export default async function Home() {
  return <LinkList links={await getLinks()} />
}
