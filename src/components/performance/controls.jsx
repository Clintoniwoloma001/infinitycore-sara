import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { OPERATORS, UNITS, VARIABLES, variable } from '../../domains/performance/rules/index.js'

export const inputCls =
  'w-full h-9 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] focus:border-[#009944] disabled:bg-slate-50'
export const labelCls = 'block text-xs font-medium text-slate-500 mb-1'
export const selectCls = `${inputCls} pr-8 appearance-none cursor-pointer bg-white`

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className={labelCls}>{label}</span>}
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  )
}

export function TextInput({ value, onChange, placeholder, className = inputCls, disabled }) {
  return (
    <input
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
    />
  )
}

export function SelectInput({ value, onChange, options = [], placeholder = 'Select…', className = selectCls, allowEmpty = false }) {
  return (
    <div className="relative">
      <select
        className={className}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((o) => {
          const opt = typeof o === 'object' ? o : { value: o, label: o }
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          )
        })}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
    </div>
  )
}

// Numeric input that keeps the raw typed text locally but always emits a
// number (or '' when cleared). suffix/prefix make the unit unmistakable.
export function NumInput({ value, onChange, suffix, prefix, placeholder, step = 'any', className = inputCls, disabled, min }) {
  const [text, setText] = useState(() => display(value))

  useEffect(() => {
    setText(display(value))
  }, [value])

  const commit = (raw) => {
    setText(raw)
    const t = String(raw).trim()
    if (t === '') {
      onChange('')
      return
    }
    const n = Number(t)
    onChange(Number.isFinite(n) ? n : t)
  }

  return (
    <div className="flex items-stretch">
      {prefix && (
        <span className="inline-flex items-center px-2.5 rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 text-sm text-slate-500">
          {prefix}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        step={step}
        min={min}
        className={`${className} ${prefix ? 'rounded-l-none' : ''} ${suffix ? 'rounded-r-none' : ''}`}
        value={text}
        onChange={(e) => commit(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {suffix && (
        <span className="inline-flex items-center px-2.5 rounded-r-lg border border-l-0 border-slate-300 bg-slate-50 text-sm text-slate-500 whitespace-nowrap">
          {suffix}
        </span>
      )}
    </div>
  )
}

function display(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000000) / 1000000) : ''
  return String(value)
}

// ---- unit-aware value input driven entirely by variable metadata -------
export function ConditionValueInput({ variableKey, operator, value, value2, unitKey, onChange, options = [] }) {
  const meta = variable(variableKey)
  const unit = unitKey || meta.unitKey || 'count'
  const isBetween = operator === 'between'
  const edit = (which, next) => onChange({ ...(isBetween ? { value, value2 } : { value }), [which]: next })

  if (isBetween) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <UnitAwareInput value={value} onChange={(v) => edit('value', v)} meta={meta} unit={unit} options={options} placeholder="Low" />
        <span className="text-slate-400 text-sm">and</span>
        <UnitAwareInput value={value2} onChange={(v) => edit('value2', v)} meta={meta} unit={unit} options={options} placeholder="High" />
      </div>
    )
  }
  return <UnitAwareInput value={value} onChange={(v) => onChange({ value: v })} meta={meta} unit={unit} options={options} />
}

export function UnitSuffix({ unit }) {
  const u = UNITS[unit]
  if (!u) return null
  return <span className="text-[11px] text-slate-400 whitespace-nowrap">{u.suffix || ''}</span>
}

function UnitAwareInput({ value, onChange, meta, unit, options = [], placeholder }) {
  if (meta.valueType === 'enum') {
    return (
      <SelectInput
        value={value ?? ''}
        onChange={onChange}
        options={options}
        placeholder={placeholder || 'Choose…'}
      />
    )
  }
  if (meta.valueType === 'boolean') {
    return (
      <SelectInput
        value={value === true || value === 'true' ? 'Active' : value ? 'Active' : value === false || value === 'false' ? 'Inactive' : ''}
        onChange={(v) => onChange(v === 'Active')}
        options={[{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }]}
        placeholder="Choose…"
      />
    )
  }
  if (meta.valueType === 'ratio' || unit === 'ratio') {
    return <TextInput value={value ?? ''} onChange={onChange} placeholder={placeholder || 'e.g. 1:10'} className={`${inputCls} min-w-[7rem]`} />
  }
  const naira = unit === 'naira' || meta.unitKey === 'naira' || meta.valueType === 'currency'
  return (
    <NumInput
      value={value}
      onChange={onChange}
      prefix={naira ? '₦' : undefined}
      suffix={!naira ? unitSuffixText(unit) : undefined}
      placeholder={placeholder}
      className="min-w-[7rem]"
    />
  )
}

