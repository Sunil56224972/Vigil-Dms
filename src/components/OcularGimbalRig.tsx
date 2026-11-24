import React, { useEffect, useRef, useState } from 'react';
import anime from 'animejs';
import type { OcularMetrics, ThresholdsConfig } from '../types/telemetry';

interface OcularGimbalRigProps {
  metrics: OcularMetrics;
  thresholds: ThresholdsConfig;
}

export const OcularGimbalRig: React.FC<OcularGimbalRigProps> = ({ metrics, thresholds }) => {
  const [bootState, setBootState] = useState({
    aperture: 1,
    gazeX: 0,
    gazeY: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    active: true,
  });
  const bootObjRef = useRef({
    aperture: 0.05,
    gazeX: 0,
    gazeY: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
  });

  // Handcrafted startup mechanical self-calibration sweep (Eye blink + Gimbal check)
  useEffect(() => {
    const obj = bootObjRef.current;
    const tl = anime.timeline({
      update: () => {
        setBootState({
          aperture: obj.aperture,
          gazeX: obj.gazeX,
          gazeY: obj.gazeY,
          yaw: obj.yaw,
          pitch: obj.pitch,
          roll: obj.roll,
          active: true,
        });
      },
      complete: () => {
        setBootState((prev) => ({ ...prev, active: false }));
      },
    });

    tl.add({
      targets: obj,
      aperture: [0.05, 1],
      duration: 420,
      easing: 'easeOutQuart',
    })
      .add({
        targets: obj,
        gazeX: [0, -0.55, 0.55, 0],
        yaw: [0, -18, 18, 0],
        pitch: [0, 10, -10, 0],
        roll: [0, -8, 8, 0],
        duration: 760,
        easing: 'easeInOutCubic',
      })
      .add(
        {
          targets: obj,
          aperture: [1, 0.08, 1],
          duration: 240,
          easing: 'easeInOutQuad',
        },
        '-=260'
      );

    return () => {
      anime.remove(obj);
    };
  }, []);

  // Compute live normalized eyelid openness (0 = shut, 1 = wide open)
  const liveOpenness =
    metrics.active && metrics.faceDetected
      ? Math.max(0.04, Math.min(1.15, (metrics.earMean - 0.08) / Math.max(0.12, metrics.earBaseline - 0.08)))
      : bootState.active
      ? bootState.aperture
      : 0.78;

  const gx = metrics.active && metrics.faceDetected ? metrics.gazeHorizontal : bootState.active ? bootState.gazeX : 0;
  const gy = metrics.active && metrics.faceDetected ? metrics.gazeVertical : bootState.active ? bootState.gazeY : 0;

  const pitch = metrics.active && metrics.faceDetected ? metrics.pitchDeg : bootState.active ? bootState.pitch : 0;
  const yaw = metrics.active && metrics.faceDetected ? metrics.yawDeg : bootState.active ? bootState.yaw : 0;
  const roll = metrics.active && metrics.faceDetected ? metrics.rollDeg : bootState.active ? bootState.roll : 0;

  const isClosedWarn =
    metrics.active && metrics.faceDetected && metrics.earMean < metrics.earThreshold;
  const isCritical = metrics.eyeClosedMs >= thresholds.microsleepHoldMs;

  const strokeColor = isCritical
    ? 'var(--status-danger)'
    : isClosedWarn || metrics.distractionHoldMs >= thresholds.distractionHoldMs
    ? 'var(--status-warn)'
    : 'var(--ink-primary)';

  // Eyelid Bezier control Y coordinates (center Y = 34)
  const lidSpan = 21 * liveOpenness;
  const upperCtrlY = 34 - lidSpan;
  const lowerCtrlY = 34 + lidSpan;
  const irisX = 56 + gx * 13;
  const irisY = 34 + gy * 7;

  // Head Gimbal 3D projected offsets (center = 166, 34)
  const gimCx = 166;
  const gimCy = 34;
  const noseX = gimCx + Math.max(-18, Math.min(18, (yaw / 40) * 18));
  const noseY = gimCy - Math.max(-15, Math.min(15, (pitch / 35) * 15));

  return (
    <div
      className="scope-well"
      style={{
        height: 68,
        marginBottom: 8,
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
      }}
    >
      <svg viewBox="0 0 220 68" width="212" height="66" style={{ flexShrink: 0, overflow: 'visible' }}>
        <defs>
          <clipPath id="ocular-lid-clip">
            <path
              d={`M 18 34 Q 56 ${upperCtrlY.toFixed(1)} 94 34 Q 56 ${lowerCtrlY.toFixed(1)} 18 34 Z`}
            />
          </clipPath>
        </defs>

        {/* --- LEFT INSTRUMENT: ANATOMICAL EYE APERTURE SHUTTER --- */}
        <line x1="10" y1="34" x2="102" y2="34" stroke="var(--trace-grid)" strokeWidth="1" />
        <line x1="56" y1="8" x2="56" y2="60" stroke="var(--trace-grid)" strokeWidth="1" />

        {/* Clipped Iris & Pupil Assembly */}
        <g clipPath="url(#ocular-lid-clip)">
          <circle
            cx={irisX}
            cy={irisY}
            r="11.5"
            fill="none"
            stroke={strokeColor}
            strokeWidth="1.25"
            style={{ transition: 'cx 0.07s linear, cy 0.07s linear' }}
          />
          <circle
            cx={irisX}
            cy={irisY}
            r="4.2"
            fill={strokeColor}
            style={{ transition: 'cx 0.07s linear, cy 0.07s linear' }}
          />
          {/* Specular catchlight */}
          <circle cx={irisX - 3} cy={irisY - 3} r="1.3" fill="var(--bg-well)" />
        </g>

        {/* Upper & Lower Mechanical Eyelid Curves */}
        <path
          d={`M 18 34 Q 56 ${upperCtrlY.toFixed(1)} 94 34`}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.6"
        />
        <path
          d={`M 18 34 Q 56 ${lowerCtrlY.toFixed(1)} 94 34`}
          fill="none"
          stroke="var(--ink-secondary)"
          strokeWidth="1.2"
        />

        {/* Divider */}
        <line x1="115" y1="10" x2="115" y2="58" stroke="var(--border-subtle)" strokeWidth="1" />

        {/* --- RIGHT INSTRUMENT: 3-AXIS GYROSCOPIC HEAD POSE GIMBAL --- */}
        <circle cx={gimCx} cy={gimCy} r="23" fill="none" stroke="var(--border-default)" strokeWidth="1" />
        {/* Safe Attention Cone Ring */}
        <circle
          cx={gimCx}
          cy={gimCy}
          r="12"
          fill="none"
          stroke="var(--trace-secondary)"
          strokeWidth="0.9"
          strokeDasharray="2 2"
        />

        {/* Roll Horizon Ring */}
        <g transform={`rotate(${roll.toFixed(1)} ${gimCx} ${gimCy})`}>
          <line
            x1={gimCx - 25}
            y1={gimCy}
            x2={gimCx - 16}
            y2={gimCy}
            stroke="var(--ink-secondary)"
            strokeWidth="1.3"
          />
          <line
            x1={gimCx + 16}
            y1={gimCy}
            x2={gimCx + 25}
            y2={gimCy}
            stroke="var(--ink-secondary)"
            strokeWidth="1.3"
          />
          <ellipse
            cx={gimCx}
            cy={gimCy}
            rx={Math.max(3, 22 * Math.cos((yaw * Math.PI) / 180))}
            ry="22"
            fill="none"
            stroke="var(--trace-grid)"
            strokeWidth="1"
          />
        </g>

        {/* Head Vector Target */}
        <line x1={gimCx} y1={gimCy} x2={noseX} y2={noseY} stroke={strokeColor} strokeWidth="1.2" />
        <circle cx={noseX} cy={noseY} r="3.2" fill={strokeColor} />
      </svg>

      {/* Live Micro-Telemetry Legend */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: 'var(--ink-muted)' }}>Eyelid shutter</span>
          <span className="mono" style={{ color: 'var(--ink-primary)' }}>
            {metrics.active && metrics.faceDetected ? `${Math.round(liveOpenness * 100)}% open` : 'Calibrated'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: 'var(--ink-muted)' }}>Head gimbal</span>
          <span className="mono" style={{ color: 'var(--ink-secondary)', fontSize: 10.5 }}>
            P {pitch >= 0 ? '+' : ''}
            {pitch.toFixed(0)}° · Y {yaw >= 0 ? '+' : ''}
            {yaw.toFixed(0)}° · R {roll.toFixed(0)}°
          </span>
        </div>
      </div>
    </div>
  );
};
