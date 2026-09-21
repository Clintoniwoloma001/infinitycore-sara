import React, { useMemo } from 'react'
import { Copy, Info, Plus, Trash2 } from 'lucide-react'
import RulesBuilder from './RulesBuilder.jsx'
import ReorderList, { RowHandles } from './ReorderList.jsx'
import {
  EntityMultiSelect,
  Field,
  FrequencySelect,
  NumInput,
  SelectInput,
  TextInput,
} from './controls.jsx'
import { MPR_COMPONENTS } from '../../domains/performance/rules/index.js'
import { describeRule } from '../../domains/performance/rules/format.js'

// ==================================================================
// GENERIC ROW TABLE EDITOR
// Used by every row-based section (MPR components, PAR bands, loan
// ageing, grades, mobility, sanctions, regulatory). Each field's `type`
// decides the widget and its visible unit, so HR never types a symbol.
// ==================================================================
const SUFFIX = { percent: '%', days: ' days', months: ' months', points: ' points', count: ' employees', score: ' points' }

function blankRow(fields) {
  return Object.fromEntries(fields.map((f) => [f.key, f.type === 'text' || f.type === 'select' ? '' : '']))
}

function RowTableEditor({ rows = [], onChange, fields, addLabel = 'Add row', allowReorder = true, designations = [], disabled = false }) {
  const setRow = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i))
  const add = () => onChange([...(rows || []), blankRow(fields)])
  const move = (from, to) => {
    const next = [...rows]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  const renderInput = (row, field) => {
    const opts = typeof field.options === 'function' ? field.options(rows, designations) : field.options || []
    switch (field.type) {
      case 'select':
        return (
          <SelectInput
            value={row[field.key] ?? ''}
            onChange={(v) => setRow(rows.indexOf(row), { [field.key]: v })}
            options={opts}
            placeholder={field.placeholder || 'Choose…'}
          />
        )
      case 'currency':
        return <NumInput value={row[field.key]} onChange={(v) => setRow(rows.indexOf(row), { [field.key]: v })} prefix="₦" placeholder={field.placeholder} className={field.className} />
      case 'text':
        return <TextInput value={row[field.key]} onChange={(v) => setRow(rows.indexOf(row), { [field.key]: v })} placeholder={field.placeholder} className={field.className} disabled={disabled} />
      case 'ratioText':
        return <TextInput value={row[field.key] ?? ''} onChange={(v) => setRow(rows.indexOf(row), { [field.key]: v })} placeholder={field.placeholder || 'e.g. 1:10'} className={field.className} disabled={disabled} />
      default: {
        const suffix = SUFFIX[field.type] || field.suffix
        return (
          <NumInput
            value={row[field.key]}
            onChange={(v) => setRow(rows.indexOf(row), { [field.key]: v })}
            suffix={suffix}
            placeholder={field.placeholder}
            className={field.className}
            disabled={disabled}
          />
        )
      }
    }
  }

  const table = (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-slate-400">Nothing configured yet.</p>}
      {rows.length > 0 && (
        <ReorderList rows={rows} onMove={move} getKey={(r, i) => i} renderRow={(row, i, handles) => (
          <div className="flex items-center gap-2 border border-slate-200 rounded-lg p-2 bg-white">
            {allowReorder && <RowHandles {...handles} />}
            <div className="flex-1 grid gap-x-3 gap-y-2" style={{ gridTemplateColumns: `repeat(${fields.length}, minmax(0,1fr))` }}>
              {fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint} className={f.className}>
                  {renderInput(row, f)}
                </Field>
              ))}
            </div>
            <button type="button" onClick={() => remove(i)} className="text-slate-300 hover:text-rose-500 shrink-0" title="Remove row">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )} />
      )}
      <button type="button" onClick={add} className="inline-flex items-center gap-1 text-sm text-[#009944] hover:text-[#007a36] font-medium">
        <Plus className="w-4 h-4" /> {addLabel}
      </button>
    </div>
  )
}

// ==================================================================
// PER-SECTION EDITORS — presentation only. Every value the user can
// change is written back into the SAME draft the translator owns.
// ==================================================================

