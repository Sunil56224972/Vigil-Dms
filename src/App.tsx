import React, { useCallback, useEffect, useRef, useState } from 'react';
import anime from 'animejs';
import {
  DEFAULT_THRESHOLDS_CLIENT,
  VEHICLE_PROFILE_PRESETS,
  analyzeTelemetryLogCloud,
  createDrivingSession,
  createRealtimeTelemetryBus,
  fetchDrivingSessions,
  fetchSafetyIncidents,
  fetchThresholdsConfig,
  logSafetyIncident,
  persistThresholdsConfig,
  supabase,
  syncDrivingSessionMetrics,
  verifyBlackboxChain,
} from './lib/supabase';
import { OcularBiometricEngine } from './engines/ocularEngine';
import {
  KinematicTelemetryEngine,
  type ManualRigControls,
} from './engines/kinematicEngine';
import { PreventiveInterventionEngine } from './engines/interventionEngine';
import { SignalSchematicBus } from './components/SignalSchematicBus';
import { SlidingSegmentedControl } from './components/SlidingSegmentedControl';
import { OpticalViewport } from './components/OpticalViewport';
import { BiometricOscilloscope } from './components/BiometricOscilloscope';
import { KinematicScopes } from './components/KinematicScopes';
import { TelemetrySourceDeck } from './components/TelemetrySourceDeck';
import { InterventionMatrix } from './components/InterventionMatrix';
import { BlackboxLedger } from './components/BlackboxLedger';
import { MobileSensorNode } from './components/MobileSensorNode';
import type {
  ActiveInterventionState,
  AnalyzedTelemetryReport,
  ConnectedSensorNode,
  IncidentRecord,
  KinematicMetrics,
  LedgerVerification,
  OcularLandmarksOverlay,
  OcularMetrics,
  OpticalSourceMode,
  SessionRecord,
  ThresholdsConfig,
  VehicleProfileKey,
} from './types/telemetry';

export const App: React.FC = () => {
  const isSensorRoute =
    typeof window !== 'undefined' &&
    (window.location.pathname.startsWith('/sensor') ||
      new URLSearchParams(window.location.search).get('mode') === 'sensor');

  if (isSensorRoute) {
    return <MobileSensorNode />;
  }

  return <CockpitStation />;
};

