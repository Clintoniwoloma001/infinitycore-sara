      {canManage && <ZohoMailCard />}

      <SectionCard
        title="Phase 4 reminder sweep (manual Zoho send)"
        description="Manual trigger of the audit- obligation reminder sweep. Preview shows the pending recipients + message bodies (no send); Run sends via the connected Zoho mailbox and records results in audit_sweep_log. The scheduled job (pg_cron, 07:00 Africa/Lagos) runs the same idempotent sweep server-side."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={previewSweep} disabled={busy} className={ghostBtn}>
              <Eye className="h-4 w-4" />Preview sweep
            </button>
            <button onClick={runSweep} disabled={busy} className={primaryBtn}>
              <Send className="h-4 w-4" />Run reminder sweep
            </button>
          </div>
        }
      >
        {previewData && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              {previewData.mode === 'preview' ? 'Pending recipients (no email sent).' : 'Sweep run results (sent / failed counted).'}
            </p>
            {previewError && <p className="text-sm text-red-700">{previewError}</p>}
            {previewData.recipients && previewData.recipients.length === 0 && (
              <p className="text-sm text-slate-500">No pending reminders this run.</p>
            )}
            {previewData.recipients && (
              <div className="max-h-64 overflow-y-auto text-xs text-slate-700 space-y-2">
                {previewData.recipients.map((r, i) => (
                  <div key={i} className="border border-slate-200 rounded p-2">
                    <div className="font-medium text-slate-900">{r.obligation_reference} — {r.obligation_title}</div>
                    <div className="text-xs text-slate-500">To: {r.recipient_email} · due {r.due} · {r.status_label}</div>
                    <div className="mt-1 text-xs text-slate-600">
                      <a href={r.token_link} className="text-blue-600 underline">Open token link</a>
                    </div>
                    <div className="mt-1 text-xs text-slate-600">Subject: {r.obligation_reference}</div>
                    <div className="mt-1 text-xs text-slate-600">From: audit mailbox</div>
                    <div className="mt-1 text-xs">
                      <pre className="bg-slate-50 p-2 rounded overflow-x-auto text-[10px] leading-relaxed">{r.text_body}</pre>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={closePreview} className={ghostBtn}>Close</button>
              <button
                onClick={sendFromPreview}
                disabled={busy || !previewReason.trim()}
                className={primaryBtn}
              >
                <Send className="h-4 w-4" />Send now (manual Zoho)
              </button>
            </div>
            <label className={labelCls}>Reason (recorded in audit log)</label>
            <input
              className={inputCls}
              value={previewReason}
              onChange={(e) => setPreviewReason(e.target.value)}
              placeholder="Why is this sweep being sent (e.g. scheduled 07:00 Lagos run, manual trigger)"
              rows={2}
            />
          </div>
        )}
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">