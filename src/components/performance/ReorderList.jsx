import React, { useState } from 'react'
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react'

// Drag-and-drop list wrapper. Rows can be dragged (HTML5) or moved with
// the up/down buttons; every move ends in a single deterministic
// onMove(from,to) so rule evaluation order stays explicit and auditable.
export default function ReorderList({ rows, onMove, renderRow, getKey }) {
  const [dragFrom, setDragFrom] = useState(null)
  const [dragOver, setDragOver] = useState(null)

  const drop = () => {
    if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) onMove(dragFrom, dragOver)
    setDragFrom(null)
    setDragOver(null)
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div
          key={getKey ? getKey(row, i) : i}
          draggable
          onDragStart={() => setDragFrom(i)}
          onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
          onDragOver={(e) => {
            if (dragFrom === null) return
            e.preventDefault()
            setDragOver(i)
          }}
          onDrop={(e) => {
            e.preventDefault()
            drop()
          }}
          className={`rounded-lg transition-colors ${dragOver === i && dragFrom !== null && dragFrom !== i ? 'ring-2 ring-[#009944] ring-offset-1' : ''} ${dragFrom === i ? 'opacity-50' : ''}`}
        >
          {renderRow(row, i, {
            up: () => onMove(i, Math.max(0, i - 1)),
            down: () => onMove(i, Math.min(rows.length - 1, i + 1)),
            canUp: i > 0,
            canDown: i < rows.length - 1,
          })}
        </div>
      ))}
    </div>
  )
}

export function RowHandles({ canUp, canDown, up, down, dragLabel = 'Drag to reorder' }) {
  return (
    <div className="flex items-center gap-0.5">
      <span title={dragLabel} className="cursor-grab text-slate-300 hover:text-slate-400 active:cursor-grabbing">
        <GripVertical className="w-4 h-4" />
      </span>
      <div className="flex flex-col">
        <button type="button" onClick={up} disabled={!canUp} className="text-slate-300 hover:text-slate-500 disabled:opacity-30 p-0.5" title="Move up">
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={down} disabled={!canDown} className="text-slate-300 hover:text-slate-500 disabled:opacity-30 p-0.5" title="Move down">
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}