const CockpitStation: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('vigil_dms_theme');
    return saved === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vigil_dms_theme', theme);
  }, [theme]);

  const [viewMode, setViewMode] = useState<'COCKPIT' | 'FORENSICS'>('COCKPIT');
  const [thresholds, setThresholds] = useState<ThresholdsConfig>(DEFAULT_THRESHOLDS_CLIENT);
  const [supabaseReady, setSupabaseReady] = useState<boolean>(false);
  const [lanSensorUrl, setLanSensorUrl] = useState<string | null>(null);

  const ocularEngineRef = useRef(new OcularBiometricEngine());
  const kinematicEngineRef = useRef(new KinematicTelemetryEngine());
  const interventionEngineRef = useRef(new PreventiveInterventionEngine());

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const overlayRef = useRef<OcularLandmarksOverlay | null>(null);
  const cockpitGridRef = useRef<HTMLDivElement | null>(null);
  const alertStripRef = useRef<HTMLDivElement | null>(null);

  const [opticalMode, setOpticalMode] = useState<OpticalSourceMode>('OFFLINE');
  const [modelLoading, setModelLoading] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [ocularMetrics, setOcularMetrics] = useState<OcularMetrics>(() =>
    ocularEngineRef.current.createStandbySnapshot('OFFLINE')
  );
  const [kinematicMetrics, setKinematicMetrics] = useState<KinematicMetrics>(() =>
    kinematicEngineRef.current.tick(DEFAULT_THRESHOLDS_CLIENT, false, false, false)
  );
  const [intervention, setIntervention] = useState<ActiveInterventionState>({
    stage: 0,
    headline: 'Monitoring ready',
    subline: 'Connect optical camera or vehicle telemetry input to begin.',
    category: null,
    governorActive: false,
    hazardStrobeActive: false,
    wakeFlashActive: false,
    lockoutRequiresCheck: false,
    alertnessHoldProgress: 0,
    triggeredAtMs: null,
  });

  const [driverTag, setDriverTag] = useState('Driver-01');
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<IncidentRecord | null>(null);
  const [ledgerProof, setLedgerProof] = useState<LedgerVerification | null>(null);
  const [verifyingLedger, setVerifyingLedger] = useState(false);

  const [sensorNodes, setSensorNodes] = useState<ConnectedSensorNode[]>([]);
  const [fileReport, setFileReport] = useState<AnalyzedTelemetryReport | null>(null);
  const [fileAnalyzing, setFileAnalyzing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [replayProgress, setReplayProgress] = useState({
    index: 0,
    total: 0,
    paused: false,
    speedFactor: 1,
  });

  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;
  const opticalModeRef = useRef(opticalMode);
  opticalModeRef.current = opticalMode;
  const activeSessionRef = useRef<SessionRecord | null>(activeSession);
  activeSessionRef.current = activeSession;

  const sessionPeaksRef = useRef({
    peakSpeedKmh: 0,
    peakLongG: 0,
    peakLatG: 0,
    minEar: null as number | null,
    peakPerclos: 0,
    sourceModes: new Set<string>(),
  });

  const captureOpticalEvidence = useCallback((): string | null => {
    const vid = videoRef.current;
    if (!vid || vid.readyState < 2 || vid.videoWidth === 0) return null;
    try {
      const off = document.createElement('canvas');
      off.width = 320;
      off.height = Math.round((320 * vid.videoHeight) / vid.videoWidth);
      const ctx = off.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(vid, 0, 0, off.width, off.height);
      return off.toDataURL('image/jpeg', 0.62);
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!cockpitGridRef.current) return;
    const bays = cockpitGridRef.current.querySelectorAll('.inst-bay');
    anime({
      targets: bays,
      translateY: [10, 0],
      opacity: [0, 1],
      easing: 'spring(1, 90, 15, 0)',
      delay: anime.stagger(50),
    });
  }, [viewMode]);

  useEffect(() => {
    if (intervention.stage >= 2 && alertStripRef.current) {
      anime({
        targets: alertStripRef.current,
        translateX: [-4, 4, -2, 2, 0],
        duration: 300,
        easing: 'easeOutQuad',
      });
    }
  }, [intervention.stage, intervention.triggeredAtMs]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const [cfg, sessList, incList, proof] = await Promise.all([
        fetchThresholdsConfig(),
        fetchDrivingSessions(25),
        fetchSafetyIncidents(null, 80),
        verifyBlackboxChain(),
      ]);
      if (!mounted) return;
      setThresholds(cfg);
      setSessions(sessList);
      setIncidents(incList);
      setLedgerProof(proof);
      setSupabaseReady(proof.reason !== 'RPC_UNREACHABLE');
    })();

    fetch('/api/system/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (mounted && data?.network?.sensorHttpsUrl) {
          setLanSensorUrl(data.network.sensorHttpsUrl);
        }
      })
      .catch(() => {});

    const channel = createRealtimeTelemetryBus({
      onSensorFrame: (frame) => {
        kinematicEngineRef.current.ingestExternalFrame(frame);
        const nodeId = String(frame.nodeId || 'PHONE-IMU');
        setSensorNodes((prev) => {
          const existing = prev.find((n) => n.nodeId === nodeId);
          if (existing) {
            return prev.map((n) =>
              n.nodeId === nodeId
                ? {
                    ...n,
                    packetCount: n.packetCount + 1,
                    lastPacketAt: Date.now(),
                    hasGps: n.hasGps || frame.speedKmh != null,
                  }
                : n
            );
          }
          return [
            ...prev,
            {
              nodeId,
              label: nodeId,
              packetCount: 1,
              lastPacketAt: Date.now(),
              hasGps: frame.speedKmh != null,
              transport: 'SUPABASE_REALTIME',
            },
          ];
        });
      },
      onIncidentInsert: (inc) => {
        setIncidents((prev) => (prev.some((x) => x.id === inc.id) ? prev : [inc, ...prev]));
      },
      onSessionChange: (sess) => {
        setSessions((prev) => {
          const idx = prev.findIndex((x) => x.id === sess.id);
          if (idx === -1) return [sess, ...prev];
          const copy = [...prev];
          copy[idx] = sess;
          return copy;
        });
        if (activeSessionRef.current?.id === sess.id) {
          setActiveSession(sess);
        }
      },
    });

    let localWs: WebSocket | null = null;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      localWs = new WebSocket(`${proto}//${window.location.host}/ws?role=cockpit`);
      localWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'EXTERNAL_TELEMETRY_FRAME' && msg.frame) {
            kinematicEngineRef.current.ingestExternalFrame(msg.frame);
          }
        } catch {
          // Ignore malformed WS message
        }
      };
    } catch {
      // Supabase Realtime remains active
    }

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
      localWs?.close();
    };
  }, []);

  useEffect(() => {
    let rafId = 0;
    let lastReactStateCommitMs = 0;
    let lastSessionCloudSyncMs = 0;
    let latestOcular = ocularEngineRef.current.createStandbySnapshot('OFFLINE');
    let autoDecelRef = false;
    let govRef = false;
    let hazRef = false;

    const step = (now: number) => {
      const th = thresholdsRef.current;
      const optMode = opticalModeRef.current;

      if (optMode !== 'OFFLINE' && videoRef.current) {
        const res = ocularEngineRef.current.processVideoFrame(videoRef.current, optMode, th);
        if (res) {
          latestOcular = res.metrics;
          overlayRef.current = res.overlay;
        }
      } else {
        latestOcular = ocularEngineRef.current.createStandbySnapshot('OFFLINE');
        overlayRef.current = null;
      }

      const kin = kinematicEngineRef.current.tick(th, govRef, hazRef, autoDecelRef);
      const evalOut = interventionEngineRef.current.evaluate(latestOcular, kin, th);
      govRef = evalOut.state.governorActive;
      hazRef = evalOut.state.hazardStrobeActive;
      autoDecelRef = evalOut.autoDecelerateAssist;

      if (evalOut.emittedIncidents.length > 0) {
        for (const ev of evalOut.emittedIncidents) {
          const snap = ev.captureOpticalSnapshot ? captureOpticalEvidence() : null;
          logSafetyIncident({
            sessionId: activeSessionRef.current?.id ?? null,
            category: ev.category,
            severity: ev.severity,
            stage: ev.stage,
            summary: ev.summary,
            interventionAction: ev.interventionAction,
            metrics: ev.metrics,
            frameEvidence: snap,
            webhookUrl: th.webhookUrl,
          }).then((saved) => {
            if (saved) {
              setIncidents((prev) => (prev.some((x) => x.id === saved.id) ? prev : [saved, ...prev]));
            }
          });
        }
      }

      if (activeSessionRef.current) {
        const p = sessionPeaksRef.current;
        if (optMode !== 'OFFLINE') p.sourceModes.add(optMode);
        if (kin.active) p.sourceModes.add(kin.source);
        p.peakSpeedKmh = Math.max(p.peakSpeedKmh, kin.speedKmh);
        p.peakLongG = Math.max(p.peakLongG, Math.abs(kin.longG));
        p.peakLatG = Math.max(p.peakLatG, Math.abs(kin.latG));
        if (latestOcular.active && latestOcular.faceDetected) {
          p.minEar = p.minEar == null ? latestOcular.earMean : Math.min(p.minEar, latestOcular.earMean);
          p.peakPerclos = Math.max(p.peakPerclos, latestOcular.perclos60);
        }

        if (now - lastSessionCloudSyncMs >= 6000) {
          lastSessionCloudSyncMs = now;
          syncDrivingSessionMetrics(activeSessionRef.current.id, {
            distanceKm: kin.distanceKm,
            peakSpeedKmh: p.peakSpeedKmh,
            peakLongG: p.peakLongG,
            peakLatG: p.peakLatG,
            minEar: p.minEar,
            peakPerclos: p.peakPerclos,
            totalBlinks: latestOcular.blinkCount,
            totalYawns: latestOcular.yawnCount,
            sourceModes: Array.from(p.sourceModes),
          });
        }
      }

      if (now - lastReactStateCommitMs >= 55) {
        lastReactStateCommitMs = now;
        setOcularMetrics(latestOcular);
        setKinematicMetrics(kin);
        setIntervention(evalOut.state);
        if (kin.source === 'FILE_REPLAY') {
          setReplayProgress(kinematicEngineRef.current.getReplayProgress());
        }
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [captureOpticalEvidence]);

  const stopOpticalFeed = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute('src');
    }
    overlayRef.current = null;
    setOpticalMode('OFFLINE');
  }, []);

  const handleStartWebcam = useCallback(async () => {
    interventionEngineRef.current.unlockAudio();
    setCameraError(null);
    setModelLoading(true);
    try {
      await ocularEngineRef.current.ensureInitialized();
      stopOpticalFeed();

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 960 },
            height: { ideal: 600 },
            facingMode: 'user',
          },
          audio: false,
        });
      } catch {
        // Fallback for external USB cameras that reject resolution or facingMode hints
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.loop = false;
        await videoRef.current.play();
      }
      ocularEngineRef.current.resetSessionCounters();
      setOpticalMode('LIVE_WEBCAM');
    } catch (err) {
      setCameraError(
        err instanceof Error
          ? err.message
          : 'Camera access failed. Verify browser camera permissions.'
      );
    } finally {
      setModelLoading(false);
    }
  }, [stopOpticalFeed]);

  const handleUploadDriverVideo = useCallback(
    async (file: File) => {
      interventionEngineRef.current.unlockAudio();
      setCameraError(null);
      setModelLoading(true);
      try {
        await ocularEngineRef.current.ensureInitialized();
        stopOpticalFeed();

        const url = URL.createObjectURL(file);
        objectUrlRef.current = url;
        if (videoRef.current) {
          videoRef.current.src = url;
          videoRef.current.loop = true;
          await videoRef.current.play();
        }
        ocularEngineRef.current.resetSessionCounters();
        setOpticalMode('VIDEO_FILE');
      } catch (err) {
        setCameraError(err instanceof Error ? err.message : 'Unable to decode uploaded video file.');
      } finally {
        setModelLoading(false);
      }
    },
    [stopOpticalFeed]
  );

  const handleToggleSession = async () => {
    interventionEngineRef.current.unlockAudio();
    if (activeSession) {
      const p = sessionPeaksRef.current;
      const ended = await syncDrivingSessionMetrics(activeSession.id, {
        distanceKm: kinematicMetrics.distanceKm,
        peakSpeedKmh: p.peakSpeedKmh,
        peakLongG: p.peakLongG,
        peakLatG: p.peakLatG,
        minEar: p.minEar,
        peakPerclos: p.peakPerclos,
        totalBlinks: ocularMetrics.blinkCount,
        totalYawns: ocularMetrics.yawnCount,
        sourceModes: Array.from(p.sourceModes),
        ended: true,
      });
      setActiveSession(null);
      if (ended) {
        setSessions((prev) => prev.map((s) => (s.id === ended.id ? ended : s)));
      }
    } else {
      sessionPeaksRef.current = {
        peakSpeedKmh: 0,
        peakLongG: 0,
        peakLatG: 0,
        minEar: null,
        peakPerclos: 0,
        sourceModes: new Set<string>(),
      };
      kinematicEngineRef.current.resetDistance();
      ocularEngineRef.current.resetSessionCounters();

      const modes: string[] = [];
      if (opticalMode !== 'OFFLINE') modes.push(opticalMode);
      if (kinematicMetrics.active) modes.push(kinematicMetrics.source);

      const created = await createDrivingSession({
        driverTag,
        vehicleProfile: thresholds.vehicleProfile,
        sourceModes: modes,
      });
      if (created) {
        setActiveSession(created);
        setSessions((prev) => [created, ...prev.filter((x) => x.id !== created.id)]);
      }
    }
  };

  const handleAnalyzeTelemetryFile = async (file: File, persistToLedger: boolean) => {
    interventionEngineRef.current.unlockAudio();
    setFileAnalyzing(true);
    setFileError(null);
    try {
      const text = await file.text();
      const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
      const report = await analyzeTelemetryLogCloud({
        content: text,
        format,
        persistIncidents: persistToLedger,
        sessionId: activeSession?.id ?? null,
      });
      setFileReport(report);
      kinematicEngineRef.current.startFileReplay(report.samples, `Log: ${file.name.slice(0, 16)}`);
      if (persistToLedger && report.persistedCount > 0) {
        const [freshInc, proof] = await Promise.all([
          fetchSafetyIncidents(null, 100),
          verifyBlackboxChain(),
        ]);
        setIncidents(freshInc);
        setLedgerProof(proof);
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Telemetry log analysis failed.');
    } finally {
      setFileAnalyzing(false);
    }
  };

  const handleUpdateThresholds = async (partial: Partial<ThresholdsConfig>) => {
    interventionEngineRef.current.unlockAudio();
    const next = { ...thresholds, ...partial };
    setThresholds(next);
    const saved = await persistThresholdsConfig(partial);
    setThresholds(saved);
  };

  const handleSelectPreset = async (profile: VehicleProfileKey) => {
    const preset = VEHICLE_PROFILE_PRESETS[profile];
    await handleUpdateThresholds({
      vehicleProfile: profile,
      speedLimitKmh: preset.speedLimitKmh,
      harshBrakeMs2: preset.harshBrakeMs2,
      rapidAccelMs2: preset.rapidAccelMs2,
      rashLatMs2: preset.rashLatMs2,
      rashJerkMs3: preset.rashJerkMs3,
    });
  };

  const handleVerifyChain = async () => {
    setVerifyingLedger(true);
    const proof = await verifyBlackboxChain();
    setLedgerProof(proof);
    setVerifyingLedger(false);
  };

  const handleSetRigControl = useCallback((partial: Partial<ManualRigControls>) => {
    kinematicEngineRef.current.setManualControls(partial);
  }, []);

  const displayHeadline =
    intervention.headline === 'SYSTEM NOMINAL' ? 'All channels nominal' : intervention.headline;

  return (
    <div className="dms-shell">
      {intervention.wakeFlashActive && <div className="dms-wake-strobe" />}

      <header className="dms-topbar">
        <div className="dms-brand">
          <div className="dms-brand-mark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
            </svg>
          </div>
          <div>
            <div className="dms-brand-title">Vigil DMS</div>
            <div className="dms-brand-sub">Driver Fatigue &amp; Vehicle Kinematics Monitor</div>
          </div>
        </div>

        <SlidingSegmentedControl
          options={[
            { id: 'COCKPIT', label: 'Live Monitor' },
            { id: 'FORENSICS', label: `Incident Ledger (${incidents.length})` },
          ]}
          value={viewMode}
          onChange={(next) => {
            setViewMode(next);
            if (next === 'FORENSICS') handleVerifyChain();
          }}
          ariaLabel="Primary navigation"
        />

        <div className="dms-topbar-cluster">
          <button
            type="button"
            className="hw-btn"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Switch cabin dark / studio light surface"
          >
            {theme === 'dark' ? 'Studio light' : 'Cabin dark'}
          </button>

          <div className="hw-pill">
            <span className={`hw-led ${supabaseReady ? 'ok' : 'warn'}`} />
            <span>Supabase PG17</span>
          </div>

          <input
            type="text"
            className="hw-input"
            style={{ width: 112 }}
            value={driverTag}
            disabled={Boolean(activeSession)}
            onChange={(e) => setDriverTag(e.target.value)}
            aria-label="Driver identifier"
          />

          <button
            type="button"
            className={`hw-btn ${activeSession ? 'danger' : 'primary'}`}
            onClick={handleToggleSession}
          >
            {activeSession && <span className="hw-led crit" />}
            {activeSession ? `End ${activeSession.id.slice(0, 10)}` : 'Start session'}
          </button>
        </div>
      </header>

      <div ref={alertStripRef} className={`dms-alert-strip stage-${intervention.stage}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="alert-stage-tag">
            Stage {intervention.stage} ·{' '}
            {intervention.stage === 0
              ? 'Nominal'
              : intervention.stage === 1
              ? 'Advisory'
              : intervention.stage === 2
              ? 'Warning'
              : 'Intervention'}
          </span>
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, marginRight: 8 }}>
              {displayHeadline}
            </span>{' '}
            <span style={{ color: 'var(--ink-secondary)', fontSize: 12 }}>
              {intervention.subline}
            </span>
          </div>
        </div>

        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>
          {activeSession
            ? `${activeSession.id} · Score ${Number(activeSession.safety_index).toFixed(0)}/100`
            : 'Monitoring (no active session)'}
        </div>
      </div>

      <SignalSchematicBus
        opticalActive={ocularMetrics.active}
        kinematicActive={kinematicMetrics.active}
        alertStage={intervention.stage}
        supabaseConnected={supabaseReady}
        incidentCount={incidents.length}
        fps={ocularMetrics.fps}
        kinematicSource={kinematicMetrics.source}
      />

      {viewMode === 'COCKPIT' ? (
        <main ref={cockpitGridRef} className="cockpit-grid">
          <div className="cockpit-col">
            <OpticalViewport
              videoRef={videoRef}
              hudCanvasRef={hudCanvasRef}
              metrics={ocularMetrics}
              overlayRef={overlayRef}
              thresholds={thresholds}
              cameraError={cameraError}
              modelLoading={modelLoading}
              onStartWebcam={handleStartWebcam}
              onStopOptical={stopOpticalFeed}
              onUploadVideoFile={handleUploadDriverVideo}
              onCalibrateNeutral={() => ocularEngineRef.current.startNeutralCalibration()}
            />

            <BiometricOscilloscope metrics={ocularMetrics} thresholds={thresholds} />
          </div>

          <div className="cockpit-col">
            <KinematicScopes
              metrics={kinematicMetrics}
              thresholds={thresholds}
              incidents={incidents}
            />

            <TelemetrySourceDeck
              activeSource={kinematicMetrics.source}
              kinematicMetrics={kinematicMetrics}
              theme={theme}
              sensorNodes={sensorNodes}
              lanSensorUrl={lanSensorUrl}
              onStartLocalImu={async () => {
                interventionEngineRef.current.unlockAudio();
                const res = await kinematicEngineRef.current.startLocalHardwareSensors();
                if (!res.ok && res.error) setFileError(res.error);
              }}
              onTareLocalImu={() => kinematicEngineRef.current.tareLocalGravity()}
              onAwaitRemotePhone={() => {
                interventionEngineRef.current.unlockAudio();
                kinematicEngineRef.current.enableRemoteMobileMode();
              }}
              onEnableManualRig={() => {
                interventionEngineRef.current.unlockAudio();
                kinematicEngineRef.current.enableManualDynamicsRig();
              }}
              onDisconnectSource={() => kinematicEngineRef.current.disconnect()}
              onSetRigControl={handleSetRigControl}
              onAnalyzeFile={handleAnalyzeTelemetryFile}
              fileAnalysisReport={fileReport}
              fileAnalyzing={fileAnalyzing}
              fileError={fileError}
              replayProgress={replayProgress}
              onControlReplay={(opts) => kinematicEngineRef.current.setReplayControls(opts)}
            />
          </div>

          <div className="cockpit-col">
            <InterventionMatrix
              intervention={intervention}
              thresholds={thresholds}
              recentIncidents={incidents}
              onUpdateThresholds={handleUpdateThresholds}
              onSelectPreset={handleSelectPreset}
              onManualResetLockout={() => interventionEngineRef.current.forceManualReset()}
              onTestAudioVoice={() =>
                interventionEngineRef.current.runSelfCheck(
                  thresholds.audioArmed,
                  thresholds.voiceArmed
                )
              }
              onSelectIncidentForensics={(inc) => {
                setSelectedIncident(inc);
                setViewMode('FORENSICS');
              }}
            />
          </div>
        </main>
      ) : (
        <div ref={cockpitGridRef}>
          <BlackboxLedger
            sessions={sessions}
            incidents={incidents}
            ledgerProof={ledgerProof}
            verifyingLedger={verifyingLedger}
            thresholds={thresholds}
            selectedIncident={selectedIncident}
            onSelectIncident={setSelectedIncident}
            onVerifyChain={handleVerifyChain}
            onSaveThresholds={handleUpdateThresholds}
          />
        </div>
      )}
    </div>
  );
};
