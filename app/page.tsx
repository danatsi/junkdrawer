import { CORE_TAGS } from '@/lib/types'

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const

export const dynamic = 'force-dynamic'

export default async function Home() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name])

  // Phase 1 checkpoint: prove the deploy renders and, once Supabase is
  // configured, that a server component can read a row. The real list
  // (components/LinkList) lands in Phase 3.
  let status: string
  let count: number | null = null

  if (missing.length > 0) {
    status = `Not configured — missing ${missing.join(', ')}`
  } else {
    const { supabase } = await import('@/lib/supabase')
    const { count: rows, error } = await supabase
      .from('links')
      .select('*', { count: 'exact', head: true })
    status = error ? `Supabase error: ${error.message}` : 'Connected'
    count = rows ?? 0
  }

  return (
    <main style={{ width: '100%', maxWidth: 420, minHeight: '100vh', padding: '20px' }}>
      <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500, margin: '0 0 16px' }}>
        Junk Drawer
      </h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {['all', ...CORE_TAGS].map((tag) => (
          <span
            key={tag}
            style={{
              fontSize: 12,
              padding: '4px 12px',
              borderRadius: 20,
              border: '0.5px solid var(--color-divider)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {tag}
          </span>
        ))}
      </div>
      <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
        {status}
        {count !== null && ` · ${count} link${count === 1 ? '' : 's'} saved`}
      </p>
    </main>
  )
}
