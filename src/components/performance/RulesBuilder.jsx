import React from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import {
  ACTIONS,
  OPERATORS,
  VARIABLE_MAP,
  availableVariableKeys,
  variable,
} from '../../domains/performance/rules/index.js'
import { describeRule } from '../../domains/performance/rules/format.js'
import { ConditionValueInput, NumInput, OperatorSelect, SelectInput, VariableSelect } from './controls.jsx'

// ------------------------------------------------------------------
// GENERIC RULE BUILDER
//
// Renders one rule as plain language:
//   WHEN  [variable] [operator] [value(s)]  (AND/OR …)
//   THEN  [action]  [value]
// plus a deterministic sentence preview.
//
// It knows nothing about MPR specifically — the callers supply which
// variables (`variableKeys`), which operators (`operatorOverrides`) and
// which actions (`actionKeys`) are meaningful for their section, and the
// enum option lists (`entityOptions`) for designation/branch-style
// variables.
// ------------------------------------------------------------------
export default function RulesBuilder({
  rule,
  onChange,
  variableKeys = null,
  operatorOverrides = null,
  actionKeys = ['productivity_bonus', 'mobility_allowance', 'create_hr_review_task'],
  entityOptions = {},
  onRemove = null,
  className = '',
}) {
  if (!rule) return null
  if (rule.unsupported) {
    return (
      <div className={`border border-amber-200 bg-amber-50 rounded-lg p-4 ${className}`}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-800">
              This saved rule uses a format this editor cannot represent — it is preserved exactly and will not be altered.
            </p>
            <p className="text-[11px] text-amber-600 font-mono mt-1 break-words">{JSON.stringify(rule.raw || rule)}</p>
          </div>
          {onRemove && (
            <button type="button" onClick={onRemove} className="text-amber-500 hover:text-amber-700">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    )
  }

  const when = rule.when || { mode: 'all', conditions: [] }
  const then = rule.then || { action: actionKeys[0], value: '', unit: actionMeta(actionKeys[0])?.unit }

  const setRule = (next) => onChange(next)
  const patchWhen = (patch) => setRule({ ...rule, when: { ...when, ...patch } })
  const patchThen = (patch) => setRule({ ...rule, then: { ...then, ...patch } })

  const setCondition = (i, patch) => {
    const conditions = when.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c))
    patchWhen({ conditions })
  }
  const removeCondition = (i) => patchWhen({ conditions: when.conditions.filter((_, idx) => idx !== i) })
  const addCondition = () => {
    const first = variableKeys && variableKeys.length ? variableKeys[0] : availableVariableKeys()[0]
    const meta = variable(first)
    const op = meta.operators[3] || meta.operators[0] // default to "is at least" when available
    patchWhen({
      conditions: [...when.conditions, { variable: first, operator: op, value: '', unit: meta.unitKey }],
    })
  }

  // value widget options depend on the current variable
  const entityOptionsFor = (varKey) => {
    const meta = VARIABLE_MAP[varKey] || variable(varKey)
    return entityOptions[meta.optionsType] || []
  }

  const actionMeta = ACTIONS[then.action]

  return (
    <div className={`border border-slate-200 rounded-xl p-4 space-y-3 ${className}`}>
      {/* WHEN */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-14 text-xs font-semibold uppercase tracking-wide text-slate-400">When</span>
          <div className="flex items-center gap-1.5 text-sm text-slate-600">
            <SelectInput
              value={when.mode}
              onChange={(m) => patchWhen({ mode: m })}
              options={[{ value: 'all', label: 'ALL' }, { value: 'any', label: 'ANY' }]}
              placeholder=""
              className={`${'w-24 h-8 text-xs'} appearance-none`}
            />
            <span>of these are true</span>
          </div>
        </div>

        {when.conditions.length === 0 && (
          <p className="pl-14 text-xs text-slate-400">No conditions yet — add one below.</p>
        )}

        {when.conditions.map((cond, i) => {
          const meta = VARIABLE_MAP[cond.variable] || variable(cond.variable)
          const ops = operatorOverrides && operatorOverrides[cond.variable] ? operatorOverrides[cond.variable] : meta.operators
          return (
            <div key={i} className="pl-14">
              <div className="flex items-center gap-2 flex-wrap bg-slate-50 border border-slate-200 rounded-lg p-2">
                <VariableSelect
                  value={cond.variable}
                  allowed={variableKeys}
                  onChange={(v) => {
                    const m = variable(v)
                    setCondition(i, { variable: v, operator: m.operators[3] || m.operators[0], value: '', value2: '', unit: m.unitKey })
                  }}
                />
                <OperatorSelect variableKey={cond.variable} value={cond.operator} allowedOperators={ops} onChange={(op) => setCondition(i, { operator: op })} />
                <ConditionValueInput
                  variableKey={cond.variable}
                  operator={cond.operator}
                  value={cond.value}
                  value2={cond.value2}
                  unitKey={cond.unit}
                  options={entityOptionsFor(cond.variable)}
                  onChange={(patch) => setCondition(i, patch)}
                />
                <button type="button" onClick={() => removeCondition(i)} className="text-slate-300 hover:text-rose-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">{operatorsSentence(meta, ops, cond.variable)}</div>
            </div>
          )
        })}

        <div className="pl-14">
          <button
            type="button"
            onClick={addCondition}
            className="inline-flex items-center gap-1 text-sm text-[#009944] hover:text-[#007a36] font-medium"
          >
            <Plus className="w-4 h-4" /> Add condition
          </button>
        </div>
      </div>

      {/* THEN */}
      <div className="space-y-2">
        <span className="w-14 inline-block text-xs font-semibold uppercase tracking-wide text-slate-400">Then</span>
        <div className="flex items-center gap-2 flex-wrap bg-emerald-50/60 border border-emerald-100 rounded-lg p-2">
          <SelectInput
            value={then.action}
            onChange={(a) => patchThen({ action: a, value: '', unit: actionMeta(a)?.unit })}
            options={actionKeys.map((k) => ({ value: k, label: ACTIONS[k]?.label || k }))}
            placeholder="Action…"
            className="min-w-[12rem]"
          />
          {actionMeta && actionMeta.unit && (
            <ActionValueInput action={then.action} unit={actionMeta.unit} value={then.value} onChange={(v) => patchThen({ value: v })} />
          )}
        </div>
      </div>

      {/* SENTENCE PREVIEW */}
      <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-sm text-slate-600 italic">
        {describeRule(rule, entityOptions) || 'Complete the rule to see a plain-language preview.'}
      </div>
    </div>
  )
}

function operatorsSentence(meta, ops, variableKey) {
  const suffix = (UNITS_TEXT[meta.unitKey]) || ''
  const opText = ops.length ? ops.map((k) => OPERATORS[k]?.label).filter(Boolean).join(', ') : ''
  return `Uses ${opText || 'standard'} comparison(s)${suffix ? ` — entered as ${suffix}` : ''}.`
}

function ActionValueInput({ action, unit, value, onChange }) {
  if (unit === 'percent_of_gross_salary') {
    return <NumInput value={value} onChange={onChange} suffix="% of Gross Salary" className="min-w-[9rem]" />
  }
  if (unit === 'naira') {
    return <NumInput value={value} onChange={onChange} prefix="₦" className="min-w-[9rem]" />
  }
  return null
}

const UNITS_TEXT = {
  percent: 'a percentage',
  percent_of_gross_salary: 'a percentage of gross salary',
  naira: 'Naira (₦)',
  count: 'a plain number',
  employees: 'the number of employees',
  months: 'number of months',
  days: 'number of days',
  points: 'score points',
  ratio: 'a ratio',
  yes_no: 'Yes / No',
}