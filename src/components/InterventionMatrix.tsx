import React, { useEffect, useRef, useState } from 'react';
import anime from 'animejs';
import { VEHICLE_PROFILE_PRESETS } from '../lib/supabase';
import { formatCategoryLabel, formatInterventionLabel } from '../lib/formatters';
import { OdometerValue } from './OdometerValue';
import type {
  ActiveInterventionState,
  EmergencyCallState,
  IncidentRecord,
  ThresholdsConfig,
  VehicleProfileKey,
} from '../types/telemetry';

export function formatDialNumber(raw: string): { cleanDigits: string; telHref: string; waHref: string; display: string } {
  const trimmed = (raw || '7389416622').trim();
  const digitsOnly = trimmed.replace(/\D/g, '') || '7389416622';
  const withCountry =
    trimmed.startsWith('+')
      ? `+${digitsOnly}`
      : digitsOnly.length === 10
      ? `+91${digitsOnly}`
      : `+${digitsOnly}`;
  const waDigits = withCountry.replace(/\D/g, '');
  return {
    cleanDigits: digitsOnly,
    telHref: `tel:${withCountry}`,
    waHref: `https://wa.me/${waDigits}`,
    display: withCountry,
  };
}

interface InterventionMatrixProps {
  intervention: ActiveInterventionState;
  emergencyCall: EmergencyCallState | null;
  thresholds: ThresholdsConfig;
  recentIncidents: IncidentRecord[];
  onUpdateThresholds: (partial: Partial<ThresholdsConfig>) => void;
  onSelectPreset: (profile: VehicleProfileKey) => void;
  onManualResetLockout: () => void;
  onTestAudioVoice: () => void;
  onTriggerEmergencyCall: (reason: string) => void;
  onCancelAutoSos: () => void;
  onDismissEmergencyCall: () => void;
  onSelectIncidentForensics: (inc: IncidentRecord) => void;
}

