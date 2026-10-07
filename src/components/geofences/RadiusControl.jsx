import React, { useState } from 'react'
import { RADIUS_MIN_METERS, RADIUS_MAX_METERS, formatRadiusIn, radiusForUnit, radiusFromUnit, parseRadius } from '../../services/geofenceService'

/**
 * Radius control: a 10–5000 slider with an m/km unit select.
 *
 * The slider operates on the DISPLAY unit (so km mode moves in 0.01 km
 * steps) but the value it reports to the parent is always whole metres —
 * the unit select only changes presentation.
 */
export default function RadiusControl({ value, onChange, disabled = false, id = 'gf-radius' }) {
  const [unit, setUnit] = useState('m')

  const bounds = {
    min: radiusForUnit(RADIUS_MIN_METERS, unit),
    max: radiusForUnit(RADIUS_MAX_METERS, unit),
    step: unit === 'km' ? 0.01 : 10,
  }
  const sliderValue = radiusForUnit(Number.isFinite(Number(value)) ? value : RADIUS_MIN_METERS, unit)
  const clamped = Math.min(Math.max(sliderValue, bounds.min), bounds.max)
  const { error } = parseRadius(value, 'm')

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Fence radius
        </label>
        <div className="flex items-center gap-2">
          <output
            htmlFor={id}
            className={`text-sm font-semibold tabular-nums ${error ? 'text-rose-600' : 'text-[#009944]'}`}
          >
            {error ? '—' : formatRadiusIn(value, unit)}
          </output>
          <select
            aria-label="Radius unit"
            value={unit}
            disabled={disabled}
            onChange={(event) => setUnit(event.target.value)}
            className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-[#009944] focus:outline-none focus:ring-2 focus:ring-[#009944]/30 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="m">m</option>
            <option value="km">km</option>
          </select>
        </div>
      </div>

      <input
        id={id}
        type="range"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={clamped}
        disabled={disabled}
        aria-valuetext={error ? undefined : formatRadiusIn(value, unit)}
        onChange={(event) => onChange(radiusFromUnit(event.target.value, unit))}
        className="mt-3 w-full accent-[#009944] disabled:opacity-60"
      />

      <div className="mt-1 flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
        <span>{RADIUS_MIN_METERS} m</span>
        <span>{RADIUS_MAX_METERS / 1000} km</span>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-600">
          {error}
        </p>
      )}
    </div>
  )
}
