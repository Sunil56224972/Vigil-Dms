import React, { useCallback, useEffect, useRef, useState } from 'react';
import anime from 'animejs';
import {
  DEFAULT_THRESHOLDS_CLIENT,
  VEHICLE_PROFILE_PRESETS,
  analyzeTelemetryLogCloud,
  broadcastEmergencySos,
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
import { InterventionMatrix, formatDialNumber } from './components/InterventionMatrix';
import { BlackboxLedger } from './components/BlackboxLedger';
import { MobileSensorNode } from './components/MobileSensorNode';
import type {
  ActiveInterventionState,
  AnalyzedTelemetryReport,
  ConnectedSensorNode,
  EmergencyCallState,
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
    sosCountdownSec: null,
    triggeredAtMs: null,
  });
  const [emergencyCall, setEmergencyCall] = useState<EmergencyCallState | null>(null);

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

  const kinematicLatestRef = useRef<KinematicMetrics>(kinematicMetrics);
  kinematicLatestRef.current = kinematicMetrics;
  const ocularLatestRef = useRef<OcularMetrics>(ocularMetrics);
  ocularLatestRef.current = ocularMetrics;
  const snapshotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const persistTimerRef = useRef<number | null>(null);

  const captureOpticalEvidenceAsync = useCallback((): Promise<string | null> => {
    const enh = ocularLatestRef.current.nightVisionActive
      ? ocularEngineRef.current.getEnhancedCanvas()
      : null;
    const vid = videoRef.current;

    let src: CanvasImageSource | null = null;
    let srcW = 0;
    let srcH = 0;
    if (enh && enh.width > 0 && enh.height > 0) {
      src = enh;
      srcW = enh.width;
      srcH = enh.height;
    } else if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
      src = vid;
      srcW = vid.videoWidth;
      srcH = vid.videoHeight;
    }
    if (!src || srcW === 0 || srcH === 0) return Promise.resolve(null);

    try {
      if (!snapshotCanvasRef.current) {
        snapshotCanvasRef.current = document.createElement('canvas');
      }
      const off = snapshotCanvasRef.current;
      off.width = 320;
      off.height = Math.max(1, Math.round((320 * srcH) / srcW));
      const ctx = off.getContext('2d');
      if (!ctx) return Promise.resolve(null);
      ctx.drawImage(src, 0, 0, off.width, off.height);

      // Encode JPEG asynchronously off the main thread to avoid INP blocking
      return new Promise((resolve) => {
        off.toBlob(
          (blob) => {
            if (!blob) {
              resolve(null);
              return;
            }
            const reader = new FileReader();
            reader.onloadend = () =>
              resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          },
          'image/jpeg',
          0.66
        );
      });
    } catch {
      return Promise.resolve(null);
    }
  }, []);

  const triggerEmergencyCall = useCallback(
    (reason: string, autoTriggered = false) => {
      const th = thresholdsRef.current;
      const kin = kinematicLatestRef.current;
      const dial = formatDialNumber(th.emergencyPhone || '7389416622');

      // 1. Commit lightweight UI state immediately (<4ms INP) so button click paints on next frame
      setEmergencyCall({
        active: true,
        phoneRaw: th.emergencyPhone || '7389416622',
        phoneDial: dial.display,
        reason,
        startedAtMs: Date.now(),
        autoTriggered,
        lat: kin.lat,
        lon: kin.lon,
        speedKmh: kin.speedKmh,
        pstnStatus: 'DIALING',
        pstnMessage: `Contacting PSTN voice gateway & paired /sensor nodes for ${dial.display}…`,
      });

      // On mobile browsers (with a SIM dialer), invoke tel: URI on Auto-SOS too
      const isMobile =
        typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (autoTriggered && isMobile && typeof document !== 'undefined') {
        try {
          const a = document.createElement('a');
          a.href = dial.telHref;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch {}
      }

      // 2. Defer audio synthesis, off-thread JPEG encoding, Realtime broadcast & PSTN fetch past next paint
      window.setTimeout(async () => {
        interventionEngineRef.current.announceEmergencyCall(
          th.emergencyPhone || '7389416622',
          th.audioArmed,
          th.voiceArmed
        );

        broadcastEmergencySos({
          dialNumber: dial.display,
          reason,
          speedKmh: kin.speedKmh,
          lat: kin.lat,
          lon: kin.lon,
        });

        let twilioLocal = { sid: '', token: '', from: '' };
        try {
          const rawTw = localStorage.getItem('vigil_pstn_twilio');
          if (rawTw) {
            const parsed = JSON.parse(rawTw);
            twilioLocal = {
              sid: String(parsed.sid || ''),
              token: String(parsed.token || ''),
              from: String(parsed.from || ''),
            };
          }
        } catch {}

        const snap = await captureOpticalEvidenceAsync();
        let addedCloudIncident = false;
        logSafetyIncident({
          sessionId: activeSessionRef.current?.id ?? null,
          category: 'EMERGENCY_SOS',
          severity: 'CRITICAL',
          stage: 3,
          summary: `Emergency SOS call initiated to ${dial.display} (${reason})`,
          interventionAction: 'EMERGENCY_VOICE_CALL + GPS_SOS_DISPATCH + HAZARD_BEACONS',
          metrics: {
            dialNumber: dial.display,
            reason,
            autoTriggered,
            speedKmh: kin.speedKmh,
            lat: kin.lat,
            lon: kin.lon,
            earMean: ocularLatestRef.current.earMean,
            perclos60: ocularLatestRef.current.perclos60,
            nightVisionActive: ocularLatestRef.current.nightVisionActive,
          },
          frameEvidence: snap,
          webhookUrl: th.webhookUrl,
        }).then((saved) => {
          if (saved) {
            addedCloudIncident = true;
            setIncidents((prev) => (prev.some((x) => x.id === saved.id) ? prev : [saved, ...prev]));
          }
        });

        fetch('/api/emergency-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: activeSessionRef.current?.id ?? null,
            phone: dial.display,
            reason,
            autoTriggered,
            speedKmh: kin.speedKmh,
            lat: kin.lat,
            lon: kin.lon,
            frameEvidence: snap,
            twilioSid: twilioLocal.sid,
            twilioToken: twilioLocal.token,
            twilioFrom: twilioLocal.from,
          }),
        })
          .then((r) => r.json().catch(() => null))
          .then((data) => {
            if (data) {
              setEmergencyCall((prev) =>
                prev
                  ? {
                      ...prev,
                      pstnStatus: data.status || (data.pstnDispatched ? 'RINGING' : 'NO_GATEWAY'),
                      pstnMessage: data.message,
                      callSid: data.callSid,
                    }
                  : prev
              );
              if (data.incident && !addedCloudIncident) {
                setIncidents((prev) =>
                  prev.some((x) => x.id === data.incident.id) ? prev : [data.incident, ...prev]
                );
              }
            }
          })
          .catch(() => {
            setEmergencyCall((prev) =>
              prev
                ? {
                    ...prev,
                    pstnStatus: 'NO_GATEWAY',
                    pstnMessage:
                      'PSTN gateway unreachable — use OS Dialer, WhatsApp SOS, or paired /sensor phone.',
                  }
                : prev
            );
          });
      }, 0);
    },
    [captureOpticalEvidenceAsync]
  );

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

    const isLocalHost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(window.location.hostname);

    if (isLocalHost) {
      fetch('/api/system/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (mounted && data?.network?.sensorHttpsUrl) {
            setLanSensorUrl(data.network.sensorHttpsUrl);
          }
        })
        .catch(() => {});
    }

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
    if (isLocalHost) {
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

      if (evalOut.triggerAutoEmergencyCall) {
        triggerEmergencyCall('Auto-SOS: Unresponsive Stage-3 microsleep', true);
      }

      if (evalOut.emittedIncidents.length > 0) {
        for (const ev of evalOut.emittedIncidents) {
          void (async () => {
            const snap = ev.captureOpticalSnapshot ? await captureOpticalEvidenceAsync() : null;
            const saved = await logSafetyIncident({
              sessionId: activeSessionRef.current?.id ?? null,
              category: ev.category,
              severity: ev.severity,
              stage: ev.stage,
              summary: ev.summary,
              interventionAction: ev.interventionAction,
              metrics: ev.metrics,
              frameEvidence: snap,
              webhookUrl: th.webhookUrl,
            });
            if (saved) {
              setIncidents((prev) => (prev.some((x) => x.id === saved.id) ? prev : [saved, ...prev]));
            }
          })();
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
  }, [captureOpticalEvidenceAsync, triggerEmergencyCall]);

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

  const handleUpdateThresholds = async (partial: Partial<ThresholdsConfig>): Promise<void> => {
    interventionEngineRef.current.unlockAudio();
    setThresholds((prev) => {
      const next = { ...prev, ...partial };
      thresholdsRef.current = next;
      return next;
    });
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      void persistThresholdsConfig(thresholdsRef.current);
    }, 320);
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
              getEnhancedCanvas={() => ocularEngineRef.current.getEnhancedCanvas()}
              metrics={ocularMetrics}
              overlayRef={overlayRef}
              thresholds={thresholds}
              cameraError={cameraError}
              modelLoading={modelLoading}
              onStartWebcam={handleStartWebcam}
              onStopOptical={stopOpticalFeed}
              onUploadVideoFile={handleUploadDriverVideo}
              onCalibrateNeutral={() => ocularEngineRef.current.startNeutralCalibration()}
              onChangeNightVisionMode={(mode) => handleUpdateThresholds({ nightVisionMode: mode })}
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
              emergencyCall={emergencyCall}
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
              onTriggerEmergencyCall={(reason) => triggerEmergencyCall(reason, false)}
              onCancelAutoSos={() => interventionEngineRef.current.cancelAutoSosCountdown()}
              onDismissEmergencyCall={() => setEmergencyCall(null)}
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