export function MprComponentsEditor({ draft, setDraft }) {
  const options = useMemo(() => {
    let out = [...MPR_COMPONENTS]
    const present = new Set(draft.map((r) => String(r.component || '').toUpperCase()))
    const union = new Set(out.map((c) => c.key.toUpperCase()))
    out = [
      ...out,
      ...[...present].filter((c) => !union.has(c)).map((c) => ({ key: c, label: c })),
    ]
    return out.map((c) => ({ value: c.key, label: c.label }))
  }, [draft])
  return (
    <RowTableEditor
      rows={draft}
      onChange={setDraft}
      fields={[
        { key: 'component', label: 'Component', type: 'select', options, placeholder: 'Component…' },
        { key: 'weight', label: 'Weight', type: 'percent', hint: 'Weights must total 100%.' },
      ]}
      addLabel="Add component"
    />
  )
}

export function ParBandsEditor({ draft, setDraft }) {
  return (
    <RowTableEditor
      rows={draft}
      onChange={setDraft}
      fields={[
        { key: 'min_pct', label: 'Minimum PAR', type: 'percent' },
        { key: 'max_pct', label: 'Maximum PAR', type: 'percent', hint: 'Blank = no upper limit.', placeholder: '∞' },
        { key: 'score', label: 'Score', type: 'points' },
      ]}
      addLabel="Add range"
    />
  )
}

const AGEING_CLASSES = ['PERFORMING', 'PASS AND WATCH', 'SUBSTANDARD', 'DOUBTFUL', 'LOST']

export function LoanAgeingEditor({ draft, setDraft }) {
  const options = useMemo(() => {
    const present = new Set(draft.map((r) => String(r.classification || '').trim().toUpperCase()))
    return [...new Set([...AGEING_CLASSES, ...[...present].filter((c) => !AGEING_CLASSES.includes(c))])].map((c) => ({ value: c, label: c }))
  }, [draft])
  return (
    <RowTableEditor
      rows={draft}
      onChange={setDraft}
      fields={[
        { key: 'classification', label: 'Classification', type: 'select', options, placeholder: 'Classification…' },
        { key: 'min_days', label: 'From (days)', type: 'days' },
        { key: 'max_days', label: 'To (days)', type: 'days', hint: 'Blank = no upper limit.', placeholder: '∞' },
      ]}
      addLabel="Add bucket"
    />
  )
}

export function GradesEditor({ draft, setDraft }) {
  return (
    <RowTableEditor
      rows={draft}
      onChange={setDraft}
      fields={[
        { key: 'letter', label: 'Grade', type: 'text', className: 'w-20', placeholder: 'A' },
        { key: 'grade', label: 'Description', type: 'text', placeholder: 'Excellent' },
        { key: 'min_score', label: 'Min score', type: 'points' },
        { key: 'max_score', label: 'Max score', type: 'points' },
      ]}
      addLabel="Add grade"
    />
  )
}

export function MobilityEditor({ draft, setDraft }) {
  return (
    <RowTableEditor
      rows={draft}
      onChange={setDraft}
      fields={[
        { key: 'category', label: 'Tier', type: 'text', placeholder: 'Loan Officer (1)' },
        { key: 'min_portfolio', label: 'Minimum portfolio', type: 'currency' },
        { key: 'max_portfolio', label: 'Maximum portfolio', type: 'currency', hint: 'Blank = no upper limit.', placeholder: '∞' },
        { key: 'allowance', label: 'Monthly allowance', type: 'currency' },
      ]}
      addLabel="Add tier"
    />
  )
}

export function SanctionsEditor({ draft, setDraft }) {
  return (
    <div className="space-y-3">
      <RowTableEditor
        rows={draft}
        onChange={setDraft}
        fields={[
          { key: 'month', label: 'Occurrence', type: 'days', hint: '1, 2, 3… Blank = end-of-progression step.', placeholder: 'n' },
          { key: 'mpr_threshold_pct', label: 'MPR threshold', type: 'percent', hint: 'Blank = any MPR.', placeholder: '∞' },
          { key: 'sanction', label: 'Sanction / HR action', type: 'text', placeholder: 'Warning Letter issued' },
          { key: 'bonus_forfeit_pct', label: 'Bonus forfeiture', type: 'percent', hint: 'Blank = none.', placeholder: '0' },
        ]}
        addLabel="Add step"
      />
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <Info className="w-4 h-4 shrink-0 text-amber-500" />
        <p>
          Sanctions create recommendations only. No employment action (warning, forfeiture or otherwise) is automatic — every step
          requires authorized human approval and is fully audited.
        </p>
      </div>
    </div>
  )
}

