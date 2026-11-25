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
  const [showPstnSetup, setShowPstnSetup] = useState(false);
  const [waBridge, setWaBridge] = useState<{
    available: boolean;
    state: 'IDLE' | 'CONNECTING' | 'QR_READY' | 'CONNECTED';
    qrDataUrl: string | null;
    pairingCode: string | null;
    connectedUser: string | null;
  }>({
    available: false,
    state: 'IDLE',
    qrDataUrl: null,
    pairingCode: null,
    connectedUser: null,
  });

  useEffect(() => {
    let active = true;
    const pollWa = () => {
      fetch('/api/whatsapp/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (active && d?.whatsapp) {
            setWaBridge({
              available: true,
              state: d.whatsapp.state || 'IDLE',
              qrDataUrl: d.whatsapp.qrDataUrl || null,
              pairingCode: d.whatsapp.pairingCode || null,
              connectedUser: d.whatsapp.connectedUser || null,
            });
          }
        })
        .catch(() => {});
    };
    pollWa();
    const timer = showPstnSetup ? window.setInterval(pollWa, 1800) : null;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [showPstnSetup]);

  const handleConnectBuiltInWhatsApp = () => {
    setWaBridge((p) => ({ ...p, state: 'CONNECTING' }));
    fetch('/api/whatsapp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: thresholds.emergencyPhone || '7389416622' }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.whatsapp) {
          setWaBridge({
            available: true,
            state: d.whatsapp.state || 'CONNECTING',
            qrDataUrl: d.whatsapp.qrDataUrl || null,
            pairingCode: d.whatsapp.pairingCode || null,
            connectedUser: d.whatsapp.connectedUser || null,
          });
        }
      })
      .catch(() => {});
  };

  const handleDisconnectBuiltInWhatsApp = () => {
    fetch('/api/whatsapp/disconnect', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.whatsapp) {
          setWaBridge({
            available: true,
            state: 'IDLE',
            qrDataUrl: null,
            pairingCode: null,
            connectedUser: null,
          });
        }
      })
      .catch(() => {});
  };
  const [twilioCfg, setTwilioCfg] = useState<{
    callmebotKey: string;
    fast2smsKey: string;
    sid: string;
    token: string;
    from: string;
    autoOpenApp: boolean;
  }>(() => {
    try {
      const raw = localStorage.getItem('vigil_pstn_twilio');
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          callmebotKey: String(parsed.callmebotKey || ''),
          fast2smsKey: String(parsed.fast2smsKey || ''),
          sid: String(parsed.sid || ''),
          token: String(parsed.token || ''),
          from: String(parsed.from || ''),
          autoOpenApp: parsed.autoOpenApp !== false,
        };
      }
    } catch {}
    return {
      callmebotKey: '',
      fast2smsKey: '',
      sid: '',
      token: '',
      from: '',
      autoOpenApp: true,
    };
  });

  const updateTwilioCfg = (
    patch: Partial<{
      callmebotKey: string;
      fast2smsKey: string;
      sid: string;
      token: string;
      from: string;
      autoOpenApp: boolean;
    }>
  ) => {
    setTwilioCfg((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem('vigil_pstn_twilio', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const hasCloudGateway = Boolean(
    waBridge.state === 'CONNECTED' ||
      twilioCfg.callmebotKey.trim() ||
      twilioCfg.fast2smsKey.trim() ||
      (twilioCfg.sid.trim() && twilioCfg.token.trim() && twilioCfg.from.trim())
  );
  const isMobileBrowser =
    typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>Emergency SOS Auto-Msg &amp; Call</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                  Auto-sends SOS + live GPS on 5s microsleep
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className={`hw-btn ${hasCloudGateway || showPstnSetup ? 'selected' : ''}`}
                  style={{ height: 22, padding: '0 7px', fontSize: 10.5 }}
                  onClick={() => setShowPstnSetup((v) => !v)}
                  title="Configure automatic SMS / WhatsApp / Push / Voice gateways"
                >
                  {hasCloudGateway ? 'Auto-Msg Ready' : 'Auto-Msg Setup'}
                </button>
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

            {showPstnSetup && (
              <div
                style={{
                  padding: '8px 9px',
                  background: 'var(--bg-well)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 10.5, color: 'var(--ink-secondary)', lineHeight: 1.38 }}>
                  <strong>1. Zero-Key Instant Phone Alert (Works Immediately):</strong> Open{' '}
                  <a
                    href={`https://ntfy.sh/vigil-sos-${dialInfo.cleanDigits.slice(-10)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                    style={{ color: 'var(--ink-primary)' }}
                  >
                    ntfy.sh/vigil-sos-{dialInfo.cleanDigits.slice(-10)}
                  </a>{' '}
                  on your phone and tap <em>Subscribe</em> to receive instant background SOS alerts + GPS map.
                </div>

                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 5 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-secondary)', marginBottom: 4 }}>
                    <strong>2. Built-In Direct WhatsApp Auto-Sender (No API Key Needed):</strong>
                  </div>
                  {waBridge.available ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {waBridge.state === 'CONNECTED' ? (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-primary)' }}>
                            Connected (+{waBridge.connectedUser}) — Auto-sends text, photo &amp; GPS
                          </span>
                          <button
                            type="button"
                            className="hw-btn"
                            style={{ height: 23, padding: '0 8px', fontSize: 10.5 }}
                            onClick={handleDisconnectBuiltInWhatsApp}
                          >
                            Unlink
                          </button>
                        </div>
                      ) : (
                        <>
                          {waBridge.state === 'IDLE' && (
                            <button
                              type="button"
                              className="hw-btn primary"
                              style={{ height: 27, fontSize: 11 }}
                              onClick={handleConnectBuiltInWhatsApp}
                            >
                              Generate WhatsApp Link QR &amp; Code
                            </button>
                          )}
                          {waBridge.state === 'CONNECTING' && !waBridge.qrDataUrl && (
                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                              Connecting to WhatsApp Multi-Device bridge…
                            </div>
                          )}
                          {waBridge.qrDataUrl && (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                              <img
                                src={waBridge.qrDataUrl}
                                alt="WhatsApp Link QR"
                                style={{ width: 108, height: 108, borderRadius: 4, border: '1px solid var(--border-default)' }}
                              />
                              <div style={{ fontSize: 10.5, color: 'var(--ink-secondary)', lineHeight: 1.4 }}>
                                <div>Scan once in <strong>WhatsApp → Linked Devices → Link a Device</strong></div>
                                {waBridge.pairingCode && (
                                  <div style={{ marginTop: 5 }}>
                                    Or enter phone code:{' '}
                                    <strong className="mono" style={{ fontSize: 12, color: 'var(--ink-primary)' }}>
                                      {waBridge.pairingCode}
                                    </strong>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                      Run local server (<span className="mono">npm start</span> on localhost:4400) to use the built-in QR WhatsApp Auto-Sender, or use Step 1 / Step 3 on cloud.
                    </div>
                  )}
                </div>

                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 5 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-secondary)', marginBottom: 4 }}>
                    <strong>3. Automatic Indian SMS (+91 Fast2SMS) or Twilio SMS + Call:</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input
                      type="password"
                      className="hw-input mono"
                      style={{ height: 26, fontSize: 11 }}
                      placeholder="Fast2SMS API Key (instant +91 cellular SMS)"
                      value={twilioCfg.fast2smsKey}
                      onChange={(e) => updateTwilioCfg({ fast2smsKey: e.target.value })}
                    />
                    <input
                      type="text"
                      className="hw-input mono"
                      style={{ height: 26, fontSize: 11 }}
                      placeholder="Twilio Account SID (AC...)"
                      value={twilioCfg.sid}
                      onChange={(e) => updateTwilioCfg({ sid: e.target.value })}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                      <input
                        type="password"
                        className="hw-input mono"
                        style={{ height: 26, fontSize: 11 }}
                        placeholder="Twilio Auth Token"
                        value={twilioCfg.token}
                        onChange={(e) => updateTwilioCfg({ token: e.target.value })}
                      />
                      <input
                        type="tel"
                        className="hw-input mono"
                        style={{ height: 26, fontSize: 11 }}
                        placeholder="Twilio From (+1...)"
                        value={twilioCfg.from}
                        onChange={(e) => updateTwilioCfg({ from: e.target.value })}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 2 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--ink-secondary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={twilioCfg.autoOpenApp}
                      onChange={(e) => updateTwilioCfg({ autoOpenApp: e.target.checked })}
                    />
                    Auto-launch WhatsApp / SMS app if no API key
                  </label>
                  <button
                    type="button"
                    className="hw-btn"
                    style={{ height: 24, padding: '0 9px', fontSize: 10.5 }}
                    onClick={() => setShowPstnSetup(false)}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

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
              {isMobileBrowser ? (
                <a
                  href={`sms:${dialInfo.display}?body=${sosBodyText}`}
                  className="hw-btn danger"
                  style={{ textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}
                  onClick={() => onTriggerEmergencyCall('Manual emergency SOS alert')}
                >
                  SOS Msg {dialInfo.cleanDigits.slice(-10)}
                </a>
              ) : (
                <button
                  type="button"
                  className="hw-btn danger"
                  style={{ fontWeight: 600, whiteSpace: 'nowrap' }}
                  onClick={() => onTriggerEmergencyCall('Manual emergency SOS alert')}
                >
                  Send SOS {dialInfo.cleanDigits.slice(-10)}
                </button>
              )}
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
                      SOS Dispatched → {emergencyCall.phoneDial}
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
                <div style={{ fontSize: 11, color: 'var(--ink-secondary)' }}>
                  {emergencyCall.reason} · Speed {emergencyCall.speedKmh.toFixed(0)} km/h
                  {emergencyCall.lat != null && emergencyCall.lon != null
                    ? ` · GPS ${emergencyCall.lat.toFixed(4)}, ${emergencyCall.lon.toFixed(4)}`
                    : ''}
                </div>
                {emergencyCall.pstnMessage && (
                  <div
                    style={{
                      fontSize: 10.5,
                      lineHeight: 1.35,
                      padding: '5px 7px',
                      borderRadius: 3,
                      background: 'var(--bg-well)',
                      border: '1px solid var(--border-subtle)',
                      color:
                        emergencyCall.pstnStatus === 'RINGING'
                          ? 'var(--ink-primary)'
                          : emergencyCall.pstnStatus === 'FAILED'
                          ? 'var(--status-danger)'
                          : 'var(--ink-muted)',
                    }}
                  >
                    {emergencyCall.pstnMessage}
                    {emergencyCall.pstnStatus === 'NO_GATEWAY' && !showPstnSetup && (
                      <button
                        type="button"
                        onClick={() => setShowPstnSetup(true)}
                        style={{
                          marginLeft: 6,
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          textDecoration: 'underline',
                          color: 'var(--ink-primary)',
                          fontSize: 10.5,
                          cursor: 'pointer',
                        }}
                      >
                        Auto-Msg Setup
                      </button>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="hw-btn danger"
                    style={{ height: 24, padding: '0 8px', fontSize: 10.5 }}
                    onClick={() => onTriggerEmergencyCall('Manual PSTN redial')}
                  >
                    Redial
                  </button>
                  <a
                    href={dialInfo.telHref}
                    className="hw-btn"
                    style={{ height: 24, padding: '0 8px', fontSize: 10.5, textDecoration: 'none' }}
                  >
                    OS Dialer
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
