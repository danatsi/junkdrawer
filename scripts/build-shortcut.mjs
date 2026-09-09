#!/usr/bin/env node
/**
 * Turns the versioned shortcut plist into a file you can install.
 *
 * The shortcut is the one part of capture that lives outside the codebase: it
 * is built in a GUI, has no diff, and cannot be reviewed. So the plist in
 * `shortcuts/` is the source of truth and the phone holds a copy, rather than
 * the other way round.
 *
 * The token is not in that plist. An exported shortcut carries the
 * Authorization header verbatim, and this repo is public — committing the
 * export would republish the secret. So the committed copy holds
 * `__CAPTURE_TOKEN__` and the real value is injected here, at build time, from
 * .env.local. The output is gitignored.
 *
 *   node scripts/build-shortcut.mjs            # build + sign
 *   node scripts/build-shortcut.mjs --unsigned # skip signing
 *
 * Signing needs macOS. `shortcuts sign` keys off the input file's extension,
 * so the intermediate is written as .shortcut rather than .plist — with any
 * other extension it fails with "isn't in the correct format".
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'shortcuts', 'capture-web-page.plist')
const outDir = join(root, 'shortcuts', 'dist')
const unsignedPath = join(outDir, 'Capture Web Page.unsigned.shortcut')
const signedPath = join(outDir, 'Capture Web Page.shortcut')

const PLACEHOLDER = '__CAPTURE_TOKEN__'

function readToken() {
  const envPath = join(root, '.env.local')
  if (!existsSync(envPath)) fail('.env.local not found — the token lives there, not in the repo.')
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('CAPTURE_TOKEN='))
  const token = line?.slice('CAPTURE_TOKEN='.length).trim().replace(/^["']|["']$/g, '')
  if (!token) fail('CAPTURE_TOKEN is empty in .env.local')
  return token
}

function fail(message) {
  console.error(`build-shortcut: ${message}`)
  process.exit(1)
}

const xml = readFileSync(source, 'utf8')
if (!xml.includes(PLACEHOLDER)) {
  // Guards against someone committing a build output over the source, which
  // would put the live token in the repo without anything complaining.
  fail(`${PLACEHOLDER} not found in the plist — refusing to build from a file that may hold a real token.`)
}

const token = readToken()
mkdirSync(outDir, { recursive: true })
writeFileSync(unsignedPath, xml.replaceAll(PLACEHOLDER, token))
console.log(`built  ${unsignedPath}`)

if (process.argv.includes('--unsigned')) process.exit(0)

try {
  execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', unsignedPath, '--output', signedPath], {
    stdio: ['ignore', 'inherit', 'pipe'],
  })
  console.log(`signed ${signedPath}`)
  console.log('AirDrop it to your phone, or open it on a Mac signed into the same account.')
} catch (error) {
  fail(`signing failed (needs macOS): ${error.message}`)
}