export function RegulatoryEditor({ draft, setDraft }) {
  return (
    <RowTableEditor
      rows={draft}
      onChange={setDraft}
      fields={[
        { key: 'metric', label: 'Metric', type: 'text', placeholder: 'Capital Adequacy Ratio' },
        { key: 'value', label: 'Reference value', type: 'ratioText', hint: 'Number or ratio (e.g. 1:10).' },
        { key: 'unit', label: 'Unit', type: 'select', options: [{ value: '%', label: '%' }, { value: 'ratio', label: 'Ratio' }] },
      ]}
      addLabel="Add reference"
    />
  )
}

// --------------------------------------------------------------- QUALIFICATION
export function QualificationEditor({ draft, setDraft }) {
  const patch = (patch) => setDraft({ ...draft, ...patch })
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Field label="Minimum MPR" hint="Staff must score at least this MPR percentage.">
        <NumInput value={draft.mpr_min} onChange={(v) => patch({ mpr_min: v })} suffix="%" />
      </Field>
      <Field label="Maximum MPR" hint="Staff must score no more than this MPR percentage.">
        <NumInput value={draft.mpr_max} onChange={(v) => patch({ mpr_max: v })} suffix="%" />
      </Field>
      <Field label="PAR threshold" hint="Portfolio at risk must be at most this percentage.">
        <NumInput value={draft.par_pct} onChange={(v) => patch({ par_pct: v })} suffix="%" />
      </Field>
      <Field label="New-staff PAR threshold" hint="Tighter PAR limit for staff in their probation/wait period.">
        <NumInput value={draft.new_staff_par_pct} onChange={(v) => patch({ new_staff_par_pct: v })} suffix="%" />
      </Field>
      <Field label="Portfolio achievement" hint="Portfolio delivered against target.">
        <NumInput value={draft.portfolio_achievement_pct} onChange={(v) => patch({ portfolio_achievement_pct: v })} suffix="%" />
      </Field>
      <Field label="SME PAR max days" hint="SME loans must not exceed this many days past due.">
        <NumInput value={draft.sme_par_max_days} onChange={(v) => patch({ sme_par_max_days: v })} suffix="days" />
      </Field>
    </div>
  )
}

