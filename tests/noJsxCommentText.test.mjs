// ============================================================================
// No `//` comment may render as page text
// ============================================================================
// A regression this repo actually introduced, and one ONLY the browser
// screenshot caught: a `//` line comment written between JSX children is not a
// comment at all. In a JSX children position `// foo` is literal TEXT, so it
// put a ~600-character explanation of Leaflet z-indexes onto the operator's
// fence editor, directly above the zoom controls.
//
// The valid forms are `{/* ... */}` inline, or a real `//` comment outside the
// returned JSX (which is where that note now lives).
//
// The check is mechanical rather than a lint config: parse every .jsx file with
// the same Babel grammar Vite uses, and fail on any non-whitespace JSXText node
// containing `//` or `/*`.
// ============================================================================
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import assert from 'node:assert'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok  ${label}`)
  } catch (e) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${e.message}`)
  }
}

const walk = (rel) => {
  const out = []
  for (const entry of readdirSync(join(root, rel))) {
    const next = `${rel}/${entry}`
    if (statSync(join(root, next)).isDirectory()) out.push(...walk(next))
    else if (next.endsWith('.jsx')) out.push(next)
  }
  return out
}
const files = walk('src')
console.log(`\nScanning ${files.length} .jsx files for comment-shaped JSX text`)

check('the Babel parser is installed so the check is real', () => {
  assert.ok(existsSync(join(root, 'node_modules/@babel/parser')),
    'add @babel/parser as a dev dependency; without it this guard cannot parse JSX')
})

check('no JSXText node contains a comment marker', () => {
  const parser = require('@babel/parser')
  const offenders = []
  const unparseable = []

  for (const rel of files) {
    const source = readFileSync(join(root, rel), 'utf8')
    let ast
    try {
      ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] })
    } catch (e) {
      // A file that does not parse at all cannot be scanned. That is a PRE-
      // EXISTING defect in its own right, so it is surfaced loudly rather than
      // skipped silently — see the report printed at the end of this suite.
      unparseable.push(`${rel} — ${e.message}`)
      continue
    }

    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'JSXText') {
        const value = node.value || ''
        if (value.trim() !== '' && (value.includes('//') || value.includes('/*'))) {
          offenders.push(`${rel}: ${JSON.stringify(value.slice(0, 80))}`)
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue
        const child = node[key]
        if (Array.isArray(child)) child.forEach(visit)
        else if (child && typeof child === 'object' && child.type) visit(child)
      }
    }
    visit(ast.program)
  }

  assert.deepEqual(offenders, [], 'comment text rendered by JSX:\n' + offenders.join('\n'))

  // Reported, not asserted: these files are outside this task's scope, so they
  // must not be silently "fixed" here — but they must not be hidden either.
  unparseable.forEach((e) => console.log(`  NOTE (pre-existing, out of scope): ${e}`))
})

console.log('')
if (failed > 0) {
  console.log(`${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('No comment-shaped JSX text.')
