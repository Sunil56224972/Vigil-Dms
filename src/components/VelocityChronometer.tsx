import React, { useEffect, useRef, useState } from 'react';
import anime from 'animejs';

interface VelocityChronometerProps {
  speedKmh: number;
  speedLimitKmh: number;
  governorEngaged: boolean;
  governorCapKmh: number;
  rpm: number | null;
}

const MAX_DIAL_KMH = 140;
const START_DEG = -210; // 7 o'clock
const END_DEG = 30; // 5 o'clock (240° sweep)
const SWEEP_DEG = END_DEG - START_DEG;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export const VelocityChronometer: React.FC<VelocityChronometerProps> = ({
  speedKmh,
  speedLimitKmh,
  governorEngaged,
  governorCapKmh,
  rpm,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [needleKmh, setNeedleKmh] = useState(0);
  const [limitBugKmh, setLimitBugKmh] = useState(speedLimitKmh);
  const bootSweepActiveRef = useRef(true);
  const needleAnimObj = useRef({ val: 0 });
  const limitAnimObj = useRef({ val: speedLimitKmh });

  // Ignition self-test gauge needle sweep + staggered dial tick reveal
  useEffect(() => {
    if (svgRef.current) {
      anime({
        targets: svgRef.current.querySelectorAll('.chrono-tick'),
        opacity: [0, 1],
        duration: 280,
        delay: anime.stagger(10),
        easing: 'easeOutQuad',
      });
    }

    const obj = needleAnimObj.current;
    const tl = anime.timeline({
      update: () => setNeedleKmh(obj.val),
      complete: () => {
        bootSweepActiveRef.current = false;
      },
    });

    tl.add({
      targets: obj,
      val: [0, 128],
      duration: 520,
      easing: 'cubicBezier(0.22, 1, 0.36, 1)',
    }).add({
      targets: obj,
      val: 0,
      duration: 620,
      easing: 'spring(1, 82, 13, 0)',
    });

    return () => {
      anime.remove(obj);
    };
  }, []);

  // Smooth spring follow on live velocity after ignition sweep finishes
  useEffect(() => {
    if (bootSweepActiveRef.current) return;
    anime.remove(needleAnimObj.current);
    anime({
      targets: needleAnimObj.current,
      val: Math.max(0, Math.min(MAX_DIAL_KMH, speedKmh)),
      duration: 180,
      easing: 'easeOutCubic',
      update: () => setNeedleKmh(needleAnimObj.current.val),
    });
  }, [speedKmh]);

  // Spring-physics glide when zone speed limit changes
  useEffect(() => {
    anime.remove(limitAnimObj.current);
    anime({
      targets: limitAnimObj.current,
      val: Math.max(15, Math.min(MAX_DIAL_KMH, speedLimitKmh)),
      easing: 'spring(1, 90, 13, 0)',
      update: () => setLimitBugKmh(limitAnimObj.current.val),
    });
  }, [speedLimitKmh]);

  const cx = 74;
  const cy = 84;
  const r = 58;

  const speedAngle = START_DEG + (Math.min(MAX_DIAL_KMH, needleKmh) / MAX_DIAL_KMH) * SWEEP_DEG;
  const limitAngle = START_DEG + (Math.min(MAX_DIAL_KMH, limitBugKmh) / MAX_DIAL_KMH) * SWEEP_DEG;
  const govAngle = START_DEG + (Math.min(MAX_DIAL_KMH, governorCapKmh) / MAX_DIAL_KMH) * SWEEP_DEG;

  const needleTip = polarToCartesian(cx, cy, r - 8, speedAngle);
  const needleTail = polarToCartesian(cx, cy, -10, speedAngle);
  const limitOuter = polarToCartesian(cx, cy, r + 6, limitAngle);
  const limitInner = polarToCartesian(cx, cy, r - 3, limitAngle);

  const isOverspeed = speedKmh > speedLimitKmh + 2;
  const ticks = Array.from({ length: 29 }, (_, i) => i * 5); // 0..140 step 5

  return (
    <div className="scope-well" style={{ height: 164, display: 'grid', placeItems: 'center' }}>
      <svg ref={svgRef} viewBox="0 0 148 164" width="148" height="164">
        {/* Background Track Arc */}
        <path
          d={describeArc(cx, cy, r, START_DEG, END_DEG)}
          fill="none"
          stroke="var(--trace-grid)"
          strokeWidth="4"
          strokeLinecap="round"
        />

        {/* Governor Cap Restricted Arc when Stage-3 Governor Engages */}
        {governorEngaged && (
          <path
            d={describeArc(cx, cy, r, govAngle, END_DEG)}
            fill="none"
            stroke="var(--status-danger)"
            strokeWidth="4"
            strokeDasharray="3 3"
          />
        )}

        {/* Active Velocity Sweep Arc */}
        {needleKmh > 0.4 && (
          <path
            d={describeArc(cx, cy, r, START_DEG, speedAngle)}
            fill="none"
            stroke={isOverspeed ? 'var(--status-danger)' : 'var(--trace-primary)'}
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        )}

        {/* Precision Engraved Vernier Ticks */}
        {ticks.map((kmh) => {
          const ang = START_DEG + (kmh / MAX_DIAL_KMH) * SWEEP_DEG;
          const isMajor = kmh % 20 === 0;
          const p1 = polarToCartesian(cx, cy, r - (isMajor ? 8 : 4), ang);
          const p2 = polarToCartesian(cx, cy, r, ang);
          return (
            <line
              key={kmh}
              className="chrono-tick"
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={kmh > speedLimitKmh ? 'var(--trace-limit)' : 'var(--trace-secondary)'}
              strokeWidth={isMajor ? 1.3 : 0.8}
            />
          );
        })}

        {/* Spring-Loaded Speed Limit Rim Detent Marker */}
        <line
          x1={limitInner.x}
          y1={limitInner.y}
          x2={limitOuter.x}
          y2={limitOuter.y}
          stroke="var(--trace-limit)"
          strokeWidth="2.2"
          strokeLinecap="round"
        />

        {/* Tapered Instrument Needle */}
        <line
          x1={needleTail.x}
          y1={needleTail.y}
          x2={needleTip.x}
          y2={needleTip.y}
          stroke={isOverspeed ? 'var(--status-danger)' : 'var(--trace-primary)'}
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r="4.5" fill="var(--bg-surface)" stroke="var(--trace-primary)" strokeWidth="1.6" />

        {/* Digital Center & Sub-Readout */}
        <text
          x={cx}
          y={cy + 34}
          textAnchor="middle"
          fill="var(--ink-primary)"
          fontFamily="var(--font-mono)"
          fontSize="16"
          fontWeight="600"
        >
          {speedKmh.toFixed(0)}
        </text>
        <text
          x={cx}
          y={cy + 47}
          textAnchor="middle"
          fill="var(--ink-muted)"
          fontFamily="var(--font-mono)"
          fontSize="9"
        >
          km/h {rpm != null ? `· ${rpm} rpm` : `· lim ${speedLimitKmh}`}
        </text>
      </svg>
    </div>
  );
};
