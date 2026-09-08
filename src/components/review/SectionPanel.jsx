import React, { useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, RotateCw, X, XCircle } from 'lucide-react'

// Status badge for a field's correction state
function CorrectionBadge({ status }) {
  if (!status) return null
  const config = {
    pending: { icon: AlertTriangle, cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Correction Requested' },
    submitted: { icon: RotateCw, cls: 'bg-blue-50 text-blue-700 border-blue-200', label: 'Correction Submitted' },
    approved: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Correction Approved' },
    rejected: { icon: XCircle, cls: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Correction Rejected' },
  }
  const c = config[status]
  if (!c) return null
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.cls}`}>
      <Icon className="w-3 h-3" /> {c.label}
    </span>
  )
}

// Renders a single field row with value and optional correction button
function FieldRow({ field, value, correction, canManage, onRequestCorrection }) {
  const displayValue = value || '—'
  const isEmpty = !value
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 py-2.5 border-b border-slate-100 last:border-0">
      <div className="sm:w-48 flex-shrink-0">
        <span className="text-sm font-medium text-slate-600">{field.label}</span>
      </div>
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${isEmpty ? 'text-slate-300 italic' : 'text-slate-900'} break-words`}>
          {field.key === 'fidelity_signature' && value ? (
            <img src={value} alt="Signature" className="max-w-xs rounded border border-slate-200" />
          ) : displayValue}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {correction && <CorrectionBadge status={correction.status} />}
        {canManage && !correction && (
          <button
            onClick={() => onRequestCorrection(field)}
            className="text-xs px-2 py-1 rounded-md border border-amber-300 text-amber-700 hover:bg-amber-50 whitespace-nowrap"
          >
            Request Correction
          </button>
        )}
        {correction && correction.hr_comment && (
          <span className="text-xs text-slate-400 italic max-w-[200px] truncate" title={correction.hr_comment}>
            "{correction.hr_comment}"
          </span>
        )}
      </div>
    </div>
  )
}

// Renders a list-type section (education, work history)
function ListSection({ section, rows }) {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-slate-400 italic py-4">No entries submitted.</p>
  }
  return (
    <div className="space-y-3">
      {rows.map((row, idx) => (
        <div key={idx} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="text-xs font-medium text-slate-400 mb-2">Entry {idx + 1}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {section.columns.map((col) => (
              <div key={col.key}>
                <span className="text-xs text-slate-400">{col.label}:</span>{' '}
                <span className="text-sm text-slate-800">{row[col.key] || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Collapsible section wrapper
function CollapsibleSection({ title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-slate-500" />}
          <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
        </div>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && <div className="px-4 py-3">{children}</div>}
    </div>
  )
}

export default function SectionPanel({ section, payload, corrections, canManage, onRequestCorrection }) {
  // Build a map of corrections by field_name for quick lookup
  const correctionMap = {}
  if (corrections) {
    corrections.forEach((c) => {
      // Use the latest correction for each field
      correctionMap[c.field_name] = c
    })
  }

  if (section.type === 'list') {
    const rows = payload?.[section.id] || []
    return (
      <CollapsibleSection title={section.title} icon={section.icon}>
        <ListSection section={section} rows={rows} />
      </CollapsibleSection>
    )
  }

  if (section.type === 'documents') {
    // Documents are handled by the DocumentsTab, not here
    return null
  }

  return (
    <CollapsibleSection title={section.title} icon={section.icon}>
      <div>
        {section.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={payload?.[field.key]}
            correction={correctionMap[field.key]}
            canManage={canManage}
            onRequestCorrection={onRequestCorrection}
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}
