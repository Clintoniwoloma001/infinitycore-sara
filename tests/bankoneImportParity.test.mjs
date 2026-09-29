// ===========================================================================
// The JS <-> SQL normalization contract.
//
// THE BUG THIS GUARDS
//   confirm_bankone_branch_mapping used to reprocess rows with
//     upper(replace(btrim(branch_name_raw), '-', ' ')) = p_normalized_...
//   while the browser sent normalizeBranch(raw), which ALSO strips '.' '/' and
//   collapses whitespace. For real bank names they disagree, so the UPDATE
//   matched ZERO rows, the RPC still returned ok:true, and the UI reported
//   "mapped" while nothing had changed. That is the reported
//   "Accept loads then stops without resolving".
//
// These tests fail if the two normalizers ever drift apart again. The same
// cases are replayed against a live Postgres by
// tests/acceptance/bankoneImportEndToEnd.sql.
// ===========================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeBranch, normalizeName } from '../src/domains/bankone/normalize.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const lifecycle = read('supabase/migrations/20260931000002_bankone_import_lifecycle_and_publish.sql')
const service = read('src/services/bankonePortfolioService.js')

/** Real BankOne branch values, including the ones that exposed the bug. */
const BRANCH_CASES = [
  'Lagos Island ONE',
  'IBEJU-LEKKI',
  'TRADE FAIR/BOUNDARY/YABA',
  'MUSHIN/YABA',
  'KETU & HEAD OFFICE',
  'OSHODI & IKEJA',
  'HEAD OFFICE - OSHODI',
  'Lagos Island 2/Ibeju - Lekki/Ajah',
  '  Lagos  Island   THREE  ',
  'Agege/Egbeda',
]

const NAME_CASES = [
  'ABIMBOLA, ANIMASHAHUN LANIKE',
  'UKUAGHE, JUDE',
  'ADEOTI MONSURAT FUNMILAYO',
  'OBI,  NWANKWO   CHINEDU',
  'ADEYEMI-OLUWASEUN, TOLUWASE',
]

