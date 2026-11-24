import React, { useEffect, useRef, useState } from 'react';
import anime from 'animejs';
import QRCode from 'qrcode';
import { SUPABASE_EDGE_URL } from '../lib/supabase';
import { SlidingSegmentedControl } from './SlidingSegmentedControl';
import type {
  AnalyzedTelemetryReport,
  ConnectedSensorNode,
  KinematicMetrics,
  KinematicSourceMode,
} from '../types/telemetry';
import type { ManualRigControls } from '../engines/kinematicEngine';

interface TelemetrySourceDeckProps {
  activeSource: KinematicSourceMode;
  kinematicMetrics: KinematicMetrics;
  theme: 'dark' | 'light';
  sensorNodes: ConnectedSensorNode[];
  lanSensorUrl: string | null;
  onStartLocalImu: () => void;
  onTareLocalImu: () => void;
  onAwaitRemotePhone: () => void;
  onEnableManualRig: () => void;
  onDisconnectSource: () => void;
  onSetRigControl: (partial: Partial<ManualRigControls>) => void;
  onAnalyzeFile: (file: File, persistToLedger: boolean) => Promise<void>;
  fileAnalysisReport: AnalyzedTelemetryReport | null;
  fileAnalyzing: boolean;
  fileError: string | null;
  replayProgress: { index: number; total: number; paused: boolean; speedFactor: number };
  onControlReplay: (opts: { paused?: boolean; speedFactor?: number; seekIndex?: number }) => void;
}

type SourceTab = 'PHONE_BRIDGE' | 'FILE_LOG' | 'LOCAL_IMU' | 'HIL_RIG' | 'CLOUD_API';

const SOURCE_TABS: Array<{ id: SourceTab; label: string }> = [
  { id: 'PHONE_BRIDGE', label: 'Phone QR' },
  { id: 'FILE_LOG', label: 'OBD / CSV log' },
  { id: 'LOCAL_IMU', label: 'Device IMU' },
  { id: 'HIL_RIG', label: 'Dynamics rig' },
  { id: 'CLOUD_API', label: 'HTTP ingest' },
];

