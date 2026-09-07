/**
 * Normalise package-lock.json so every registry tarball points at public npm.
 *
 * Why this exists: on some corporate networks registry.npmjs.org is
 * unreachable — the TLS handshake gets severed by an inspecting middlebox — so
 * installs have to go through an internal registry mirror. npm then writes
 * *that* mirror's URLs into the lockfile, and a lockfile pointing at a private
 * host fails any build that can't reach it (Vercel, CI, another machine).
 *
 * Rewriting the host is safe: a mirror proxies byte-identical tarballs, and
 * npm verifies the `integrity` hash rather than the URL it came from.
 *
 * Usage:  npm install <pkg> --registry=<your mirror>
 *         npm run relock
 */
import { readFileSync, writeFileSync } from 'node:fs'

const LOCKFILE = 'package-lock.json'
const PUBLIC_HOST = 'https://registry.npmjs.org/'

/**
 * Matches the tail of any npm registry tarball URL — `pkg/-/pkg-1.2.3.tgz` or
 * `@scope/pkg/-/pkg-1.2.3.tgz` — regardless of the host and path prefix in
 * front of it. Deliberately host-agnostic: no mirror is named here, so this
 * works for any registry and hardcodes nobody's internal infrastructure.
 *
 * Requiring the `.tgz` tail is what protects git and file dependencies, whose
 * `resolved` URLs don't have this shape and must be left alone.
 */
const TARBALL = /"resolved":\s*"https:\/\/[^"]*?((?:@[^/"]+\/)?[^/"]+\/-\/[^/"]+\.tgz)"/g

const before = readFileSync(LOCKFILE, 'utf8')

let rewritten = 0
const after = before.replace(TARBALL, (match, tail) => {
  const replacement = `"resolved": "${PUBLIC_HOST}${tail}"`
  if (replacement !== match) rewritten += 1
  return replacement
})

if (rewritten > 0) writeFileSync(LOCKFILE, after)

console.log(
  rewritten > 0
    ? `relock: rewrote ${rewritten} tarball URLs -> registry.npmjs.org`
    : 'relock: nothing to do, all tarballs already point at registry.npmjs.org',
)

// Anything registry-shaped that still isn't public means the regex missed a
// URL layout, which would otherwise ship a broken lockfile silently.
const strays = [...after.matchAll(/"resolved":\s*"https:\/\/([^/"]+)([^"]*\.tgz)"/g)]
  .filter(([, host]) => host !== 'registry.npmjs.org')
  .map(([, host]) => host)

if (strays.length > 0) {
  console.error(`relock: FAILED — tarballs still on non-public hosts: ${[...new Set(strays)].join(', ')}`)
  process.exit(1)
}