// --------------------------------------------------------------- BONUS
export function BonusEditor({ draft, setDraft, designations = [] }) {
  const designationOptions = useMemo(() => {
    const titles = (designations || []).map((d) => d.title).filter(Boolean)
    const configured = [
      ...(draft.eligible || []),
      ...(draft.frequency || []).map((r) => r.designation),
      ...(draft.rules || []).flatMap((r) =>
        (r.when && r.when.conditions || []).filter((c) => c.variable === 'designation').map((c) => c.value)
      ),
    ]
    const known = [...new Set([...titles, ...configured].filter(Boolean).map((t) => t.toUpperCase()))].map((t) => ({ value: t, label: t }))
    return known
  }, [designations, draft])

  const setRules = (rules) => setDraft({ ...draft, rules })
  const patchRule = (i, rule) => setRules(draft.rules.map((r, idx) => (idx === i ? rule : r)))
  const duplicateRule = (i) => setRules([...draft.rules, JSON.parse(JSON.stringify(draft.rules[i]))])
  const removeRule = (i) => setRules(draft.rules.filter((_, idx) => idx !== i))
  const addRule = () =>
    setRules([
      ...draft.rules,
      { when: { mode: 'all', conditions: [{ variable: 'mpr_pct', operator: 'greater_than_or_equal', value: '', unit: 'percent' }] }, then: { action: 'productivity_bonus', value: '', unit: 'percent_of_gross_salary' } },
    ])

  const frequency = draft.frequency || []
  const patchFrequency = (i, patch) => setDraft({ ...draft, frequency: frequency.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) })
  const removeFrequency = (i) => setDraft({ ...draft, frequency: frequency.filter((_, idx) => idx !== i) })
  const addFrequency = () => setDraft({ ...draft, frequency: [...frequency, { designation: '', frequency: 'monthly' }] })

  return (
    <div className="space-y-5">
      {/* Eligibility */}
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <Field label="Eligible designations" hint="Searchable; any bank-HR can add a missing title.">
            <EntityMultiSelect
              options={designationOptions}
              value={draft.eligible || []}
              onChange={(v) => setDraft({ ...draft, eligible: v })}
            />
          </Field>
        </div>
        <div>
          <Field label="Eligibility waiting period" hint="Months of service before staff qualify.">
            <NumInput value={draft.waitMonths} onChange={(v) => setDraft({ ...draft, waitMonths: v })} suffix="months" />
          </Field>
        </div>
      </div>

      {/* Frequency matrix */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Payment frequency</p>
        <div className="space-y-2">
          {frequency.map((row, i) => (
            <div key={i} className="flex items-center gap-2 border border-slate-200 rounded-lg p-2">
              <SelectInput
                value={row.designation ?? ''}
                onChange={(v) => patchFrequency(i, { designation: v })}
                options={designationOptions}
                placeholder="Designation…"
                className="flex-1 min-w-0"
              />
              <FrequencySelect value={row.frequency} onChange={(v) => patchFrequency(i, { frequency: v })} />
              <button type="button" onClick={() => removeFrequency(i)} className="text-slate-300 hover:text-rose-500">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addFrequency} className="mt-2 inline-flex items-center gap-1 text-sm text-[#009944] hover:text-[#007a36] font-medium">
          <Plus className="w-4 h-4" /> Add designation
        </button>
      </div>

      {/* Rules */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">Productivity bonus scale</p>
        <p className="text-[11px] text-slate-400 mb-2">
          Rules are evaluated top to bottom — the first matching rule applies. MPR tiers are exclusive ranges.
        </p>
        <ReorderList
          rows={draft.rules}
          onMove={(from, to) => {
            const next = [...draft.rules]
            const [m] = next.splice(from, 1)
            next.splice(to, 0, m)
            setRules(next)
          }}
          getKey={(r, i) => i}
          renderRow={(rule, i, handles) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <RowHandles {...handles} />
                  Productivity Bonus Rule {i + 1}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => duplicateRule(i)} className="text-slate-400 hover:text-slate-600 p-1" title="Duplicate rule">
                    <Copy className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => removeRule(i)} className="text-slate-400 hover:text-rose-500 p-1" title="Delete rule">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <RulesBuilder
                rule={rule}
                onChange={(next) => patchRule(i, next)}
                onRemove={rule.unsupported ? () => removeRule(i) : null}
                variableKeys={['mpr_pct']}
                operatorOverrides={{ mpr_pct: ['greater_than_or_equal', 'less_than_or_equal', 'between'] }}
                actionKeys={['productivity_bonus']}
                entityOptions={{ designation: designationOptions }}
              />
            </div>
          )}
        />
        <button type="button" onClick={addRule} className="mt-3 inline-flex items-center gap-1 text-sm text-[#009944] hover:text-[#007a36] font-medium">
          <Plus className="w-4 h-4" /> Add rule
        </button>
        <p className="text-[11px] text-slate-400 mt-2">MPR below the lowest band earns no productivity bonus.</p>
      </div>
    </div>
  )
}

// ==================================================================
// editor map
// ==================================================================
export const SECTION_EDITORS = {
  'mpr.components': MprComponentsEditor,
  'mpr.par_bands': ParBandsEditor,
  'mpr.loan_ageing': LoanAgeingEditor,
  'grades.performance': GradesEditor,
  'mobility.allowance_bands': MobilityEditor,
  'sanctions.performance': SanctionsEditor,
  'regulatory.reference_values': RegulatoryEditor,
  'bonus.qualification': QualificationEditor,
  'bonus.productivity': BonusEditor,
}

export function getSectionEditor(configKey) {
  return SECTION_EDITORS[configKey] || null
}

export function RuleSentence(rule) {
  return describeRule(rule)
}