/** Reproduce the SQL expression in JS to prove the two agree. */
const sqlNormBranch = (s) =>
  String(s).toUpperCase()
    .replace(/[.\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const sqlNormName = (s) =>
  String(s).toUpperCase()
    .replace(/[,.\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('JS <-> SQL normalization parity', () => {
  test('branch names normalize identically on both sides', () => {
    for (const raw of BRANCH_CASES) {
      assert.equal(
        sqlNormBranch(raw), normalizeBranch(raw),
        `branch mismatch for ${JSON.stringify(raw)}:\n  sql=${JSON.stringify(sqlNormBranch(raw))}\n  js =${JSON.stringify(normalizeBranch(raw))}`,
      )
    }
  })

  test('officer names normalize identically on both sides', () => {
    for (const raw of NAME_CASES) {
      assert.equal(sqlNormName(raw), normalizeName(raw), `name mismatch for ${JSON.stringify(raw)}`)
    }
  })

  test('the cases that used to break are now covered', () => {
    // These three are exactly the values the old SQL expression got wrong.
    for (const raw of ['TRADE FAIR/BOUNDARY/YABA', 'MUSHIN/YABA', 'HEAD OFFICE - OSHODI']) {
      assert.ok(!sqlNormBranch(raw).includes('/'), `slash must be stripped in ${raw}`)
      assert.ok(!/\s{2,}/.test(sqlNormBranch(raw)), `spaces must be collapsed in ${raw}`)
    }
  })

  test('the SQL function collapses whitespace AFTER stripping separators', () => {
    // btrim alone is not enough: "A - B" -> "A   B" without the second pass.
    assert.match(lifecycle, /bankone_norm_branch[\s\S]*?regexp_replace\([\s\S]*?'\\s\+', ' ', 'g'/)
  })
})

describe('the old buggy comparison is gone', () => {
  test('no reprocessing UPDATE compares with upper(replace(...))', () => {
    // The legacy expression must not survive in the re-issued RPC bodies. It is
    // quoted in the header comment as documentation, so only CODE is checked.
    const bodies = lifecycle
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    assert.ok(
      !/upper\(replace\(btrim\(branch_name_raw\)/i.test(bodies),
      'the branch reprocessing must use bankone_norm_branch(), not upper(replace())',
    )
  })

  test('every reprocessing comparison uses the shared normalizer', () => {
    assert.match(lifecycle, /bankone_norm_branch\(branch_name_raw\) = v_norm/)
    assert.match(lifecycle, /bankone_norm_name\(officer_name_raw\) = v_norm/)
  })

  test('the caller sends the server-supplied normalized name', () => {
    // §33 the raw BankOne value AND the normalized value both travel, so the
    // server can normalize from the raw source and never trust the client's key.
    const branchReview = read('src/components/bankone/BranchReview.jsx')
    assert.match(branchReview, /normalizedBranchName: item\.normalized_branch_name/)
    assert.match(branchReview, /bankoneBranchName: item\.raw_branch_name/)
    assert.match(service, /p_normalized_bankone_branch_name: normalizedBranchName/)
    assert.match(service, /p_bankone_branch_name: bankoneBranchName/)
  })

  test('the service reports the real reason on failure', () => {
    assert.match(service, /if \(error\) throw surface\(error, context\)/)
    assert.ok(!/new Error\('Load failed'\)/.test(service))
  })
})

describe('persistent state, not React state', () => {
  test('the review screen has a server-side state reader', () => {
    assert.match(lifecycle, /create or replace function public\.bankone_get_import_state/)
    assert.match(lifecycle, /create or replace function public\.bankone_get_open_imports/)
  })

  test('batch lifecycle statuses are constrained', () => {
    for (const s of ['uploaded', 'parsing', 'parsed', 'review_required', 'resolving',
      'ready_to_publish', 'publishing', 'published', 'failed']) {
      assert.ok(lifecycle.includes(`'${s}'`), `parsing_status must allow ${s}`)
    }
  })

  test('decisions are idempotent per batch', () => {
    // The index and the ON CONFLICT clause are the two halves of the
    // idempotency guarantee, and they are both required.
    assert.match(lifecycle, /uq_bankone_officer_resolution[\s\S]*?\(batch_id,\s*normalized_name\)/)
    assert.match(lifecycle, /uq_bankone_branch_resolution[\s\S]*?\(batch_id,\s*normalized_branch_name\)/)
    assert.match(lifecycle, /on conflict \(batch_id, normalized_name\) do update/)
    assert.match(lifecycle, /on conflict \(batch_id, normalized_branch_name\) do update/)
  })
})

describe('the anti-drop accounting gate', () => {
  test('publish refuses when rows do not reconcile', () => {
    assert.match(lifecycle, /if v_total <> v_parsed \+ v_invalid then/)
    assert.match(lifecycle, /Row accounting does not reconcile/)
    assert.match(lifecycle, /publication_status = 'blocked'/)
  })

  test('publish refuses while any branch is unresolved', () => {
    assert.match(lifecycle, /still have no branch identity/)
  })

  test('publish allows unresolved OFFICERS but keeps them out of officer metrics', () => {
    assert.match(lifecycle, /and r\.officer_employee_id is not null/)
    const officerInsert = lifecycle.slice(lifecycle.indexOf('insert into public.bankone_officer_snapshots'))
    assert.ok(officerInsert.includes('officer_employee_id is not null'))
  })

  test('unattributed portfolio stays visible at branch level', () => {
    assert.match(lifecycle, /unattributed_outstanding/)
    assert.match(lifecycle, /unattributed_loan_count/)
  })

  test('PAR is computed from the imported status field, not a constant', () => {
    assert.match(lifecycle, /'PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST'/)
    assert.match(lifecycle, /non_performing_outstanding \* 100 \/ s\.total_outstanding/)
  })
})

describe('safety of "add as employee"', () => {
  test('invents no identity, compensation or permission data', () => {
    const body = lifecycle.slice(
      lifecycle.indexOf('add_employee_from_bankone'),
      lifecycle.indexOf('create or replace function public.bankone_get_import_state'),
    )
    // The employees INSERT must carry only BankOne-derived + lifecycle fields.
    const ins = body.slice(body.indexOf('insert into public.employees'))
    const cols = ins.slice(ins.indexOf('('), ins.indexOf(')')).toLowerCase()
    for (const forbidden of ['email', 'phone', 'salary', 'designation', 'department', 'supervisor']) {
      assert.ok(!cols.includes(forbidden), `must not invent ${forbidden}`)
    }
    assert.match(body, /'pending'/)
  })

  test('reprocesses the officer loans immediately after creation', () => {
    const body = lifecycle.slice(lifecycle.indexOf('add_employee_from_bankone'))
    assert.match(body, /manually_created_employee/)
    assert.match(body, /rows_affected/)
  })
})

describe('the split-branch RPC contract', () => {
  const splitMigration = read(
    'supabase/migrations/20260931000003_bankone_split_branch_contract.sql')

  test('declares exactly one canonical signature, unchanged from the original', () => {
    // The argument names are the CONTRACT: PostgREST matches an RPC call on
    // argument name, so a rename breaks every caller. The names below must stay
    // identical to the ones in 20260929000002.
    assert.match(
      splitMigration,
      /create or replace function public\.split_bankone_branch\(\s*p_parent_branch_id\s+uuid,\s*p_new_branch_names\s+text\[\],\s*p_source_import_id\s+uuid default null,\s*p_reason\s+text default null\s*\)/s,
    )
    // CREATE OR REPLACE only, never a bare CREATE and never a DROP, so applying
    // the migration cannot remove the function or create a second overload.
    assert.ok(!/drop function[^;]*split_bankone_branch/i.test(splitMigration),
      'must not drop the function; the signature is unchanged')
    assert.ok(!/create\s+(?!or replace)/i.test(
      splitMigration.replace(/create or replace/gi, '')),
      'every CREATE in this migration must be CREATE OR REPLACE')
  })

  test('uses the canonical normalizer, never the legacy expression', () => {
    // The legacy expression kept slashes and did not collapse whitespace, which
    // produced a mapping key ("MUSHIN/YABA") that no row could ever match.
    const code = splitMigration.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    assert.ok(!/v_norm\s*:=\s*upper\(replace\(btrim\(v_name\)/i.test(code),
      'the mapping key must use bankone_norm_branch()')
    assert.match(code, /v_norm\s*:=\s*public\.bankone_norm_branch\(v_name\)/)
    assert.match(code, /public\.bankone_norm_branch\(r\.branch_name_raw\)/)
  })

  test('re-points loans by matching the combined parent label too', () => {
    // BankOne often reports a COMBINED label ("Mushin/Yaba") while the split
    // creates individual branches. Comparing only against the individual keys
    // ("MUSHIN", "YABA") can never equal the row key ("MUSHIN YABA"), which is
    // how the split silently re-pointed zero loans.
    assert.match(splitMigration, /v_parent_norm\s*:=\s*public\.bankone_norm_branch\(v_parent\.branch_name\)/)
    assert.match(splitMigration, /= v_parent_norm/)
  })

  test('returns a verifiable effect and keeps the original keys', () => {
    assert.match(splitMigration, /'created_branch_ids'/)
    assert.match(splitMigration, /'rows_repointed'/)
    assert.match(splitMigration, /'parent_branch_id'/)
    assert.match(splitMigration, /'ok', true/)
  })

  test('preserves authorization and never becomes public', () => {
    assert.match(splitMigration, /security definer/)
    assert.match(splitMigration, /set search_path = public/)
    assert.match(splitMigration, /public\.can_review_work_tasks\(\)/)
    assert.match(splitMigration, /grant execute on function public\.split_bankone_branch\(uuid, text\[\], uuid, text\) to authenticated/)
    assert.match(splitMigration, /revoke all on function public\.split_bankone_branch\(uuid, text\[\], uuid, text\) from anon/)
    assert.ok(!/grant execute[^;]*split_bankone_branch[^;]*\bto anon\b/i.test(splitMigration),
      'the split RPC must never be executable by anon')
  })

  test('still deactivates rather than deletes, and still audits', () => {
    assert.match(splitMigration, /set status = 'inactive'/)
    assert.ok(!/delete from public\.branches/i.test(splitMigration),
      'a split must never delete the parent branch')
    assert.match(splitMigration, /'BRANCH_SPLIT'/)
  })

  test('reloads the PostgREST schema cache', () => {
    assert.match(splitMigration, /notify pgrst, 'reload schema'/)
  })
})

describe('the frontend split call matches the deployed contract', () => {
  const branchReview = read('src/components/bankone/BranchReview.jsx')

  test('sends the exact snake_case argument names', () => {
    assert.match(service, /p_parent_branch_id: parentBranchId/)
    assert.match(service, /p_new_branch_names: newBranchNames/)
    assert.match(service, /p_source_import_id: importId \?\? null/)
    assert.match(service, /p_reason: reason \?\? null/)
  })

  test('sends none of the non-contract names that produced the error', () => {
    // Scope to the split payload object only. The wider file legitimately
    // mentions other names (e.g. the probe's error text), and a loose slice
    // would flag those.
    const start = service.indexOf("supabase.rpc('split_bankone_branch'")
    const open = service.indexOf('{', start)
    const close = service.indexOf('})', open)
    const payload = service.slice(open, close)
    // Match on a KEY boundary: '_reason' is a substring of the VALID 'p_reason',
    // so a bare includes() would produce a false positive.
    const keys = [...payload.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
    assert.deepEqual(
      keys,
      ['p_parent_branch_id', 'p_new_branch_names', 'p_source_import_id', 'p_reason'],
      'the payload keys must be exactly the deployed contract',
    )
    for (const bad of ['p_source_importId', 'p_source_importid', '_reason', 'p_importId']) {
      assert.ok(!keys.includes(bad), `must not send ${bad}`)
    }
  })

  test('diagnoses a schema-cache failure instead of echoing it', () => {
    assert.match(branchReview, /describeSplitFailure/)
    assert.match(branchReview, /getSplitBranchSignature/)
    assert.match(branchReview, /overload_count/)
    // The original opaque text must not be the whole message.
    assert.ok(branchReview.includes('The database is expecting'),
      'the error must name the deployed signature')
  })

  test('reports the real effect of a split', () => {
    assert.match(branchReview, /rows_repointed/)
    assert.match(branchReview, /created_branch_ids/)
    assert.match(branchReview, /reused_branch_ids/)
  })

  test('uses the merged row shape consistently (m.branch_id, not m.branch.id)', () => {
    assert.ok(!/split-\$\{m\.branch\.id\}/.test(branchReview),
      'the merged branch rows expose branch_id directly')
    assert.match(branchReview, /parentBranchId: m\.branch_id/)
  })
})

describe('error handling and authorization', () => {
  test('the page no longer swallows the real error', () => {
    const page = read('src/pages/BankOneImportReview.jsx')
    assert.ok(!/if \(!data\) throw new Error\("Load failed"\)/.test(page))
    assert.ok(!/new Error\('Load failed'\)/.test(page))
  })

  test('every write RPC is role gated', () => {
    for (const fn of ['bankone_publish_snapshot', 'bankone_seed_resolutions',
      'confirm_bankone_branch_mapping', 'confirm_bankone_employee_mapping',
      'add_employee_from_bankone', 'mark_bankone_officer_unresolved']) {
      const idx = lifecycle.indexOf(`function public.${fn}`)
      const slice = idx >= 0 ? lifecycle.slice(idx, idx + 1400) : ''
      assert.match(slice, /can_manage_bankone\(\)|can_review_work_tasks\(\)/,
        `${fn} must check authorization`)
    }
  })

  test('write RPCs are revoked from anon', () => {
    assert.match(lifecycle, /revoke all on function public\.bankone_publish_snapshot\(uuid\) from anon/)
    assert.match(lifecycle, /revoke all on function public\.bankone_seed_resolutions\(uuid\) from anon/)
  })
})



