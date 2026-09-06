import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Service-role client. Single-user app with no browser-side DB access, so the
 * service key never leaves the server and no RLS policies are needed.
 * Importing this from a client component is a build error, by design.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const supabase = createClient(
  required('SUPABASE_URL'),
  required('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
)
