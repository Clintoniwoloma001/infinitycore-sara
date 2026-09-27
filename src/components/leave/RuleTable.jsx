// Capacity rules, ordered by the precedence that actually applies, so HR can
// see which rule wins without reading any source.
import React from 'react'
import { Trash2, Pencil } from 'lucide-react'
import { scopeLabel, ruleLimits } from './RuleForm'

export default function RuleTable({ rules, onEdit, onDelete }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <h2 className="px-4 py-3 font-semibold text-slate-900 border-b border-slate-200">
        Rules, most general first
      </h2>
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
