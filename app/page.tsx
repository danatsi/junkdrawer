import { LinkList } from '@/components/LinkList'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import type { Link } from '@/lib/types'

// Links arrive via the Shortcut at any time, so never serve a cached list.
export const dynamic = 'force-dynamic'

async function getLinks(): Promise<Link[]> {
  // A not-yet-configured deploy should render an empty drawer, not a 500.
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
