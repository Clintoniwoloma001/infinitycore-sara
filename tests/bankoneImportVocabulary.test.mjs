// ===========================================================================
// BankOne portfolio import — the batch vocabulary must match the importer.
//
// Regression guard for the production failure:
//   "new row for relation bankone_import_batches violates check constraint
//    bankone_import_batches_operation_type_check"
// which stopped EVERY Portfolio At Risk / Disbursement upload.
//
// The behavioural proof is the transaction replay recorded in the migration
// notes; this suite locks the contract so the vocabulary and the writer cannot
// drift apart again.
// ===========================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const migration = read('supabase/migrations/20260931000001_bankone_import_batch_vocabulary.sql')
const service = read('src/services/bankonePortfolioService.js')
const legacyCheck = read('schema_phase9_integrated_operations.sql')

/** Parse the allow-list actually declared by a named CHECK constraint. */
const allowList = (src, constraint) => {
  const block = src.slice(src.indexOf(`add constraint ${constraint}`))
  const inner = block.slice(block.indexOf('check ('), block.indexOf('));'))
  return [...inner.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

const operationTypes = (src) =>
  allowList(src, 'bankone_import_batches_operation_type_check')
const statuses = (src) => allowList(src, 'bankone_import_batches_status_check')

describe('operation_type vocabulary', () => {
  test('admits the values the importer actually writes', () => {
    const allowed = operationTypes(migration)
    for (const v of ['par', 'disbursement', 'portfolio']) {
      assert.ok(allowed.includes(v), `operation_type must allow '${v}'`)
    }
  })

  test('keeps every legacy value valid so old batches are not broken', () => {
    for (const v of operationTypes(legacyCheck)) {
      assert.ok(operationTypes(migration).includes(v), `legacy '${v}' must survive`)
    }
  })

  test('still rejects an unknown operation_type', () => {
    assert.ok(!operationTypes(migration).includes('anything_goes'))
    assert.match(migration, /add constraint bankone_import_batches_operation_type_check/)
  })

  test('backfills out-of-vocabulary rows before re-validating', () => {
    // Without this the ADD CONSTRAINT would fail on a pre-existing bad row.
    assert.match(migration, /set operation_type = 'generic'[\s\S]*?not in \(/)
  })
})

describe('status vocabulary', () => {
  test('admits the review states the importer writes', () => {
    for (const v of ['pending_review', 'approved', 'rejected']) {
      assert.ok(statuses(migration).includes(v), `status must allow '${v}'`)
    }
  })

  test('keeps every legacy status valid', () => {
    for (const v of ['preview', 'importing', 'completed', 'completed_with_warnings', 'failed']) {
      assert.ok(statuses(migration).includes(v), `legacy status '${v}' must survive`)
    }
  })
})

describe('the writer and the schema agree', () => {
  test('every literal the service writes for operation_type is allowed', () => {
    const allowed = operationTypes(migration)
    // Read the ONE expression assigned to operation_type, up to the next key.
    const start = service.indexOf('operation_type:')
    const expr = service.slice(start, service.indexOf(',', start))
    const literals = [...expr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    assert.ok(literals.length > 0, 'expected a literal operation_type in the service')
    for (const l of literals) {
      assert.ok(allowed.includes(l), `service writes '${l}' which the CHECK rejects`)
    }
  })

  test('the service no longer hardcodes the rejected "portfolio" value', () => {
    assert.ok(
      !/operation_type:\s*'portfolio'/.test(service),
      'createImport must not hardcode operation_type: portfolio',
    )
  })

  test('the service status literal is admitted by the CHECK', () => {
    const m = service.match(/status:\s*'([a-z_]+)'/)
    assert.ok(m, 'expected a status literal in createImport')
    assert.ok(statuses(migration).includes(m[1]),
      `service writes status '${m[1]}' which the CHECK rejects`)
  })

  test('setImportStatus only writes admitted status values', () => {
    const allowed = statuses(migration)
    assert.ok(allowed.includes('approved') && allowed.includes('rejected'))
  })

  test('the columns setImportStatus writes exist', () => {
    assert.match(migration, /add column if not exists confirmed_by/)
    assert.match(migration, /add column if not exists confirmed_at/)
  })
})

describe('RLS for the import path', () => {
  test('unresolved officers can be inserted, not only read', () => {
    // They had a SELECT policy only, so the rows HR must resolve were dropped.
    assert.match(migration, /create policy "bankone_unresolved_officers_insert"/)
    assert.match(migration, /for insert to authenticated/)
    assert.match(migration, /with check \(public\.can_manage_bankone\(\)\)/)
  })

  test('the batch insert is role gated', () => {
    assert.match(migration, /create policy "bankone_batches insert"/)
    assert.match(migration, /with check \(public\.can_manage_bankone\(\)\)/)
  })
})

describe('migration safety', () => {
  test('is transaction wrapped, idempotent and non-destructive', () => {
    assert.match(migration, /^begin;/m)
    assert.match(migration, /^commit;/m)
    assert.match(migration, /drop constraint if exists bankone_import_batches_operation_type_check/)
    assert.match(migration, /drop constraint if exists bankone_import_batches_status_check/)
    assert.ok(!/drop table/i.test(migration), 'no table may be dropped')
    assert.ok(!/delete from/i.test(migration), 'no row may be deleted')
  })
})