function unitSuffixText(unit) {
  const u = UNITS[unit]
  return (u && u.suffix) || undefined
}

// ------------------------------------------------------- variable/operator
export function VariableSelect({ value, onChange, allowed = null, placeholder = 'Variable…' }) {
  const list = VARIABLES.filter((v) => (allowed ? allowed.includes(v.key) : v.available))
  return (
    <SelectInput
      value={value ?? ''}
      onChange={onChange}
      options={list.map((v) => ({ value: v.key, label: v.label }))}
      placeholder={placeholder}
      className={`${selectCls} min-w-[10rem]`}
    />
  )
}

export function OperatorSelect({ variableKey, value, onChange, allowedOperators = null }) {
  const meta = variable(variableKey)
  const ops = allowedOperators || meta.operators || []
  return (
    <SelectInput
      value={value ?? ''}
      onChange={onChange}
      options={ops.map((k) => ({ value: k, label: OPERATORS[k]?.label || k }))}
      placeholder="Operator…"
      className={`${selectCls} min-w-[9rem]`}
    />
  )
}

// -------------------------------------------------------- searchable multi
export function EntityMultiSelect({ options = [], value = [], onChange, placeholder = 'Search designations…', hint }) {
  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState('')
  const selected = value || []

  const toggle = (val) => {
    const next = selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]
    onChange(next)
  }

  const addCustom = () => {
    const t = custom.trim().toUpperCase()
    if (!t) return
    if (!selected.includes(t)) onChange([...selected, t])
    setCustom('')
  }

  const available = useMemo(() => {
    const q = query.trim().toLowerCase()
    const known = (options || []).filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
    return known
  }, [options, query])

  const extraSelected = selected.filter((s) => !(options || []).some((o) => o.value === s))

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
        <Search className="w-4 h-4 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm focus:outline-none"
        />
      </div>
      <div className="p-2 flex flex-wrap gap-1.5">
        {selected.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs">
            {s}
            <button type="button" onClick={() => toggle(s)} className="text-emerald-500 hover:text-emerald-700">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="max-h-44 overflow-y-auto border-t border-slate-100">
        {available.length === 0 && !query && extraSelected.length === 0 && (
          <p className="px-3 py-3 text-xs text-slate-400">No designations available.</p>
        )}
        {available.map((o) => (
          <label key={o.value} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-sm">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} className="accent-[#009944]" />
            <span className="text-slate-700">{o.label}</span>
          </label>
        ))}
        {query && (
          <button type="button" onClick={addCustom} className="w-full text-left px-3 py-1.5 text-xs text-[#009944] hover:bg-emerald-50">
            + Use “{query.trim().toUpperCase()}” (custom)
          </button>
        )}
      </div>
      {!query && extraSelected.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-2">
          <p className="text-[11px] text-slate-400 mb-1">Also included (not in master list):</p>
          {extraSelected.map((s) => (
            <label key={s} className="flex items-center gap-2 py-0.5 cursor-pointer text-sm">
              <input type="checkbox" checked onChange={() => toggle(s)} className="accent-[#009944]" />
              <span className="text-slate-700">{s}</span>
            </label>
          ))}
        </div>
      )}
      {hint && <p className="px-3 py-2 text-[11px] text-slate-400 border-t border-slate-100">{hint}</p>}
    </div>
  )
}

// -------------------------------------------------------------- frequency
export function FrequencySelect({ value, onChange }) {
  return (
    <SelectInput
      value={value ?? ''}
      onChange={onChange}
      options={[{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }]}
      placeholder="Frequency…"
      className={selectCls}
    />
  )
}