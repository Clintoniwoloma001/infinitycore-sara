import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { getEmployeeCategory, balanceFor } from '../src/domains/leave/entitlements.js'

describe('leave entitlement policy', () => {
  test('getEmployeeCategory: MD/CEO is top tier', () => {
    assert.equal(getEmployeeCategory({ position: 'MD/CEO' }), 'md')
    assert.equal(getEmployeeCategory({ designation: 'MD / CEO' }), 'md')
  })

  test('getEmployeeCategory: standalone MD and Managing Director are management', () => {
    assert.equal(getEmployeeCategory({ position: 'MD' }), 'management_staff')
    assert.equal(getEmployeeCategory({ position: 'Managing Director' }), 'management_staff')
  })

  test('getEmployeeCategory: any HEAD designation is management', () => {
    assert.equal(getEmployeeCategory({ position: 'HEAD OF HR' }), 'management_staff')
    assert.equal(getEmployeeCategory({ designation: 'Head of Operations' }), 'management_staff')
  })

  test('getEmployeeCategory: everyone else is normal staff', () => {
    assert.equal(getEmployeeCategory({ position: 'Loan Officer' }), 'normal_staff')
    assert.equal(getEmployeeCategory({}), 'normal_staff')
  })
})

describe('balanceFor with override fields', () => {
  test('uses effective_entitlement when available', () => {
    const balances = [{ leave_type: 'annual', effective_entitlement: 15, used_days: 3, pending_days: 1 }]
    const result = balanceFor(balances, 'annual')
    assert.equal(result.entitled_days, 15)
    assert.equal(result.remaining, 11)
  })

  test('falls back to entitled_days when effective_entitlement is missing', () => {
    const balances = [{ leave_type: 'annual', entitled_days: 10, used_days: 2 }]
    const result = balanceFor(balances, 'annual')
    assert.equal(result.entitled_days, 10)
    assert.equal(result.remaining, 8)
  })

  test('unpaid leave has no cap', () => {
    const result = balanceFor([], 'unpaid')
    assert.equal(result.entitled_days, null)
    assert.equal(result.remaining, Infinity)
  })

  test('falls back to constants when row is missing', () => {
    const result = balanceFor([], 'maternity')
    assert.equal(result.entitled_days, 90)
    assert.equal(result.remaining, 90)
  })
})
