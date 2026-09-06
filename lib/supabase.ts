import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Service-role client. Single-user app with no browser-side DB access, so the
 * service key never leaves the server and no RLS policies are needed.
 * Importing this from a client component is a build error, by design.
 *
 * Built lazily: Next evaluates route modules at build time to collect page
 * data, and a client constructed at module scope would throw there whenever
 * the env vars aren't present (CI, a fresh clone, a preview without secrets).
 */
let client: SupabaseClient | null = null

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export function getSupabase(): SupabaseClient {
  if (client) return client
  client = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
