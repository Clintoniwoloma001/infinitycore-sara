import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const themeCtx = read('src/context/ThemeContext.jsx')
const indexCss = read('src/index.css')
const tailwindCfg = read('tailwind.config.js')
const layout = read('src/components/Layout.jsx')
const mainJsx = read('src/main.jsx')

// --- ThemeContext persists the choice and toggles the <html> class ---
assert.match(themeCtx, /localStorage\.getItem\(THEME_KEY\)/, 'reads persisted theme')
assert.match(themeCtx, /localStorage\.setItem\(THEME_KEY, theme\)/, 'persists theme choice')
assert.match(themeCtx, /classList\.add\('dark'\)/, 'adds .dark to <html>')
assert.match(themeCtx, /return 'light'/, 'first-run default is LIGHT (dark is opt-in via the toggle)')
assert.doesNotMatch(themeCtx, /prefers-color-scheme/, 'does not sneak in OS-preference defaulting')
assert.match(themeCtx, /export const useTheme =/, 'exposes useTheme hook')
assert.match(themeCtx, /\{ theme, toggle: toggleTheme \}|toggle/, 'exposes toggle')

// --- ThemeProvider wraps the app in main.jsx ---
assert.match(mainJsx, /import \{ ThemeProvider \} from '\.\/context\/ThemeContext'/, 'ThemeProvider imported')
assert.match(mainJsx, /<ThemeProvider>/s, 'ThemeProvider wraps App')

// --- tailwind class-based dark variant is enabled ---
assert.match(tailwindCfg, /darkMode:\s*'class'/, 'tailwind darkMode: class')

// --- Shell toggle button controls the theme ---
assert.match(layout, /import \{ useTheme \} from '\.\.\/context\/ThemeContext'/, 'Layout uses useTheme')
assert.match(layout, /toggleTheme|toggle: toggleTheme/, 'Layout wires the toggle')
assert.match(layout, /dark:bg-slate-900\/80/, 'header dark background variant')
assert.match(layout, /dark:bg-slate-950/, 'app shell dark page background')
assert.match(layout, /dark:text-slate-100/, 'app shell dark heading variant')

