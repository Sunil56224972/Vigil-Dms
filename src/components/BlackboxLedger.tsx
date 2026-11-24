import React, { useEffect, useState } from 'react';
import { formatCategoryLabel, formatInterventionLabel } from '../lib/formatters';
import type {
  IncidentRecord,
  LedgerVerification,
  SessionRecord,
  ThresholdsConfig,
} from '../types/telemetry';

interface BlackboxLedgerProps {
  sessions: SessionRecord[];
  incidents: IncidentRecord[];
  ledgerProof: LedgerVerification | null;
  verifyingLedger: boolean;
  thresholds: ThresholdsConfig;
  selectedIncident: IncidentRecord | null;
  onSelectIncident: (inc: IncidentRecord | null) => void;
  onVerifyChain: () => void;
  onSaveThresholds: (partial: Partial<ThresholdsConfig>) => Promise<void>;
}

export const BlackboxLedger: React.FC<BlackboxLedgerProps> = ({
  sessions,
  incidents,
  ledgerProof,
  verifyingLedger,
  thresholds,
  selectedIncident,
  onSelectIncident,
  onVerifyChain,
  onSaveThresholds,
}) => {
  const [draftThresholds, setDraftThresholds] = useState<ThresholdsConfig>(thresholds);
  const [savingCfg, setSavingCfg] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [filterSessionId, setFilterSessionId] = useState<string>('ALL');

  useEffect(() => {
    setDraftThresholds(thresholds);
  }, [thresholds]);

  const filteredIncidents =
    filterSessionId === 'ALL'
      ? incidents
      : incidents.filter((i) => i.session_id === filterSessionId);

  const downloadForensicBundle = (format: 'json' | 'csv') => {
    if (format === 'csv') {
      const header =
        'seq,id,session_id,timestamp_iso,category,severity,stage,summary,intervention_action,prev_hash,entry_hash\n';
      const rows = filteredIncidents
        .map((r) =>
          [
            r.seq,
            r.id,
            r.session_id || '',
            r.timestamp_iso,
            r.category,
            r.severity,
            r.stage,
            `"${r.summary.replace(/"/g, '""')}"`,
            `"${r.intervention_action.replace(/"/g, '""')}"`,
            r.prev_hash,
            r.entry_hash,
          ].join(',')
        )
        .join('\n');
      const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vigil-dms-forensics-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    const bundle = {
      exportedAt: new Date().toISOString(),
      system: 'Vigil DMS',
      backend: 'Supabase PostgreSQL 17 + pgcrypto SHA-256',
      ledgerProof,
      thresholds,
      sessions,
      incidents: filteredIncidents.map((r) => ({
        ...r,
        metrics: JSON.parse(r.metrics_json || '{}'),
      })),
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vigil-dms-forensics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '14px 18px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="inst-bay">
        <div className="inst-bay-header">
          <div>
            <div className="inst-bay-title">Cryptographic Incident Ledger</div>
            <div className="inst-bay-subtitle">Append-only PostgreSQL 17 pgcrypto SHA-256 verification</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="hw-btn primary"
              onClick={onVerifyChain}
              disabled={verifyingLedger}
            >
              {verifyingLedger ? 'Verifying…' : 'Verify SHA-256 chain'}
            </button>
            <button type="button" className="hw-btn" onClick={() => downloadForensicBundle('json')}>
              Export JSON
            </button>
            <button type="button" className="hw-btn" onClick={() => downloadForensicBundle('csv')}>
              Export CSV
            </button>
          </div>
        </div>

        <div className="inst-bay-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
            <div className="readout-cell">
              <div className="readout-label">
                <span>Chain status</span>
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  marginTop: 4,
                  color: ledgerProof?.valid === false ? 'var(--status-danger)' : 'var(--ink-primary)',
                }}
              >
                {ledgerProof
                  ? ledgerProof.valid
                    ? 'Verified intact'
                    : `Mismatch at #${ledgerProof.brokenAtSeq}`
                  : 'Ready'}
              </div>
            </div>

            <div className="readout-cell">
              <div className="readout-label">
                <span>Checked rows</span>
                <span className="mono">{ledgerProof?.durationMs ?? 0} ms</span>
              </div>
              <div className="mono" style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>
                {ledgerProof?.checkedCount ?? incidents.length}
              </div>
            </div>

            <div className="readout-cell" style={{ gridColumn: 'span 2' }}>
              <div className="readout-label">
                <span>Head SHA-256 digest</span>
                <span>{ledgerProof?.engine || 'PostgreSQL 17 pgcrypto'}</span>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  marginTop: 5,
                  color: 'var(--ink-secondary)',
                  wordBreak: 'break-all',
                }}
              >
                {ledgerProof?.headHash || incidents[0]?.entry_hash || '0'.repeat(64)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {selectedIncident && (
        <section className="inst-bay" style={{ borderColor: 'var(--border-strong)' }}>
          <div className="inst-bay-header">
            <div>
              <div className="inst-bay-title">
                Record #{selectedIncident.seq} · {selectedIncident.id}
              </div>
              <div className="inst-bay-subtitle">{selectedIncident.category}</div>
            </div>
            <button type="button" className="hw-btn" onClick={() => onSelectIncident(null)}>
              Close
            </button>
          </div>
          <div
            className="inst-bay-body"
            style={{
              display: 'grid',
              gridTemplateColumns: selectedIncident.frame_evidence ? '260px 1fr' : '1fr',
              gap: 14,
            }}
          >
            {selectedIncident.frame_evidence && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>
                  Captured optical frame
                </div>
                <img
                  src={selectedIncident.frame_evidence}
                  alt="Captured incident optical frame"
                  style={{
                    width: '100%',
                    border: '1px solid var(--border-default)',
                    borderRadius: 4,
                    display: 'block',
                  }}
                />
              </div>
            )}
            <div className="mono" style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <span style={{ color: 'var(--ink-muted)' }}>Timestamp: </span>
                {selectedIncident.timestamp_iso}
              </div>
              <div>
                <span style={{ color: 'var(--ink-muted)' }}>Summary: </span>
                {selectedIncident.summary}
              </div>
              <div>
                <span style={{ color: 'var(--ink-muted)' }}>Intervention: </span>
                {selectedIncident.intervention_action}
              </div>
              <div>
                <span style={{ color: 'var(--ink-muted)' }}>Previous hash: </span>
                <span style={{ wordBreak: 'break-all' }}>{selectedIncident.prev_hash}</span>
              </div>
              <div>
                <span style={{ color: 'var(--ink-muted)' }}>Entry hash: </span>
                <span style={{ wordBreak: 'break-all' }}>{selectedIncident.entry_hash}</span>
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 9,
                  background: 'var(--bg-well)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(JSON.parse(selectedIncident.metrics_json || '{}'), null, 2)}
              </pre>
            </div>
          </div>
        </section>
      )}

      <div className="forensics-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <section className="inst-bay">
            <div className="inst-bay-header">
              <div>
                <div className="inst-bay-title">Incident Records</div>
                <div className="inst-bay-subtitle">Table: public.dms9_incidents</div>
              </div>
              <select
                className="hw-select"
                value={filterSessionId}
                onChange={(e) => setFilterSessionId(e.target.value)}
              >
                <option value="ALL">All sessions ({incidents.length})</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {s.driver_tag}
                  </option>
                ))}
              </select>
            </div>
            <div className="inst-bay-body" style={{ padding: 0 }}>
              <div className="ledger-table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Seq</th>
                      <th>Time</th>
                      <th>Category</th>
                      <th>Severity</th>
                      <th>Summary</th>
                      <th>Intervention</th>
                      <th>SHA-256</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIncidents.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--ink-muted)' }}>
                          0 incidents in ledger — start a session to record live detections.
                        </td>
                      </tr>
                    ) : (
                      filteredIncidents.map((inc) => (
                        <tr key={inc.id} onClick={() => onSelectIncident(inc)}>
                          <td className="mono">#{inc.seq}</td>
                          <td className="mono">{new Date(inc.timestamp_iso).toLocaleTimeString()}</td>
                          <td style={{ fontWeight: 500 }}>{formatCategoryLabel(inc.category)}</td>
                          <td>
                            <span className={`sev-badge ${inc.severity}`}>
                              {inc.severity.charAt(0) + inc.severity.slice(1).toLowerCase()}
                            </span>
                          </td>
                          <td>{inc.summary}</td>
                          <td style={{ fontSize: 11.5, color: 'var(--ink-secondary)' }}>
                            {formatInterventionLabel(inc.intervention_action)}
                          </td>
                          <td className="mono" style={{ color: 'var(--ink-secondary)', fontSize: 11 }}>
                            {inc.entry_hash.slice(0, 12)}…
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="inst-bay">
            <div className="inst-bay-header">
              <div>
                <div className="inst-bay-title">Driving Sessions</div>
                <div className="inst-bay-subtitle">Table: public.dms9_sessions</div>
              </div>
            </div>
            <div className="inst-bay-body" style={{ padding: 0 }}>
              <div className="ledger-table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Session ID</th>
                      <th>Driver</th>
                      <th>Started</th>
                      <th>Distance</th>
                      <th>Peak speed</th>
                      <th>Peak G</th>
                      <th>Peak PERCLOS</th>
                      <th>Events</th>
                      <th>Safety score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: 'center', padding: 22, color: 'var(--ink-muted)' }}>
                          No sessions logged yet.
                        </td>
                      </tr>
                    ) : (
                      sessions.map((s) => (
                        <tr key={s.id} onClick={() => setFilterSessionId(s.id)}>
                          <td className="mono">{s.id}</td>
                          <td>{s.driver_tag}</td>
                          <td className="mono">{new Date(s.started_at).toLocaleString()}</td>
                          <td className="mono">{Number(s.distance_km).toFixed(2)} km</td>
                          <td className="mono">{Number(s.peak_speed_kmh).toFixed(1)} km/h</td>
                          <td className="mono">
                            {Math.max(Number(s.peak_long_g), Number(s.peak_lat_g)).toFixed(2)}g
                          </td>
                          <td className="mono">{Number(s.peak_perclos).toFixed(1)}%</td>
                          <td className="mono">{s.incident_count}</td>
                          <td className="mono" style={{ fontWeight: 600 }}>
                            {Number(s.safety_index).toFixed(0)}/100
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <section className="inst-bay">
          <div className="inst-bay-header">
            <div>
              <div className="inst-bay-title">Detection Thresholds</div>
              <div className="inst-bay-subtitle">Saved in public.dms9_config</div>
            </div>
          </div>
          <div className="inst-bay-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(
              [
                ['EAR closure ratio (× baseline)', 'earClosureRatio', 0.55, 0.85, 0.01],
                ['Microsleep hold (ms)', 'microsleepHoldMs', 900, 3000, 100],
                ['Drowsy closure hold (ms)', 'drowsyHoldMs', 500, 1600, 50],
                ['PERCLOS critical (%)', 'perclosCritPct', 12, 40, 1],
                ['Yawn MAR threshold', 'yawnMarThreshold', 0.42, 0.75, 0.02],
                ['Off-road yaw cone (deg)', 'distractionYawDeg', 15, 40, 1],
                ['Harsh braking (m/s²)', 'harshBrakeMs2', -7.0, -2.0, 0.2],
                ['Rapid acceleration (m/s²)', 'rapidAccelMs2', 1.8, 6.5, 0.2],
                ['Rash lateral load (m/s²)', 'rashLatMs2', 2.0, 6.5, 0.2],
                ['Governor speed cap (km/h)', 'governorCapKmh', 20, 80, 5],
              ] as Array<[string, keyof ThresholdsConfig, number, number, number]>
            ).map(([label, key, min, max, step]) => (
              <div key={key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 2 }}>
                  <span style={{ color: 'var(--ink-secondary)' }}>{label}</span>
                  <span className="mono" style={{ color: 'var(--ink-primary)', fontWeight: 500 }}>
                    {String(draftThresholds[key])}
                  </span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={Number(draftThresholds[key])}
                  style={{ width: '100%', accentColor: 'var(--ink-primary)' }}
                  onChange={(e) =>
                    setDraftThresholds((prev) => ({
                      ...prev,
                      [key]: Number(e.target.value),
                    }))
                  }
                />
              </div>
            ))}

            <div>
              <label style={{ fontSize: 11.5, color: 'var(--ink-secondary)', display: 'block', marginBottom: 4 }}>
                Safety webhook URL (optional HTTP POST)
              </label>
              <input
                type="url"
                placeholder="https://dispatch.example.com/webhook"
                className="hw-input mono"
                style={{ width: '100%' }}
                value={draftThresholds.webhookUrl}
                onChange={(e) =>
                  setDraftThresholds((prev) => ({ ...prev, webhookUrl: e.target.value }))
                }
              />
            </div>

            <button
              type="button"
              className="hw-btn primary"
              style={{ marginTop: 4 }}
              disabled={savingCfg}
              onClick={async () => {
                setSavingCfg(true);
                await onSaveThresholds(draftThresholds);
                setSavingCfg(false);
                setSavedToast(true);
                window.setTimeout(() => setSavedToast(false), 2000);
              }}
            >
              {savingCfg ? 'Saving…' : savedToast ? 'Saved to Supabase' : 'Save thresholds to Supabase'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
