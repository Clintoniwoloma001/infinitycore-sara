// Platform currency — Infinity MFB operates in Nigerian Naira (NGN) by default.
// The default can be overridden at runtime from Platform Settings → Currency,
// which persists to hr_platform_settings and calls setPlatformCurrency().
let currencyCfg = { code: 'NGN', symbol: '₦', position: 'prefix', decimals: 2 }

export const setPlatformCurrency = (cfg) => {
  currencyCfg = {
    code: 'NGN',
    symbol: '₦',
    position: 'prefix',
    decimals: 2,
    ...(cfg || {}),
  }
}

export const formatCurrency = (n) => {
  const v = Number(n || 0)
  const { symbol, position, decimals } = currencyCfg
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(v)
  return position === 'suffix' ? `${formatted} ${symbol}` : `${symbol}${formatted}`
}

export const formatDate = (d) => {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return d
  }
}

export const STATUS_COLORS = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
}

export function StatusBadge({ label, color = 'slate' }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_COLORS[color] || STATUS_COLORS.slate}`}>
      {label}
    </span>
  )
}