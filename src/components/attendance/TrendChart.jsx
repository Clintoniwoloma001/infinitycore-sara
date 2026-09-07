import React from 'react'

/**
 * Simple SVG bar chart for attendance trends.
 * No heavy charting library — just clean SVG bars.
 */
export default function TrendChart({ data, height = 140, color = '#009944' }) {
  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center text-sm text-slate-400" style={{ height }}>No trend data yet</div>
  }

  const max = Math.max(...data.map((d) => d.value), 1)
  const barWidth = Math.max(8, Math.min(40, 600 / data.length - 4))
  const gap = 4
  const chartWidth = data.length * (barWidth + gap)
  const padding = 20

  return (
    <div className="overflow-x-auto">
      <svg width={chartWidth + padding * 2} height={height + 30} className="block">
        {/* Y-axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={padding}
            x2={chartWidth + padding}
            y1={height - f * height + 5}
            y2={height - f * height + 5}
            stroke="#f1f5f9"
            strokeWidth={1}
          />
        ))}
        {/* Bars */}
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 10)
          const x = padding + i * (barWidth + gap)
          const y = height - h + 5
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={h}
                rx={3}
                fill={d.color || color}
                opacity={0.85}
              />
              <text
                x={x + barWidth / 2}
                y={height + 18}
                textAnchor="middle"
                className="fill-slate-400"
                style={{ fontSize: 9 }}
              >
                {d.label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
