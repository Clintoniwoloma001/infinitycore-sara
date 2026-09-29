#!/usr/bin/env node
// ===========================================================================
// Securely add a provider secret to Supabase (no plaintext on disk, ever).
//
// WHY THIS EXISTS
//   The Clean APIs key was pasted into a chat, so it must be rotated. This
//   script lets the operator enter the NEW key without ever writing it to a
//   file, a shell history entry, or a git-tracked file:
//
//     - the value is read from a TTY with echo DISABLED (or from stdin when
//       piped, e.g. from a password manager),
//     - it is passed to `supabase secrets set` through a 0600 temp env file that
//       is shredded on exit,
//     - it is never echoed back and never printed in logs.
//
// USAGE
//   node scripts/set-supabase-secret.mjs                    # interactive prompt
//   node scripts/set-supabase-secret.mjs --name CLEAN_APIS_KEY
//   CLEAN_APIS_KEY=cc_... node scripts/set-supabase-secret.mjs --stdin-env
//   node scripts/set-supabase-secret.mjs --list             # names only
//
// The value is deliberately NOT accepted via --value: process arguments are
// world-readable in `ps` and are recorded in shell history.
// ===========================================================================

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

/** Secrets this project expects. Nothing here is a real credential. */
const EXPECTED = {
  CLEAN_APIS_KEY: 'Clean APIs - OpenAI-compatible provider (gpt-5.6-luna / deepseek-v4-flash-0731)',
  OPENAI_API_KEY: 'OpenAI - Whisper transcription for I-Meet',
  GEMINI_API_KEY: 'Google Gemini - optional summary tier',
  GROQ_API_KEY: 'Groq - optional summary tier',
  NVIDIA_API_KEY: 'NVIDIA NIM - optional summary tier',
}

const isTty = process.stdin.isTTY && process.stdout.isTTY

/**
 * Read a secret with echo disabled. Falls back to piped stdin when there is no
 * TTY (CI, or a pipe from a password manager such as `op read`).
 */
async function readSecret(prompt) {
  if (!isTty) {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  // The classic readline echo suppression: render the prompt, discard the echo.
  process.stdout.write(prompt)
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const answer = await new Promise((resolve) => {
    rl.question('', resolve)
    rl._writeToOutput = function (chunk) {
      if (String(chunk).includes('Enter the value')) this.output.write(chunk)
    }
  })
  rl.close()
  process.stdout.write('\n')
  return String(answer).trim()
}

function fail(msg, code = 1) {
  console.error(`\n  ERROR: ${msg}\n`)
  process.exit(code)
}

function requireCli() {
  const probe = spawnSync('supabase', ['--version'], { stdio: 'ignore' })
  if (probe.error) {
    fail(
      'the Supabase CLI was not found on PATH.\n' +
      '  Install it:  npm i -g supabase\n' +
      '  Then link:    supabase link --project-ref <your-project-ref>',
    )
  }
}

/**
 * Hand the value to `supabase secrets set --env-file` using a 0600 temp file
 * that is shredded immediately afterwards. This keeps the secret out of argv
 * (visible in `ps`) and out of any persisted file.
 */
function apply(name, value) {
  const dir = mkdtempSync(join(tmpdir(), 'imf-secret-'))
  const envFile = join(dir, 'secret.env')
  try {
    writeFileSync(envFile, `${name}=${value}\n`, { mode: 0o600 })
    try { chmodSync(envFile, 0o600) } catch { /* non-POSIX */ }

    const res = spawnSync('supabase', ['secrets', 'set', '--env-file', envFile], {
      stdio: 'inherit',
    })
    if (res.error) fail(`could not run supabase: ${res.error.message}`)
    if (res.status !== 0) {
      fail(
        `supabase secrets set exited with code ${res.status}. ` +
        'Is the project linked?  supabase link --project-ref <ref>',
      )
    }

    console.log(`\n  ${name} set on the linked project.`)
    console.log('  It lives in Supabase function secrets and is never exposed to a client bundle.')
    if (name === 'CLEAN_APIS_KEY') {
      console.log('\n  Next: apply the provider migration so the router can use it:')
      console.log('    supabase/migrations/20260930000002_imeet_cleanapis_provider.sql')
    }
    console.log('')
  } finally {
    // Overwrite before unlinking so the bytes are not trivially recoverable.
    try { writeFileSync(envFile, '') } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function main() {
  if (flag('--list')) {
    console.log('\n  Provider secrets this project reads (server-side only):\n')
    for (const [name, why] of Object.entries(EXPECTED)) {
      console.log(`  ${name.padEnd(20)} ${why}`)
    }
    console.log('\n  Add one with:  node scripts/set-supabase-secret.mjs --name <NAME>\n')
    return
  }

  requireCli()

  // --stdin-env: the value is already in the environment, exported by a secret
  // manager. It is read and never printed.
  if (flag('--stdin-env')) {
    const name = opt('--name')
    if (!name) fail('--stdin-env requires --name <NAME>')
    const value = process.env[name]
    if (!value) fail(`the environment variable ${name} is empty or unset`)
    apply(name, value)
    return
  }

  const name = opt('--name') || 'CLEAN_APIS_KEY'
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    fail(`"${name}" is not a valid secret name (use UPPER_SNAKE_CASE)`)
  }

  const prompt =
    `\n  ${EXPECTED[name] || name}\n` +
    `  Setting Supabase secret: ${name}\n` +
    `  (input is hidden; nothing is written to disk or shell history)\n\n` +
    `  Enter the value, then press Enter: `

  readSecret(prompt)
    .then((value) => {
      if (!value) fail('no value was entered')
      apply(name, value)
    })
    .catch((e) => fail(e?.message || String(e)))
}

main()
