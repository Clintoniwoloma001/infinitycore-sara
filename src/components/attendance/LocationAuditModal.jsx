import React, { useEffect, useState } from 'react'
import { X, MapPin, CheckCircle2, AlertTriangle, Clock, Crosshair, Gauge } from 'lucide-react'
import { attendanceService } from '../../services/attendanceService'
import { LoadingState, ErrorState } from '../PageStates'

export default function LocationAuditModal({ record, onClose }) {
  const [audit, setAudit] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (record?.id) load()
  }, [record?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    setLoading(true)
    try {
      const data = await attendanceService.getCorrectionAudit(record.id)
      setAudit(data)
    } catch (e) {
      setError(e?.message || 'Failed to load audit data')
    } finally {
      setLoading(false)
    }
  }

  if (!record) return null

  const geoInside = record.geofence_status === 'inside'
  const geoOutside = record.geofence_status === 'outside'

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Location Audit</h3>
            <p className="text-sm text-slate-500">{new Date(record.attendance_date).toLocaleDateString()}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          {error && <ErrorState message={error} />}
          {loading && <LoadingState label="Loading audit data…" />}

          {!loading && (
            <>
              {/* Clock-in verification */}
              <div className={`rounded-xl border p-4 ${geoInside ? 'border-emerald-200 bg-emerald-50' : geoOutside ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}>
                <p className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-slate-400" /> Clock-In Verification
                </p>
                <div className="space-y-2 text-sm">
                  <AuditRow icon={geoInside ? CheckCircle2 : geoOutside ? AlertTriangle : MapPin}
                    iconColor={geoInside ? 'text-emerald-600' : geoOutside ? 'text-rose-600' : 'text-slate-400'}
                    label="Geofence Result"
                    value={record.geofence_status ? record.geofence_status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'No geofence'} />
                  {record.clock_in_distance != null && (
                    <AuditRow icon={MapPin} label="Distance from Branch" value={`${Math.round(record.clock_in_distance)}m`} />
                  )}
                  {record.clock_in_accuracy != null && (
                    <AuditRow icon={Gauge} label="GPS Accuracy" value={`±${Math.round(record.clock_in_accuracy)}m`} />
                  )}
                  {record.clock_in_lat != null && (
                    <AuditRow icon={Crosshair} label="Coordinates" value={`${record.clock_in_lat.toFixed(4)}, ${record.clock_in_lng.toFixed(4)}`} />
                  )}
                  <AuditRow icon={Clock} label="Timestamp" value={record.clock_in ? new Date(record.clock_in).toLocaleString() : '—'} />
                  {record.late_minutes > 0 && (
                    <AuditRow icon={AlertTriangle} label="Late By" value={`${record.late_minutes} minutes`} />
                  )}
                </div>
              </div>

              {/* Clock-out verification */}
              {record.clock_out && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-slate-400" /> Clock-Out Verification
                  </p>
                  <div className="space-y-2 text-sm">
                    {record.clock_out_distance != null && (
                      <AuditRow icon={MapPin} label="Distance from Branch" value={`${Math.round(record.clock_out_distance)}m`} />
                    )}
                    {record.clock_out_accuracy != null && (
                      <AuditRow icon={Gauge} label="GPS Accuracy" value={`±${Math.round(record.clock_out_accuracy)}m`} />
                    )}
                    {record.clock_out_lat != null && (
                      <AuditRow icon={Crosshair} label="Coordinates" value={`${record.clock_out_lat.toFixed(4)}, ${record.clock_out_lng.toFixed(4)}`} />
                    )}
                    <AuditRow icon={Clock} label="Timestamp" value={new Date(record.clock_out).toLocaleString()} />
                    {record.early_departure_minutes > 0 && (
                      <AuditRow icon={AlertTriangle} label="Early Departure" value={`${record.early_departure_minutes} minutes`} />
                    )}
                    {record.total_minutes != null && (
                      <AuditRow icon={Clock} label="Total Duration" value={`${record.total_minutes} minutes (${record.work_hours}h)`} />
                    )}
                  </div>
                </div>
              )}

              {/* Correction audit trail */}
              {audit.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-slate-700 mb-2">Correction History</p>
                  <div className="space-y-2">
                    {audit.map((a) => (
                      <div key={a.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-slate-700">{a.field_name}</span>
                          <span className="text-xs text-slate-400">{new Date(a.corrected_at).toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-slate-500">From: <span className="font-mono">{a.previous_value || '(empty)'}</span></p>
                        <p className="text-xs text-slate-500">To: <span className="font-mono">{a.corrected_value || '(empty)'}</span></p>
                        {a.reason && <p className="text-xs text-amber-600 mt-1">Reason: {a.reason}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {record.is_corrected && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  This record was corrected by HR. Reason: {record.correction_reason || 'Not specified'}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AuditRow({ icon: Icon, iconColor = 'text-slate-400', label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500 flex items-center gap-1.5"><Icon className={`w-3.5 h-3.5 ${iconColor}`} /> {label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  )
}
