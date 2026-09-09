import { UnlockForm } from '@/components/UnlockForm'

/** Reads the cookie via the action on submit, so nothing here should be
 *  prerendered or cached. */
export const dynamic = 'force-dynamic'

export default function UnlockPage() {
  return <UnlockForm />
}
