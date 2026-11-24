import React, { useEffect, useRef } from 'react';
import anime from 'animejs';
import type { AlertStage } from '../types/telemetry';

interface SignalSchematicBusProps {
  opticalActive: boolean;
  kinematicActive: boolean;
  alertStage: AlertStage;
  supabaseConnected: boolean;
  incidentCount: number;
  fps: number;
  kinematicSource: string;
}

const SOURCE_LABELS: Record<string, string> = {
  DISCONNECTED: 'Idle',
  LOCAL_DEVICE_IMU: 'Device IMU/GPS',
  REMOTE_MOBILE_SENSOR: 'Paired Phone IMU',
  FILE_REPLAY: 'Log Replay',
  EXTERNAL_BUS: 'HTTP Bus',
  MANUAL_DYNAMICS_RIG: 'Dynamics Rig',
};

export const SignalSchematicBus: React.FC<SignalSchematicBusProps> = ({
  opticalActive,
  kinematicActive,
  alertStage,
  supabaseConnected,
  incidentCount,
  fps,
  kinematicSource,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const scanLineRef = useRef<SVGLineElement | null>(null);
  const relayArmRef = useRef<SVGLineElement | null>(null);
  const junctionRingRef = useRef<SVGCircleElement | null>(null);
  const ledgerPulseRef = useRef<SVGCircleElement | null>(null);

  // Cold-boot architectural drafting trace reveal + continuous vernier processor scan
  useEffect(() => {
    if (!svgRef.current) return;
    const paths = svgRef.current.querySelectorAll('.bus-wire');
    paths.forEach((p) => {
      const svgPath = p as SVGPathElement;
      const len = svgPath.getTotalLength ? svgPath.getTotalLength() : 240;
      svgPath.style.strokeDasharray = `${len}`;
      svgPath.style.strokeDashoffset = `${len}`;
    });

    anime
      .timeline({ easing: 'cubicBezier(0.16, 1, 0.3, 1)' })
      .add({
        targets: svgRef.current.querySelectorAll('.bus-wire'),
        strokeDashoffset: [anime.setDashoffset, 0],
        duration: 920,
        delay: anime.stagger(90),
      })
      .add(
        {
          targets: svgRef.current.querySelectorAll('.bus-node'),
          opacity: [0, 1],
          duration: 460,
          delay: anime.stagger(65),
        },
        '-=680'
      );

    if (scanLineRef.current) {
      anime({
        targets: scanLineRef.current,
        translateX: [0, 214],
        direction: 'alternate',
        easing: 'easeInOutSine',
        duration: 2600,
        loop: true,
      });
    }

    const scanEl = scanLineRef.current;
    return () => {
      if (scanEl) anime.remove(scanEl);
    };
  }, []);

  // Multi-packet harmonic wave train on Optical cubic-Bezier conduit
  useEffect(() => {
    if (!svgRef.current) return;
    const dots = svgRef.current.querySelectorAll('.opt-wave-dot');
    anime.remove(dots);
    if (!opticalActive) {
      dots.forEach((d) => ((d as SVGElement).style.opacity = '0'));
      return;
    }
    const path = anime.path(svgRef.current.querySelector('#wire-opt') as SVGPathElement);
    anime({
      targets: dots,
      translateX: path('x'),
      translateY: path('y'),
      opacity: [
        { value: 0.95, duration: 140 },
        { value: 0.95, duration: 860 },
        { value: 0, duration: 180 },
      ],
      easing: 'linear',
      duration: 1180,
      delay: anime.stagger(180),
      loop: true,
    });
  }, [opticalActive]);

  // Multi-packet harmonic wave train on Kinematic cubic-Bezier conduit + junction ripple
  useEffect(() => {
    if (!svgRef.current) return;
    const dots = svgRef.current.querySelectorAll('.kin-wave-dot');
    anime.remove(dots);
    if (junctionRingRef.current) anime.remove(junctionRingRef.current);

    if (!kinematicActive && !opticalActive) {
      dots.forEach((d) => ((d as SVGElement).style.opacity = '0'));
      if (junctionRingRef.current) junctionRingRef.current.style.opacity = '0';
      return;
    }

    if (kinematicActive) {
      const path = anime.path(svgRef.current.querySelector('#wire-kin') as SVGPathElement);
      anime({
        targets: dots,
        translateX: path('x'),
        translateY: path('y'),
        opacity: [
          { value: 0.95, duration: 130 },
          { value: 0.95, duration: 790 },
          { value: 0, duration: 160 },
        ],
        easing: 'linear',
        duration: 1080,
        delay: anime.stagger(160),
        loop: true,
      });
    } else {
      dots.forEach((d) => ((d as SVGElement).style.opacity = '0'));
    }

    if (junctionRingRef.current) {
      anime({
        targets: junctionRingRef.current,
        r: [2.5, 9],
        opacity: [0.55, 0],
        easing: 'easeOutCubic',
        duration: 1100,
        loop: true,
      });
    }
  }, [kinematicActive, opticalActive]);

  // Mechanical Relay Contact Arm Throw + Cryptographic Seal Pulse into Supabase Vault
  useEffect(() => {
    if (relayArmRef.current) {
      anime.remove(relayArmRef.current);
      // Open circuit (-24 deg) when Stage 0; snaps shut (0 deg) onto terminal when Stage >= 1
      const targetAngle = alertStage > 0 ? 0 : -24;
      const pivotX = 918;
      const pivotY = 25;
      anime({
        targets: relayArmRef.current,
        rotate: `${targetAngle}deg`,
        easing: 'spring(1, 110, 11, 0)',
        update: (anim) => {
          const cur = Number(anim.animations[0]?.currentValue?.toString().replace('deg', '') || targetAngle);
          relayArmRef.current?.setAttribute('transform', `rotate(${cur} ${pivotX} ${pivotY})`);
        },
      });
    }

    if (alertStage > 0 && svgRef.current && ledgerPulseRef.current) {
      const path = anime.path(svgRef.current.querySelector('#wire-ledger') as SVGPathElement);
      ledgerPulseRef.current.style.opacity = '1';
      anime({
        targets: ledgerPulseRef.current,
        translateX: path('x'),
        translateY: path('y'),
        r: [4.5, 2],
        opacity: [1, 0],
        easing: 'easeOutQuart',
        duration: 680,
      });
    }
  }, [alertStage, incidentCount]);

  const activeAlertStroke =
    alertStage >= 3
      ? 'var(--status-danger)'
      : alertStage >= 1
      ? 'var(--status-warn)'
      : 'var(--border-strong)';

  return (
    <div className="schematic-bus-wrap" aria-label="Telemetry Signal Pipeline">
      <svg
        ref={svgRef}
        viewBox="0 0 1200 46"
        width="100%"
        height="42"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Smooth Cubic-Bezier Signal Conduits */}
        <path
          id="wire-opt"
          className="bus-wire"
          d="M 218 12 C 300 12, 330 23, 418 23"
          fill="none"
          stroke={opticalActive ? 'var(--ink-secondary)' : 'var(--border-default)'}
          strokeWidth="1.2"
        />
        <path
          id="wire-kin"
          className="bus-wire"
          d="M 218 34 C 300 34, 330 23, 418 23"
          fill="none"
          stroke={kinematicActive ? 'var(--ink-secondary)' : 'var(--border-default)'}
          strokeWidth="1.2"
        />
        <path
          id="wire-act"
          className="bus-wire"
          d="M 656 23 L 732 23"
          fill="none"
          stroke={alertStage > 0 ? activeAlertStroke : 'var(--border-default)'}
          strokeWidth="1.2"
        />
        <path
          id="wire-ledger"
          className="bus-wire"
          d="M 960 23 L 1018 23"
          fill="none"
          stroke="var(--border-default)"
          strokeWidth="1.2"
        />

        {/* Junction Arrival Ripple */}
        <circle
          ref={junctionRingRef}
          cx="418"
          cy="23"
          r="3"
          fill="none"
          stroke="var(--ink-primary)"
          strokeWidth="1"
          style={{ opacity: 0 }}
        />

        {/* 3-Pulse Harmonic Wave Trains */}
        <circle className="opt-wave-dot" r="2.6" fill="var(--ink-primary)" style={{ opacity: 0 }} />
        <circle className="opt-wave-dot" r="2.0" fill="var(--ink-secondary)" style={{ opacity: 0 }} />
        <circle className="opt-wave-dot" r="1.4" fill="var(--ink-muted)" style={{ opacity: 0 }} />

        <circle className="kin-wave-dot" r="2.6" fill="var(--ink-primary)" style={{ opacity: 0 }} />
        <circle className="kin-wave-dot" r="2.0" fill="var(--ink-secondary)" style={{ opacity: 0 }} />
        <circle className="kin-wave-dot" r="1.4" fill="var(--ink-muted)" style={{ opacity: 0 }} />

        <circle ref={ledgerPulseRef} r="3.8" fill="var(--status-danger)" style={{ opacity: 0 }} />

        {/* Node 1A: Camera */}
        <g className="bus-node">
          <rect
            x="2"
            y="2"
            width="216"
            height="19"
            rx="3"
            fill="var(--bg-surface)"
            stroke="var(--border-default)"
            strokeWidth="1"
          />
          <circle
            cx="13"
            cy="11.5"
            r="2.8"
            fill={opticalActive ? 'var(--status-ok-dot)' : 'var(--ink-muted)'}
          />
          <text x="22" y="15" fill="var(--ink-primary)" fontFamily="var(--font-sans)" fontSize="10.5" fontWeight="500">
            Cabin Vision {opticalActive ? `· ${fps} fps` : '· Idle'}
          </text>
        </g>

        {/* Node 1B: Kinematics */}
        <g className="bus-node">
          <rect
            x="2"
            y="25"
            width="216"
            height="19"
            rx="3"
            fill="var(--bg-surface)"
            stroke="var(--border-default)"
            strokeWidth="1"
          />
          <circle
            cx="13"
            cy="34.5"
            r="2.8"
            fill={kinematicActive ? 'var(--status-ok-dot)' : 'var(--ink-muted)'}
          />
          <text x="22" y="38" fill="var(--ink-primary)" fontFamily="var(--font-sans)" fontSize="10.5" fontWeight="500">
            Kinematics · {SOURCE_LABELS[kinematicSource] || kinematicSource}
          </text>
        </g>

        {/* Node 2: Signal Fusion with Continuous Vernier Scan Hairline */}
        <g className="bus-node">
          <rect
            x="418"
            y="6"
            width="238"
            height="34"
            rx="4"
            fill="var(--bg-surface)"
            stroke="var(--border-default)"
            strokeWidth="1"
          />
          <line
            ref={scanLineRef}
            x1="430"
            y1="8"
            x2="430"
            y2="38"
            stroke="var(--trace-grid)"
            strokeWidth="1.5"
          />
          <text x="430" y="19" fill="var(--ink-muted)" fontFamily="var(--font-sans)" fontSize="10">
            Biometric &amp; Kinematic Evaluation
          </text>
          <text x="430" y="32" fill="var(--ink-primary)" fontFamily="var(--font-sans)" fontSize="11.5" fontWeight="600">
            EAR · PERCLOS · G-Envelope · Jerk
          </text>
        </g>

        {/* Node 3: Intervention State with Physical Animated Electrical Relay Contact */}
        <g className="bus-node">
          <rect
            x="732"
            y="6"
            width="228"
            height="34"
            rx="4"
            fill="var(--bg-surface)"
            stroke={alertStage > 0 ? activeAlertStroke : 'var(--border-default)'}
            strokeWidth="1"
          />
          <text x="744" y="19" fill="var(--ink-muted)" fontFamily="var(--font-sans)" fontSize="10">
            Safety Intervention Relay
          </text>
          <text
            x="744"
            y="32"
            fill={alertStage >= 3 ? 'var(--status-danger)' : alertStage >= 1 ? 'var(--status-warn)' : 'var(--ink-primary)'}
            fontFamily="var(--font-sans)"
            fontSize="11.5"
            fontWeight="600"
          >
            {alertStage === 0
              ? 'Stage 0 · Armed'
              : alertStage === 1
              ? 'Stage 1 · Chime'
              : alertStage === 2
              ? 'Stage 2 · Voice Alert'
              : 'Stage 3 · Governor'}
          </text>

          {/* Bespoke Mechanical Relay Switch Symbol */}
          <line x1="908" y1="25" x2="918" y2="25" stroke="var(--ink-secondary)" strokeWidth="1.3" />
          <circle cx="918" cy="25" r="2" fill="var(--ink-primary)" />
          <line
            ref={relayArmRef}
            x1="918"
            y1="25"
            x2="938"
            y2="25"
            stroke={alertStage > 0 ? activeAlertStroke : 'var(--ink-primary)'}
            strokeWidth="1.6"
            strokeLinecap="round"
            transform="rotate(-24 918 25)"
          />
          <circle
            cx="939"
            cy="25"
            r="2"
            fill={alertStage > 0 ? activeAlertStroke : 'none'}
            stroke="var(--ink-secondary)"
            strokeWidth="1.2"
          />
          <line x1="941" y1="25" x2="950" y2="25" stroke="var(--ink-secondary)" strokeWidth="1.3" />
        </g>

        {/* Node 4: Supabase Ledger */}
        <g className="bus-node">
          <rect
            x="1018"
            y="6"
            width="180"
            height="34"
            rx="4"
            fill="var(--bg-surface)"
            stroke="var(--border-default)"
            strokeWidth="1"
          />
          <circle
            cx="1030"
            cy="15.5"
            r="2.8"
            fill={supabaseConnected ? 'var(--status-ok-dot)' : 'var(--ink-muted)'}
          />
          <text x="1038" y="19" fill="var(--ink-muted)" fontFamily="var(--font-sans)" fontSize="10">
            Supabase PostgreSQL 17
          </text>
          <text x="1030" y="32" fill="var(--ink-primary)" fontFamily="var(--font-mono)" fontSize="10.5">
            {supabaseConnected ? `SHA-256 · ${incidentCount} records` : 'Offline'}
          </text>
        </g>
      </svg>
    </div>
  );
};