export const TelemetrySourceDeck: React.FC<TelemetrySourceDeckProps> = ({
  activeSource,
  kinematicMetrics,
  theme,
  sensorNodes,
  lanSensorUrl,
  onStartLocalImu,
  onTareLocalImu,
  onAwaitRemotePhone,
  onEnableManualRig,
  onDisconnectSource,
  onSetRigControl,
  onAnalyzeFile,
  fileAnalysisReport,
  fileAnalyzing,
  fileError,
  replayProgress,
  onControlReplay,
}) => {
  const [tab, setTab] = useState<SourceTab>('PHONE_BRIDGE');
  const prevTabIdxRef = useRef<number>(0);
  const contentPanelRef = useRef<HTMLDivElement | null>(null);
  const [qrSvg, setQrSvg] = useState<string>('');
  const [persistOnUpload, setPersistOnUpload] = useState<boolean>(true);
  const [pressedKeys, setPressedKeys] = useState<Record<string, boolean>>({});
  const csvInputRef = useRef<HTMLInputElement | null>(null);

  const sensorPairUrl = lanSensorUrl || `${window.location.origin}/sensor`;

  const handleSelectTab = (next: SourceTab) => {
    const nextIdx = SOURCE_TABS.findIndex((t) => t.id === next);
    const dir = nextIdx >= prevTabIdxRef.current ? 1 : -1;
    prevTabIdxRef.current = nextIdx;
    setTab(next);

    requestAnimationFrame(() => {
      if (contentPanelRef.current) {
        anime.remove(contentPanelRef.current);
        anime({
          targets: contentPanelRef.current,
          translateX: [dir * 14, 0],
          opacity: [0.25, 1],
          easing: 'spring(1, 95, 15, 0)',
        });
      }
    });
  };

  useEffect(() => {
    const darkHex = theme === 'light' ? '#181816' : '#eceae4';
    QRCode.toString(sensorPairUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: darkHex, light: '#00000000' },
    })
      .then(setQrSvg)
      .catch(() => setQrSvg(''));
  }, [sensorPairUrl, theme]);

  useEffect(() => {
    if (activeSource !== 'MANUAL_DYNAMICS_RIG') {
      setPressedKeys({});
      return;
    }

    const handleKey = (down: boolean) => (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const code = e.code;
      if (
        [
          'KeyW',
          'ArrowUp',
          'KeyS',
          'ArrowDown',
          'KeyA',
          'ArrowLeft',
          'KeyD',
          'ArrowRight',
          'Space',
          'ShiftLeft',
          'ShiftRight',
        ].includes(code)
      ) {
        e.preventDefault();
      }
      setPressedKeys((prev) => ({ ...prev, [code]: down }));

      if (code === 'KeyW' || code === 'ArrowUp') onSetRigControl({ throttle: down, boost: e.shiftKey && down });
      if (code === 'ShiftLeft' || code === 'ShiftRight') onSetRigControl({ boost: down });
      if (code === 'KeyS' || code === 'ArrowDown') onSetRigControl({ brake: down });
      if (code === 'Space') onSetRigControl({ emergencyBrake: down });
      if (code === 'KeyA' || code === 'ArrowLeft') onSetRigControl({ steerLeft: down });
      if (code === 'KeyD' || code === 'ArrowRight') onSetRigControl({ steerRight: down });
    };

    const onDown = handleKey(true);
    const onUp = handleKey(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [activeSource, onSetRigControl]);

  const wheelAngleDeg = Math.max(-75, Math.min(75, kinematicMetrics.yawRateDegS * 1.9));

  return (
    <section className="inst-bay">
      <div className="inst-bay-header">
        <div>
          <div className="inst-bay-title">Telemetry Input</div>
          <div className="inst-bay-subtitle">Mobile IMU bridge, OBD/CSV logs &amp; vehicle test rig</div>
        </div>
        {activeSource !== 'DISCONNECTED' && (
          <button
            type="button"
            className="hw-btn danger"
            style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
            onClick={onDisconnectSource}
          >
            Disconnect
          </button>
        )}
      </div>

      <div className="inst-bay-body">
        <div style={{ marginBottom: 11 }}>
          <SlidingSegmentedControl
            options={SOURCE_TABS}
            value={tab}
            onChange={handleSelectTab}
            size="sm"
            ariaLabel="Telemetry source selector"
          />
        </div>

        <div ref={contentPanelRef}>
          {tab === 'PHONE_BRIDGE' && (
            <div style={{ display: 'grid', gridTemplateColumns: '104px 1fr', gap: 12, alignItems: 'center' }}>
              <div
                className="scope-well"
                style={{ width: 104, height: 104, padding: 6, display: 'grid', placeItems: 'center' }}
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 3 }}>
                  Pair smartphone as 3-axis IMU &amp; GPS sensor
                </div>
                <div style={{ color: 'var(--ink-secondary)', fontSize: 11.5, marginBottom: 9 }}>
                  Scan or open <span className="mono" style={{ color: 'var(--ink-primary)' }}>{sensorPairUrl}</span> on a phone to stream live accelerometer, yaw rate, and GPS speed over Supabase Realtime (accept local HTTPS prompt once on mobile).
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`hw-btn ${activeSource === 'REMOTE_MOBILE_SENSOR' ? 'selected' : 'primary'}`}
                    onClick={onAwaitRemotePhone}
                  >
                    {activeSource === 'REMOTE_MOBILE_SENSOR' ? 'Listening for phone stream' : 'Listen for phone sensor'}
                  </button>
                  <a
                    href="/sensor"
                    target="_blank"
                    rel="noreferrer"
                    className="hw-btn"
                    style={{ textDecoration: 'none' }}
                  >
                    Open /sensor view
                  </a>
                </div>
                {sensorNodes.length > 0 && (
                  <div className="mono" style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-secondary)' }}>
                    Connected: {sensorNodes.map((n) => `${n.nodeId} (${n.packetCount} pkts)`).join(' · ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'FILE_LOG' && (
            <div>
              <div style={{ color: 'var(--ink-secondary)', fontSize: 11.5, marginBottom: 9 }}>
                Upload recorded OBD-II, Phyphox, Sensor Logger, or GPS CSV/JSON files. Evaluated by the <span className="mono">dms9-telemetry</span> Supabase Edge Function.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="hw-btn primary"
                  disabled={fileAnalyzing}
                  onClick={() => csvInputRef.current?.click()}
                >
                  {fileAnalyzing ? 'Analyzing log…' : 'Upload CSV / JSON'}
                </button>
                <label style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={persistOnUpload}
                    style={{ accentColor: 'var(--ink-primary)' }}
                    onChange={(e) => setPersistOnUpload(e.target.checked)}
                  />
                  Save detected events to ledger
                </label>
              </div>

              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,.json,.txt"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onAnalyzeFile(file, persistOnUpload);
                  e.target.value = '';
                }}
              />

              {fileError && (
                <div style={{ marginTop: 8, color: 'var(--status-danger)', fontSize: 11.5 }}>
                  {fileError}
                </div>
              )}

              {fileAnalysisReport && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 9,
                    background: 'var(--bg-well)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--ink-primary)' }}>
                      {fileAnalysisReport.analysis.summary.sampleCount} samples ·{' '}
                      {fileAnalysisReport.analysis.summary.distanceKm} km · peak {fileAnalysisReport.analysis.summary.peakSpeedKmh} km/h ·{' '}
                      {fileAnalysisReport.analysis.summary.eventCount} events
                    </span>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button
                        type="button"
                        className="hw-btn"
                        style={{ height: 25, padding: '0 8px', fontSize: 11 }}
                        onClick={() => onControlReplay({ paused: !replayProgress.paused })}
                      >
                        {replayProgress.paused ? 'Resume' : 'Pause'}
                      </button>
                      {[1, 2, 4].map((spd) => (
                        <button
                          key={spd}
                          type="button"
                          className={`hw-btn ${replayProgress.speedFactor === spd ? 'selected' : ''}`}
                          style={{ height: 25, padding: '0 7px', fontSize: 11 }}
                          onClick={() => onControlReplay({ speedFactor: spd, paused: false })}
                        >
                          {spd}x
                        </button>
                      ))}
                      <button
                        type="button"
                        className="hw-btn"
                        style={{ height: 25, padding: '0 8px', fontSize: 11 }}
                        onClick={() => onControlReplay({ seekIndex: 0, paused: false })}
                      >
                        Restart
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'LOCAL_IMU' && (
            <div>
              <div style={{ color: 'var(--ink-secondary)', fontSize: 11.5, marginBottom: 9 }}>
                Reads native browser <span className="mono">DeviceMotionEvent</span> 3-axis linear acceleration, yaw rate, and GPS ground velocity from this device.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`hw-btn ${activeSource === 'LOCAL_DEVICE_IMU' ? 'selected' : 'primary'}`}
                  onClick={onStartLocalImu}
                >
                  {activeSource === 'LOCAL_DEVICE_IMU' ? 'Local IMU active' : 'Connect local IMU & GPS'}
                </button>
                <button
                  type="button"
                  className="hw-btn"
                  disabled={activeSource !== 'LOCAL_DEVICE_IMU'}
                  onClick={onTareLocalImu}
                >
                  Zero mount angle
                </button>
              </div>
            </div>
          )}

          {tab === 'HIL_RIG' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                <span style={{ color: 'var(--ink-secondary)', fontSize: 11.5 }}>
                  Manual 2D rigid-body vehicle physics rig for testing braking, throttle surge, overspeed, slalom, and speed-governor intervention.
                </span>
                {activeSource !== 'MANUAL_DYNAMICS_RIG' && (
                  <button type="button" className="hw-btn primary" onClick={onEnableManualRig}>
                    Open dynamics rig
                  </button>
                )}
              </div>

              {activeSource === 'MANUAL_DYNAMICS_RIG' && (
                <>
                  {/* Live Animated Steering Column & Hydraulic Pedal Pressure Telemetry */}
                  <div
                    className="scope-well"
                    style={{
                      padding: '7px 12px',
                      marginBottom: 8,
                      display: 'grid',
                      gridTemplateColumns: '48px 1fr 1fr',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <svg viewBox="0 0 44 44" width="42" height="42">
                      <g
                        transform={`rotate(${wheelAngleDeg.toFixed(1)} 22 22)`}
                        style={{ transition: 'transform 0.08s ease-out' }}
                      >
                        <circle cx="22" cy="22" r="17" fill="none" stroke="var(--ink-primary)" strokeWidth="2.4" />
                        <line x1="6" y1="22" x2="38" y2="22" stroke="var(--ink-secondary)" strokeWidth="2" />
                        <line x1="22" y1="22" x2="22" y2="38" stroke="var(--ink-secondary)" strokeWidth="2" />
                        <circle cx="22" cy="7" r="2" fill="var(--status-danger)" />
                      </g>
                    </svg>

                    <div>
                      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                        <span style={{ color: 'var(--ink-muted)' }}>THROTTLE</span>
                        <span>{kinematicMetrics.throttlePct ?? 0}%</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg-subtle)', borderRadius: 2, overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${kinematicMetrics.throttlePct ?? 0}%`,
                            background: 'var(--ink-primary)',
                            transition: 'width 0.08s linear',
                          }}
                        />
                      </div>
                    </div>

                    <div>
                      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 4 }}>
                        <span style={{ color: 'var(--ink-muted)' }}>BRAKE PRESSURE</span>
                        <span>{kinematicMetrics.brakePct ?? 0}%</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg-subtle)', borderRadius: 2, overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${kinematicMetrics.brakePct ?? 0}%`,
                            background: 'var(--status-danger)',
                            transition: 'width 0.08s linear',
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="pedal-deck">
                    <button
                      type="button"
                      className={`pedal-pad ${pressedKeys.KeyW || pressedKeys.ArrowUp ? 'pressed' : ''}`}
                      onMouseDown={() => onSetRigControl({ throttle: true, boost: false })}
                      onMouseUp={() => onSetRigControl({ throttle: false, boost: false })}
                      onMouseLeave={() => onSetRigControl({ throttle: false, boost: false })}
                      onTouchStart={() => onSetRigControl({ throttle: true, boost: false })}
                      onTouchEnd={() => onSetRigControl({ throttle: false, boost: false })}
                    >
                      <span>Throttle</span>
                      <span className="mono" style={{ opacity: 0.6, fontSize: 10 }}>W / Up</span>
                    </button>

                    <button
                      type="button"
                      className={`pedal-pad ${pressedKeys.ShiftLeft ? 'pressed' : ''}`}
                      onMouseDown={() => onSetRigControl({ throttle: true, boost: true })}
                      onMouseUp={() => onSetRigControl({ throttle: false, boost: false })}
                      onMouseLeave={() => onSetRigControl({ throttle: false, boost: false })}
                      onTouchStart={() => onSetRigControl({ throttle: true, boost: true })}
                      onTouchEnd={() => onSetRigControl({ throttle: false, boost: false })}
                    >
                      <span>Kickdown surge</span>
                      <span className="mono" style={{ opacity: 0.6, fontSize: 10 }}>Shift + W</span>
                    </button>

                    <button
                      type="button"
                      className={`pedal-pad ${pressedKeys.Space ? 'pressed' : ''}`}
                      onMouseDown={() => onSetRigControl({ emergencyBrake: true })}
                      onMouseUp={() => onSetRigControl({ emergencyBrake: false })}
                      onMouseLeave={() => onSetRigControl({ emergencyBrake: false })}
                      onTouchStart={() => onSetRigControl({ emergencyBrake: true })}
                      onTouchEnd={() => onSetRigControl({ emergencyBrake: false })}
                    >
                      <span>Emergency brake</span>
                      <span className="mono" style={{ opacity: 0.6, fontSize: 10 }}>Space</span>
                    </button>

                    <button
                      type="button"
                      className={`pedal-pad ${pressedKeys.KeyA || pressedKeys.ArrowLeft ? 'pressed' : ''}`}
                      onMouseDown={() => onSetRigControl({ steerLeft: true })}
                      onMouseUp={() => onSetRigControl({ steerLeft: false })}
                      onMouseLeave={() => onSetRigControl({ steerLeft: false })}
                      onTouchStart={() => onSetRigControl({ steerLeft: true })}
                      onTouchEnd={() => onSetRigControl({ steerLeft: false })}
                    >
                      <span>Steer left</span>
                      <span className="mono" style={{ opacity: 0.6, fontSize: 10 }}>A / Left</span>
                    </button>

                    <button
                      type="button"
                      className={`pedal-pad ${pressedKeys.KeyS || pressedKeys.ArrowDown ? 'pressed' : ''}`}
                      onMouseDown={() => onSetRigControl({ brake: true })}
                      onMouseUp={() => onSetRigControl({ brake: false })}
                      onMouseLeave={() => onSetRigControl({ brake: false })}
                      onTouchStart={() => onSetRigControl({ brake: true })}
                      onTouchEnd={() => onSetRigControl({ brake: false })}
                    >
                      <span>Service brake</span>
                      <span className="mono" style={{ opacity: 0.6, fontSize: 10 }}>S / Down</span>
                    </button>

                    <button
                      type="button"
                      className={`pedal-pad ${pressedKeys.KeyD || pressedKeys.ArrowRight ? 'pressed' : ''}`}
                      onMouseDown={() => onSetRigControl({ steerRight: true })}
                      onMouseUp={() => onSetRigControl({ steerRight: false })}
                      onMouseLeave={() => onSetRigControl({ steerRight: false })}
                      onTouchStart={() => onSetRigControl({ steerRight: true })}
                      onTouchEnd={() => onSetRigControl({ steerRight: false })}
                    >
                      <span>Steer right</span>
                      <span className="mono" style={{ opacity: 0.6, fontSize: 10 }}>D / Right</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'CLOUD_API' && (
            <div>
              <div style={{ color: 'var(--ink-secondary)', fontSize: 11.5, marginBottom: 6 }}>
                Push live JSON frames from an OBD-II reader, Raspberry Pi, or microcontroller to the Supabase Edge endpoint:
              </div>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 9,
                  background: 'var(--bg-well)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 4,
                  fontSize: 10.5,
                  overflowX: 'auto',
                  color: 'var(--ink-primary)',
                }}
              >
{`curl -X POST "${SUPABASE_EDGE_URL}/ingest" \\
  -H "Content-Type: application/json" \\
  -d '{"nodeId":"OBD-01","speedKmh":78.4,"accelLongMs2":-4.6,"accelLatMs2":0.4,"yawRateDegS":3.2}'`}
              </pre>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