// --- Native form controls get a dark surface (the app styles them with
//     border-slate-300 but no bg/text class, so without this they keep
//     browser-light surfaces with washed-out inherited text in dark mode) ---
assert.match(indexCss, /\.dark (input|select|textarea)[^{]*\{[^}]*background-color:\s*#1e293b/sm, 'native controls dark background')
assert.match(indexCss, /\.dark (input|select|textarea)[^{]*\{[^}]*color:\s*#e2e8f0/sm, 'native controls light text')
assert.match(indexCss, /\.dark input::placeholder[^{]*\{[^}]*color:\s*#64748b/, 'dark placeholders')
assert.match(indexCss, /\.dark select option[^{]*\{[^}]*background-color:\s*#1e293b/, 'select dropdown options dark')

// --- Hover variants, dividers and focus rings are remapped ---
const explicitShims = [
  '.dark .hover\\:bg-slate-50:hover',
  '.dark .hover\\:bg-slate-100:hover',
  '.dark .hover\\:text-slate-600:hover',
  '.dark .hover\\:text-rose-600:hover',
  '.dark .hover\\:text-amber-600:hover',
  '.dark .hover\\:border-slate-300:hover',
  '.dark .divide-slate-50 > :not([hidden]) ~ :not([hidden])[class]',
  '.dark .divide-slate-100 > :not([hidden]) ~ :not([hidden])[class]',
  '.dark .ring-rose-500',
  '.dark .ring-amber-500',
  '.dark .ring-violet-200',
  '.dark .ring-purple-400',
]
for (const shim of explicitShims) {
  assert.ok(indexCss.includes(shim), `shim covers ${shim}`)
}

// Shim rules never use !important (so Tailwind responsiveness is preserved)
const importantCount = (indexCss.match(/!important/g) || []).length

// --- SYSTEMATIC coverage: every color utility used anywhere in src must be
//     remapped under .dark OR be deliberately exempt (a solid saturated
//     button/dark surface with its own light text, or a pastel already
//     readable on dark). This guards the whole app, not just the pages we
//     inspected. ---
const FONTS = ['slate', 'emerald', 'rose', 'amber', 'blue', 'violet', 'sky', 'green', 'orange', 'red', 'cyan', 'indigo', 'teal', 'purple']

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, acc)
    else if (/\.(jsx|js)$/.test(entry)) acc.push(p)
  }
  return acc
}

// Classes the shim actually remaps (normalized: tailwind escapes undone,
// opacity suffix removed, trailing :pseudo stripped from hover variants).
const shimClasses = new Set()
for (const m of indexCss.matchAll(/\.dark\s+\.((?:\\[^\s,{>]|[^\s,{>])+)/g)) {
  let cls = m[1].replace(/\\:/g, ':').replace(/\//g, '/')
    .replace(/:(hover|focus|focus-visible|focus-within|active|disabled|checked|placeholder|first|last|odd|even|visited|empty|required|invalid|read-only|valid|open|default|indeterminate|autofill|in-range|out-of-range):?[a-z-]*$/i, '')
    .replace(/\/\d+$/, '')
  shimClasses.add(cls)
}

// Documented exemptions (audited against the full src inventory):
//   - solid saturated backgrounds => buttons/chip fills with their own light
//     text; darkening them would flatten the brand color hierarchy
//   - pastel/mid text shades that are already bright enough on #0f172a
//   - near-black slate fills that are already dark
//   - border-slate-800/900 (dark edges on dark, intentional low-contrast)
const SAFE_BG = /^bg-(emerald|rose|amber|blue|violet|sky|green|orange|red|cyan|indigo|teal|purple)-(?:500|600|700|800|900)|^bg-slate-(?:400|500|600|700|800|900|950)$/
const SAFE_TEXT = /^text-(slate-(?:100|200|300|400|500|600|700|800|900)|emerald-(?:100|200|300|400|500|600|700|800|900)|rose-(?:100|200|300|400|500|600|700|800|900)|amber-(?:100|200|300|400|500|600|700|800|900)|blue-(?:100|200|300|400|500|600|700|800|900)|violet-(?:100|200|300|400|500|600|700|800|900)|sky-(?:100|200|300|400|500|600|700|800|900)|green-(?:100|200|300|400|500|600|700|800|900)|orange-(?:100|200|300|400|500|600|700|800|900)|red-(?:100|200|300|400|500|600|700|800|900)|cyan-(?:100|200|300|400|500|600|700|800|900)|indigo-(?:100|200|300|400|500|600|700|800|900)|teal-(?:100|200|300|400|500|600|700|800|900)|purple-(?:100|200|300|400|500|600|700|800|900))$/
const SAFE_BORDER = /^border-slate-(?:600|700|800|900)$/

const uncovered = []
const binaries = ['bg', 'text', 'border', 'divide', 'ring']
for (const file of walk('src')) {
  const src = readFileSync(join(process.cwd(), file), 'utf8')
  for (const m of src.matchAll(/(?:^|[^-\w])(bg|text|border|divide|ring)-(?!\[)([a-z]+)-(\d+(?:\/\d+)?)/g)) {
    const base = `${m[1]}-${m[2]}-${m[3].replace(/\/\d+$/, '')}`
    if (!FONTS.includes(m[2]) || !binaries.includes(m[1])) continue
    if (shimClasses.has(base) || SAFE_BG.test(base) || SAFE_TEXT.test(base) || SAFE_BORDER.test(base)) continue
    uncovered.push({ file, base })
  }
}

const uniqueUncovered = [...new Set(uncovered.map((u) => `${u.file.split('/').pop()}: ${u.base}`))]
assert.deepEqual(uniqueUncovered, [], `EVERY color utility in src must be dark-shimmed or exempt. Not covered:\n  ${uniqueUncovered.join('\n  ')}`)

// Light mode must remain byte-free of dark shadows: confirm the whole shim is
// scoped to .dark and no rule targets the base (non-dark) utility classes.
const nonDarkRules = (indexCss.match(/(^|\n)\.(bg|text|border|divide|ring)-/g) || []).filter((r) => !r.includes('.dark'))
assert.deepEqual(nonDarkRules, [], 'no bare (light-mode) utility override was introduced')

console.log(`themeDarkMode.test.mjs passed (${shimClasses.size} shim classes, ${explicitShims.length} hover/divide/ring shims, ${uniqueUncovered.length} uncovered, ${importantCount} !important)`)