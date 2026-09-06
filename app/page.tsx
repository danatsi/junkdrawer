import { LinkList } from '@/components/LinkList'
import type { Link } from '@/lib/types'

// Links arrive via the Shortcut at any time, so never serve a cached list.
export const dynamic = 'force-dynamic'

async function getLinks(): Promise<Link[]> {
  // lib/supabase throws on import when the env vars are absent. Check first so
  // a not-yet-configured deploy renders an empty drawer instead of a 500.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase env vars missing — rendering an empty list')
    return []
  }

  const { supabase } = await import('@/lib/supabase')
  const { data, error } = await supabase
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