export const InterventionMatrix: React.FC<InterventionMatrixProps> = ({
  intervention,
  emergencyCall,
  thresholds,
  recentIncidents,
  onUpdateThresholds,
  onSelectPreset,
  onManualResetLockout,
  onTestAudioVoice,
  onTriggerEmergencyCall,
  onCancelAutoSos,
  onDismissEmergencyCall,
  onSelectIncidentForensics,
}) => {
  const streamListRef = useRef<HTMLDivElement | null>(null);
  const prevTopIdRef = useRef<string | null>(recentIncidents[0]?.id ?? null);
  const [callElapsedSec, setCallElapsedSec] = useState(0);

  useEffect(() => {
    if (!emergencyCall?.active) {
      setCallElapsedSec(0);
      return;
    }
    const tick = () =>
      setCallElapsedSec(Math.max(0, Math.floor((Date.now() - emergencyCall.startedAtMs) / 1000)));
    tick();
    const id = window.setInterval(tick, 500);
    return () => clearInterval(id);
  }, [emergencyCall?.active, emergencyCall?.startedAtMs]);

  const dialInfo = formatDialNumber(thresholds.emergencyPhone || '7389416622');
  const mapsLink =
    emergencyCall?.lat != null && emergencyCall?.lon != null
      ? `https://maps.google.com/?q=${emergencyCall.lat.toFixed(5)},${emergencyCall.lon.toFixed(5)}`
      : null;
  const sosBodyText = encodeURIComponent(
    `[Vigil DMS Emergency SOS] ${emergencyCall?.reason || 'Driver emergency alert'} · Speed ${
      emergencyCall ? emergencyCall.speedKmh.toFixed(0) : '0'
    } km/h${mapsLink ? ` · Location: ${mapsLink}` : ''}`
  );

  useEffect(() => {
    const topId = recentIncidents[0]?.id ?? null;
    if (topId && topId !== prevTopIdRef.current && streamListRef.current?.firstElementChild) {
      anime({
        targets: streamListRef.current.firstElementChild,
        translateY: [-12, 0],
        opacity: [0, 1],
        easing: 'spring(1, 95, 14, 0)',
      });
    }
    prevTopIdRef.current = topId;
  }, [recentIncidents]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className="inst-bay">
        <div className="inst-bay-header">
          <div>
            <div className="inst-bay-title">Safety Interventions</div>
            <div className="inst-bay-subtitle">Preventive relays &amp; vehicle profile</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="hw-btn"
              style={{ height: 24, padding: '0 8px', fontSize: 11 }}
              onClick={onTestAudioVoice}
              title="Verify cabin speaker chime and voice synthesizer"
            >
              Test audio
            </button>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color:
                  intervention.stage >= 3
                    ? 'var(--status-danger)'
                    : intervention.stage >= 1
                    ? 'var(--status-warn)'
                    : 'var(--ink-muted)',
              }}
            >
              Stage {intervention.stage}/3
            </span>
          </div>
        </div>

        <div className="inst-bay-body" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div
              className="readout-cell"
              style={{
                borderColor: intervention.governorActive ? 'var(--border-strong)' : 'var(--border-subtle)',
                background: intervention.governorActive ? 'var(--bg-subtle)' : 'var(--bg-well)',
                boxShadow: intervention.governorActive ? 'inset 3px 0 0 var(--status-danger)' : 'none',
              }}
            >
              <div className="readout-label">
                <span>Speed governor</span>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginTop: 4,
                  color: intervention.governorActive ? 'var(--ink-primary)' : 'var(--ink-secondary)',
                }}
              >
                {intervention.governorActive ? `Capped (${thresholds.governorCapKmh} km/h)` : 'Standby'}
              </div>
            </div>

            <div
              className="readout-cell"
              style={{
                borderColor: intervention.hazardStrobeActive ? 'var(--border-strong)' : 'var(--border-subtle)',
                background: intervention.hazardStrobeActive ? 'var(--bg-subtle)' : 'var(--bg-well)',
                boxShadow: intervention.hazardStrobeActive ? 'inset 3px 0 0 var(--status-warn)' : 'none',
              }}
            >
              <div className="readout-label">
                <span>Hazard beacons</span>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginTop: 4,
                  color: intervention.hazardStrobeActive ? 'var(--ink-primary)' : 'var(--ink-secondary)',
                }}
              >
                {intervention.hazardStrobeActive ? 'Active 4-way' : 'Off'}
              </div>
            </div>
          </div>

          {intervention.lockoutRequiresCheck && (
            <div
              style={{
                padding: 9,
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-strong)',
                boxShadow: 'inset 3px 0 0 var(--status-danger)',
                borderRadius: 4,
              }}
            >
              <div
                className="mono"
                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 5 }}
              >
                <span>Alertness check</span>
                <span>{Math.round(intervention.alertnessHoldProgress * 100)}%</span>
              </div>
              <div style={{ height: 4, background: 'var(--bg-well)', borderRadius: 2, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${intervention.alertnessHoldProgress * 100}%`,
                    background: 'var(--ink-primary)',
                    transition: 'width 0.1s linear',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 7 }}>
                <span style={{ fontSize: 11, color: 'var(--ink-secondary)' }}>
                  Hold steady forward gaze for 2.5s
                </span>
                <button
                  type="button"
                  className="hw-btn"
                  style={{ height: 24, padding: '0 8px', fontSize: 11 }}
                  onClick={onManualResetLockout}
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          <div className="rocker-row">
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>Acoustic alarm</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                Advisory chime &amp; 960/1320Hz wake siren
              </div>
            </div>
            <button
              type="button"
              aria-label="Toggle Acoustic Alarm"
              className={`rocker-switch ${thresholds.audioArmed ? 'armed' : ''}`}
              onClick={() => onUpdateThresholds({ audioArmed: !thresholds.audioArmed })}
            >
              <span className="rocker-thumb" />
            </button>
          </div>

          <div className="rocker-row">
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>Spoken voice alerts</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                In-cabin speech directives on warning
              </div>
            </div>
            <button
              type="button"
              aria-label="Toggle Spoken Voice Alerts"
              className={`rocker-switch ${thresholds.voiceArmed ? 'armed' : ''}`}
              onClick={() => onUpdateThresholds({ voiceArmed: !thresholds.voiceArmed })}
            >
              <span className="rocker-thumb" />
            </button>
          </div>

          <div className="rocker-row">
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>Speed governor relay</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                Limits speed to {thresholds.governorCapKmh} km/h on microsleep
              </div>
            </div>
            <button
              type="button"
              aria-label="Toggle Speed Governor Relay"
              className={`rocker-switch ${thresholds.governorArmed ? 'armed' : ''}`}
              onClick={() => onUpdateThresholds({ governorArmed: !thresholds.governorArmed })}
            >
              <span className="rocker-thumb" />
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 90px',
              gap: 6,
              paddingTop: 6,
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <div>
              <label style={{ fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
                Vehicle class
              </label>
              <select
                className="hw-select"
                style={{ width: '100%' }}
                value={thresholds.vehicleProfile}
                onChange={(e) => onSelectPreset(e.target.value as VehicleProfileKey)}
              >
                {Object.entries(VEHICLE_PROFILE_PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label} ({v.code})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3 }}>
                Limit (km/h)
              </label>
              <input
                type="number"
                className="hw-input mono"
                style={{ width: '100%' }}
                min={15}
                max={140}
                step={5}
                value={thresholds.speedLimitKmh}
                onChange={(e) =>
                  onUpdateThresholds({
                    speedLimitKmh: Math.max(15, Math.min(140, Number(e.target.value) || 60)),
                  })
                }
              />
            </div>
          </div>

          {/* Emergency SOS Auto-Dial & 1-Tap Call Module */}
          <div
            style={{
              paddingTop: 8,
              marginTop: 2,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>Emergency SOS Call</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                  Auto-dials on 5s unrecovered microsleep
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>Auto-SOS</span>
                <button
                  type="button"
                  aria-label="Toggle Emergency Auto-SOS"
                  className={`rocker-switch ${(thresholds.emergencyAutoCall ?? true) ? 'armed' : ''}`}
                  onClick={() =>
                    onUpdateThresholds({ emergencyAutoCall: !(thresholds.emergencyAutoCall ?? true) })
                  }
                >
                  <span className="rocker-thumb" />
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
              <input
                type="tel"
                className="hw-input mono"
                style={{ width: '100%' }}
                placeholder="7389416622"
                aria-label="Emergency phone number"
                value={thresholds.emergencyPhone ?? '7389416622'}
                onChange={(e) => onUpdateThresholds({ emergencyPhone: e.target.value })}
              />
              <a
                href={dialInfo.telHref}
                className="hw-btn danger"
                style={{ textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}
                onClick={() => onTriggerEmergencyCall('Manual emergency SOS call')}
              >
                Call {dialInfo.cleanDigits.slice(-10)}
              </a>
            </div>

            {intervention.sosCountdownSec != null && !emergencyCall?.active && (
              <div
                style={{
                  padding: '8px 10px',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'inset 3px 0 0 var(--status-danger)',
                  borderRadius: 4,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-primary)' }}>
                  Auto-calling {dialInfo.display} in {intervention.sosCountdownSec}s…
                </span>
                <div style={{ display: 'flex', gap: 5 }}>
                  <a
                    href={dialInfo.telHref}
                    className="hw-btn danger"
                    style={{ height: 23, padding: '0 8px', fontSize: 10.5, textDecoration: 'none' }}
                    onClick={() => onTriggerEmergencyCall('Immediate SOS override')}
                  >
                    Call now
                  </a>
                  <button
                    type="button"
                    className="hw-btn"
                    style={{ height: 23, padding: '0 8px', fontSize: 10.5 }}
                    onClick={onCancelAutoSos}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {emergencyCall?.active && (
              <div
                style={{
                  padding: '9px 10px',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'inset 3px 0 0 var(--status-danger)',
                  borderRadius: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="hw-led crit" />
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
                      Calling {emergencyCall.phoneDial}
                    </span>
                  </div>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                    {String(Math.floor(callElapsedSec / 60)).padStart(2, '0')}:
                    {String(callElapsedSec % 60).padStart(2, '0')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-secondary)' }}>
                  {emergencyCall.reason} · Speed {emergencyCall.speedKmh.toFixed(0)} km/h
                  {emergencyCall.lat != null && emergencyCall.lon != null
                    ? ` · GPS ${emergencyCall.lat.toFixed(4)}, ${emergencyCall.lon.toFixed(4)}`
                    : ''}
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <a
                    href={dialInfo.telHref}
                    className="hw-btn danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 10.5, textDecoration: 'none' }}
                  >
                    Redial
                  </a>
                  <a
                    href={`sms:${dialInfo.display}?body=${sosBodyText}`}
                    className="hw-btn"
                    style={{ height: 24, padding: '0 8px', fontSize: 10.5, textDecoration: 'none' }}
                  >
                    SMS GPS
                  </a>
                  <a
                    href={`${dialInfo.waHref}?text=${sosBodyText}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hw-btn"
                    style={{ height: 24, padding: '0 8px', fontSize: 10.5, textDecoration: 'none' }}
                  >
                    WhatsApp SOS
                  </a>
                  <button
                    type="button"
                    className="hw-btn"
                    style={{ height: 24, padding: '0 8px', fontSize: 10.5, marginLeft: 'auto' }}
                    onClick={onDismissEmergencyCall}
                  >
                    End
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="inst-bay">
        <div className="inst-bay-header">
          <div>
            <div className="inst-bay-title">Incident Stream</div>
            <div className="inst-bay-subtitle">Live SHA-256 chained detections</div>
          </div>
          <OdometerValue value={recentIncidents.length} fontSize={12} color="var(--ink-secondary)" />
        </div>

        <div className="inst-bay-body" style={{ maxHeight: 290, overflowY: 'auto', padding: '9px 11px' }}>
          {recentIncidents.length === 0 ? (
            <div
              style={{
                padding: '22px 10px',
                textAlign: 'center',
                color: 'var(--ink-muted)',
                fontSize: 12,
              }}
            >
              No safety incidents recorded yet.
              <div style={{ fontSize: 11, marginTop: 3 }}>
                Detections are written directly to Supabase PostgreSQL.
              </div>
            </div>
          ) : (
            <div ref={streamListRef} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recentIncidents.slice(0, 18).map((inc) => (
                <div
                  key={inc.id}
                  onClick={() => onSelectIncidentForensics(inc)}
                  style={{
                    padding: '9px 11px',
                    background: 'var(--bg-well)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <span className={`sev-badge ${inc.severity}`}>
                      {formatCategoryLabel(inc.category)}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)', flexShrink: 0 }}>
                      #{inc.seq} · {new Date(inc.timestamp_iso).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 5, color: 'var(--ink-primary)', lineHeight: 1.4 }}>
                    {inc.summary}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--ink-muted)',
                      marginTop: 5,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatInterventionLabel(inc.intervention_action)}
                    </span>
                    <span className="mono" style={{ fontSize: 10, flexShrink: 0 }}>
                      {inc.entry_hash.slice(0, 10)}…
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
