import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export const MobileSensorNode: React.FC = () => {
  const [armed, setArmed] = useState(false);
  const [wsReady, setWsReady] = useState(false);
  const [imuDetected, setImuDetected] = useState<boolean | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packetsSent, setPacketsSent] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [accelLong, setAccelLong] = useState(0);
  const [accelLat, setAccelLat] = useState(0);
  const [yawRate, setYawRate] = useState(0);
  const [gpsLocked, setGpsLocked] = useState(false);

  const nodeIdRef = useRef(`IMU-${Math.random().toString(16).slice(2, 6).toUpperCase()}`);
  const tareRef = useRef({ x: 0, y: 0, z: 0, set: false });
  const rawGravityRef = useRef({ x: 0, y: 0, z: 0 });
  const latestSpeedRef = useRef<number | null>(null);
  const latestCoordsRef = useRef<{ lat: number | null; lon: number | null; acc: number | null }>({
    lat: null,
    lon: null,
    acc: null,
  });

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const wsReadyRef = useRef(false);
  const localWsRef = useRef<WebSocket | null>(null);
  const motionHandlerRef = useRef<((ev: DeviceMotionEvent) => void) | null>(null);
  const geoWatchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const imuTimerRef = useRef<number | null>(null);

  const acquireWakeLock = useCallback(async () => {
    try {
      const navAny = navigator as unknown as {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (navAny.wakeLock) {
        wakeLockRef.current = await navAny.wakeLock.request('screen');
        setWakeLockActive(true);
      }
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const stopHardwareTransmitter = useCallback(() => {
    if (motionHandlerRef.current) {
      window.removeEventListener('devicemotion', motionHandlerRef.current);
      motionHandlerRef.current = null;
    }
    if (geoWatchIdRef.current != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = null;
    }
    if (imuTimerRef.current != null) {
      clearTimeout(imuTimerRef.current);
      imuTimerRef.current = null;
    }
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setWakeLockActive(false);
    setArmed(false);
  }, []);

  useEffect(() => {
    const ch = supabase.channel('dms9-telemetry-bus');
    ch.subscribe((status) => {
      const ok = status === 'SUBSCRIBED';
      wsReadyRef.current = ok;
      setWsReady(ok);
    });
    channelRef.current = ch;

    const isLocalHost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(window.location.hostname);

    if (isLocalHost) {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${window.location.host}/ws?role=sensor&label=${nodeIdRef.current}`);
        localWsRef.current = ws;
      } catch {
        // Supabase Realtime WSS remains primary
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && motionHandlerRef.current) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopHardwareTransmitter();
      if (channelRef.current) supabase.removeChannel(channelRef.current);
      localWsRef.current?.close();
    };
  }, [acquireWakeLock, stopHardwareTransmitter]);

  const armHardwareTransmitter = async () => {
    stopHardwareTransmitter();
    setError(null);
    setImuDetected(null);

    try {
      const dmAny = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      };
      if (typeof dmAny?.requestPermission === 'function') {
        const res = await dmAny.requestPermission();
        if (res !== 'granted') {
          setError('Motion sensor permission denied. Allow motion access in browser settings.');
          return;
        }
      }

      await acquireWakeLock();

      if ('geolocation' in navigator) {
        geoWatchIdRef.current = navigator.geolocation.watchPosition(
          (pos) => {
            setGpsLocked(true);
            latestCoordsRef.current = {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              acc: pos.coords.accuracy,
            };
            if (pos.coords.speed != null && Number.isFinite(pos.coords.speed)) {
              const kmh = Math.max(0, pos.coords.speed * 3.6);
              latestSpeedRef.current = kmh;
              setSpeedKmh(kmh);
            }
          },
          () => {},
          { enableHighAccuracy: true, maximumAge: 400 }
        );
      }

      let gotAnyImu = false;
      imuTimerRef.current = window.setTimeout(() => {
        if (!gotAnyImu) {
          setImuDetected(false);
        }
      }, 2200);

      let lastSend = 0;
      const handler = (ev: DeviceMotionEvent) => {
        const hasAccel =
          ev.acceleration?.x != null || ev.accelerationIncludingGravity?.x != null;
        if (hasAccel && !gotAnyImu) {
          gotAnyImu = true;
          setImuDetected(true);
        }

        const now = performance.now();
        let ax = ev.acceleration?.x ?? null;
        let ay = ev.acceleration?.y ?? null;

        if (ev.accelerationIncludingGravity) {
          const gx = ev.accelerationIncludingGravity.x ?? 0;
          const gy = ev.accelerationIncludingGravity.y ?? 0;
          const gz = ev.accelerationIncludingGravity.z ?? 0;
          rawGravityRef.current = { x: gx, y: gy, z: gz };
          if (!tareRef.current.set) {
            tareRef.current = { x: gx, y: gy, z: gz, set: true };
          }
          if (ax == null || ay == null) {
            ax = gx - tareRef.current.x;
            ay = gy - tareRef.current.y;
          }
        }

        const latMs2 = Number((ax ?? 0).toFixed(3));
        const longMs2 = Number((ay ?? 0).toFixed(3));
        const wz = Number((ev.rotationRate?.alpha ?? ev.rotationRate?.gamma ?? 0).toFixed(2));

        setAccelLat(latMs2);
        setAccelLong(longMs2);
        setYawRate(wz);

        if (now - lastSend >= 50) {
          lastSend = now;
          const frame = {
            source: 'MOBILE_SENSOR_NODE',
            nodeId: nodeIdRef.current,
            timestampMs: Date.now(),
            speedKmh: latestSpeedRef.current,
            accelLongMs2: longMs2,
            accelLatMs2: latMs2,
            yawRateDegS: wz,
            gpsAccuracyM: latestCoordsRef.current.acc,
            lat: latestCoordsRef.current.lat,
            lon: latestCoordsRef.current.lon,
          };

          if (wsReadyRef.current) {
            channelRef.current?.send({
              type: 'broadcast',
              event: 'sensor_frame',
              payload: frame,
            });
          }

          if (localWsRef.current?.readyState === WebSocket.OPEN) {
            localWsRef.current.send(JSON.stringify({ type: 'SENSOR_FRAME', frame }));
          }

          setPacketsSent((c) => c + 1);
        }
      };

      motionHandlerRef.current = handler;
      window.addEventListener('devicemotion', handler);
      setArmed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to initialize hardware sensors.');
    }
  };

  return (
    <div className="dms-shell">
      <div className="sensor-handheld">
        <div className="inst-bay">
          <div className="inst-bay-header">
            <div>
              <div className="inst-bay-title">Vigil Field Sensor</div>
              <div className="inst-bay-subtitle">
                Unit {nodeIdRef.current} · {wsReady ? 'Realtime WSS connected' : 'Connecting…'}
              </div>
            </div>
            <span className={`hw-led ${armed && wsReady ? 'ok' : armed ? 'warn' : ''}`} />
          </div>

          <div className="inst-bay-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ color: 'var(--ink-secondary)', fontSize: 12 }}>
              Mount or hold this phone in the vehicle to stream real 3-axis linear acceleration, yaw rate, and GPS speed over Supabase Realtime.
            </div>

            {!armed ? (
              <button
                type="button"
                className="hw-btn primary"
                style={{ height: 40, fontSize: 13 }}
                onClick={armHardwareTransmitter}
              >
                Start IMU &amp; GPS stream
              </button>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                <button
                  type="button"
                  className="hw-btn primary"
                  style={{ height: 36 }}
                  onClick={() => {
                    tareRef.current = { ...rawGravityRef.current, set: true };
                  }}
                >
                  Zero current mount angle
                </button>
                <button
                  type="button"
                  className="hw-btn danger"
                  style={{ height: 36 }}
                  onClick={stopHardwareTransmitter}
                >
                  Stop
                </button>
              </div>
            )}

            {armed && wakeLockActive && (
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                Screen wake-lock active (display stays awake while streaming).
              </div>
            )}

            {armed && imuDetected === false && (
              <div
                style={{
                  padding: '7px 10px',
                  background: 'var(--status-warn-bg)',
                  border: '1px solid var(--status-warn)',
                  borderRadius: 4,
                  color: 'var(--status-warn)',
                  fontSize: 11.5,
                }}
              >
                No hardware accelerometer events detected on this device. Open this URL on a mobile phone over HTTPS to stream physical IMU data.
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--status-danger)', fontSize: 11.5 }}>
                {error}
              </div>
            )}

            <div className="readout-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div className="readout-cell">
                <div className="readout-label">
                  <span>GPS speed</span>
                  <span>{gpsLocked ? 'Locked' : 'Waiting'}</span>
                </div>
                <div className="readout-val">
                  {speedKmh.toFixed(1)}
                  <span className="readout-unit">km/h</span>
                </div>
              </div>

              <div className="readout-cell">
                <div className="readout-label">
                  <span>Frames sent</span>
                  <span>WSS</span>
                </div>
                <div className="readout-val">{packetsSent}</div>
              </div>

              <div className="readout-cell">
                <div className="readout-label">
                  <span>Longitudinal</span>
                </div>
                <div className="readout-val">
                  {accelLong >= 0 ? '+' : ''}
                  {accelLong.toFixed(2)}
                  <span className="readout-unit">m/s²</span>
                </div>
              </div>

              <div className="readout-cell">
                <div className="readout-label">
                  <span>Lateral / Yaw</span>
                </div>
                <div className="readout-val">
                  {accelLat >= 0 ? '+' : ''}
                  {accelLat.toFixed(2)}
                  <span className="readout-unit">m/s² · {yawRate.toFixed(0)}°/s</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
              <a
                href="tel:+917389416622"
                className="hw-btn danger"
                style={{ textDecoration: 'none', fontWeight: 600 }}
              >
                Emergency Call (7389416622)
              </a>
              <a href="/" className="hw-btn" style={{ textDecoration: 'none' }}>
                Back to main monitor
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
