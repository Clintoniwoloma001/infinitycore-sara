import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const base = readFileSync(join(root, 'schema_phase26_hr_master_data.sql'), 'utf8')
const seed = readFileSync(join(root, 'scripts', 'generated', 'phase26_staff_seed.sql'), 'utf8')
const marker = '-- @@PHASE26_STAFF_SEED@@'
const out = base.replace(marker, seed)
writeFileSync(join(root, 'schema_phase26_hr_master_data.sql'), out)
console.log(`Embed ${seed.length} bytes into schema_phase26_hr_master_data.sql`)
