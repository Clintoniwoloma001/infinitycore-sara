// Capacity rules, ordered by the precedence that actually applies, so HR can
// see which rule wins without reading any source.
import React from 'react'
import { Trash2, Pencil, Info } from 'lucide-react'
import { scopeLabel, ruleLimits } from './RuleForm'

export default function RuleTable({ rules, onEdit, onDelete }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <h2 className="px-4 py-3 font-semibold text-slate-900 border-b border-slate-200">
        Rules, most general first
      </h2>

      {/* Explains precedence and the "Not configured" state before the table,
          not after someone has already misread it. */}
      <div className="flex gap-2.5 border-b border-slate-200 bg-slate-50/70 px-4 py-3">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-500" />
        <div className="text-xs leading-relaxed text-slate-600 space-y-1">
          <p>
            <strong className="font-semibold text-slate-800">How rules are applied.</strong>{' '}
            Rules are listed in the order they are evaluated, and the{' '}
            <strong className="font-semibold">Precedence</strong> number decides the winner
            when more than one rule could apply to the same employee &mdash;{' '}
            <strong className="font-semibold">the higher number wins</strong>. The defaults
            ladder from broadest to tightest is: global 10, area 20, branch 30, department 40,
            team 50, role 60, designation 70.
          </p>
          <p>
            <strong className="font-semibold text-slate-800">Applies to</strong> scopes the rule
            to everyone, or to a specific area, branch, department, team, role or designation.
            Leave a{' '}
            <strong className="font-semibold">limit blank to use the recommended value</strong>{' '}
            &mdash; a blank field means &ldquo;no limit from this rule&rdquo;, not zero.
          </p>
          <p>
            <span className="inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 font-medium">
              Not configured
            </span>{' '}
            means this is still a template: it has no limits set and{' '}
            <strong className="font-semibold">currently has no effect at all</strong>. Edit it
            and save to turn it into a real rule &mdash; it then shows as{' '}
            <span className="font-medium text-emerald-700">Active</span>.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              {['Rule', 'Scope', 'Limits', 'Precedence', 'State', ''].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 text-slate-900">{r.name}</td>
                <td className="px-4 py-2.5 text-slate-600">{scopeLabel(r)}</td>
                <td className="px-4 py-2.5 text-slate-600">{ruleLimits(r)}</td>
                <td className="px-4 py-2.5 text-slate-600">{r.priority_number}</td>
                <td className="px-4 py-2.5">
                  {r.is_template
                    ? <span className="text-xs text-amber-700">Not configured</span>
                    : r.is_active
                      ? <span className="text-xs text-emerald-700">Active</span>
                      : <span className="text-xs text-slate-500">Inactive</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => onEdit(r)} aria-label={`Edit ${r.name}`}
                      className="text-slate-500 hover:text-slate-800">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => onDelete(r)} aria-label={`Delete ${r.name}`}
                      className="text-slate-500 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
