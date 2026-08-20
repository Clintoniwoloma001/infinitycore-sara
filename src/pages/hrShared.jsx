import React, { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { StatusBadge, formatCurrency, formatDate } from '../lib/utils'

export function useTable(table, orderBy = 'created_at') {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        let query = supabase.from(table).select('*')
        if (orderBy) query = query.order(orderBy, { ascending: false })
        const { data, error: queryError } = await query
        if (queryError) throw queryError
        if (active) setRows(data || [])
      } catch (e) {
        if (active) {
          setRows([])
          setError(e?.message || `Unable to load ${table}`)
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [table, orderBy])

  return { rows, loading, error }
}

export function ModuleTable({ title, subtitle, rows, columns, loading, error, searchKeys = [], filter }) {
  const [search, setSearch] = useState('')

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return rows.filter((row) => {
      const matchesSearch = !query || searchKeys.some((key) => String(row[key] || '').toLowerCase().includes(query))
      const matchesFilter = filter ? filter(row) : true
      return matchesSearch && matchesFilter
    })
  }, [filter, rows, search, searchKeys])

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">{title}</h2>
          <p className="text-sm text-slate-500 mt-1">{subtitle}</p>
        </div>
        {searchKeys.length > 0 && (
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full h-10 pl-9 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#009944]"
            />
          </div>
        )}
      </div>

      {loading && <LoadingState label={`Loading ${title.toLowerCase()}...`} />}
      {!loading && error && <ErrorState message={error} />}
      {!loading && !error && filteredRows.length === 0 && <EmptyState title={`No ${title.toLowerCase()} yet`} description="This module is ready, but there are no matching records in Supabase." />}
      {!loading && !error && filteredRows.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                {columns.map((column) => <th key={column.key} className="px-6 py-3 font-medium whitespace-nowrap">{column.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  {columns.map((column) => <td key={column.key} className="px-6 py-3 text-slate-700">{column.render ? column.render(row) : row[column.key] || '-'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export const status = (value, good = ['active', 'published', 'completed', 'paid', 'approved', 'hired']) => {
  const color = good.includes(value) ? 'emerald' : ['rejected', 'cancelled', 'terminated', 'failed'].includes(value) ? 'rose' : 'amber'
  return <StatusBadge label={String(value || 'pending').replace(/_/g, ' ')} color={color} />
}

export const money = (value) => formatCurrency(Number(value) || 0)
export const date = (value) => formatDate(value)
