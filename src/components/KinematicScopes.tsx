import React, { useEffect, useRef } from 'react';
import anime from 'animejs';
import { VelocityChronometer } from './VelocityChronometer';
import { OdometerValue } from './OdometerValue';
import type {
  IncidentRecord,
  KinematicMetrics,
  ThresholdsConfig,
} from '../types/telemetry';

interface KinematicScopesProps {
  metrics: KinematicMetrics;
  thresholds: ThresholdsConfig;
  incidents: IncidentRecord[];
}

interface KinSample {
  speedKmh: number;
  limitKmh: number;
  longG: number;
  latG: number;
  jerkMs3: number;
}

export const KinematicScopes: React.FC<KinematicScopesProps> = ({
  metrics,
  thresholds,
  incidents,
}) => {
  const ggCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stripCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<Array<{ latG: number; longG: number }>>([]);
  const stripRef = useRef<KinSample[]>([]);
  const peakHoldGRef = useRef<number>(0);
  const bootPendulumRef = useRef({ latG: 0, longG: 0, active: true });

  const cardBrakeRef = useRef<HTMLDivElement | null>(null);
  const cardAccelRef = useRef<HTMLDivElement | null>(null);
  const cardSpeedRef = useRef<HTMLDivElement | null>(null);
  const cardRashRef = useRef<HTMLDivElement | null>(null);

  const latestRef = useRef({ metrics, thresholds });
  latestRef.current = { metrics, thresholds };

  // G-G Friction Pendulum Ignition Self-Test Orbit
  useEffect(() => {
    const p = bootPendulumRef.current;
    const state = { angle: 0, radius: 0 };
    const tl = anime.timeline({
      complete: () => {
        p.active = false;
      },
    });
    tl.add({
      targets: state,
      radius: [0, 0.42],
      angle: [0, Math.PI * 2],
      duration: 780,
      easing: 'easeOutCubic',
      update: () => {
        p.latG = Math.cos(state.angle) * state.radius;
        p.longG = Math.sin(state.angle) * state.radius;
      },
    }).add({
      targets: p,
      latG: 0,
      longG: 0,
      duration: 420,
      easing: 'spring(1, 90, 12, 0)',
    });
    return () => {
      anime.remove(state);
      anime.remove(p);
    };
  }, []);

  // Tactile spring thump when any risky pattern card trips
  useEffect(() => {
    if (metrics.patternFlags.harshBraking && cardBrakeRef.current) {
      anime({ targets: cardBrakeRef.current, scale: [0.97, 1.02, 1], duration: 360, easing: 'easeOutElastic(1, .6)' });
    }
  }, [metrics.patternFlags.harshBraking]);

  useEffect(() => {
    if (metrics.patternFlags.rapidAccel && cardAccelRef.current) {
      anime({ targets: cardAccelRef.current, scale: [0.97, 1.02, 1], duration: 360, easing: 'easeOutElastic(1, .6)' });
    }
  }, [metrics.patternFlags.rapidAccel]);

  useEffect(() => {
    if (metrics.patternFlags.speeding && cardSpeedRef.current) {
      anime({ targets: cardSpeedRef.current, scale: [0.97, 1.02, 1], duration: 360, easing: 'easeOutElastic(1, .6)' });
    }
  }, [metrics.patternFlags.speeding]);

  useEffect(() => {
    if (metrics.patternFlags.rashDriving && cardRashRef.current) {
      anime({ targets: cardRashRef.current, scale: [0.97, 1.02, 1], duration: 360, easing: 'easeOutElastic(1, .6)' });
    }
  }, [metrics.patternFlags.rashDriving]);

  useEffect(() => {
    let rafId = 0;
    let lastPushMs = 0;

    const render = (now: number) => {
      const { metrics: m, thresholds: th } = latestRef.current;
      const boot = bootPendulumRef.current;

      const drawLatG = m.active ? m.latG : boot.active ? boot.latG : 0;
      const drawLongG = m.active ? m.longG : boot.active ? boot.longG : 0;

      if ((m.active || boot.active) && now - lastPushMs >= 40) {
        lastPushMs = now;
        if (m.active) {
          peakHoldGRef.current = Math.max(peakHoldGRef.current * 0.998, m.totalG);
          stripRef.current.push({
            speedKmh: m.speedKmh,
            limitKmh: th.speedLimitKmh,
            longG: m.longG,
            latG: m.latG,
            jerkMs3: m.jerkMs3,
          });
          if (stripRef.current.length > 200) stripRef.current.shift();
        }
        trailRef.current.push({ latG: drawLatG, longG: drawLongG });
        if (trailRef.current.length > 85) trailRef.current.shift();
      } else if (!m.active && !boot.active && trailRef.current.length > 0) {
        trailRef.current = [];
        stripRef.current = [];
        peakHoldGRef.current = 0;
      }

      const styles = getComputedStyle(document.documentElement);
      const primaryTrace = styles.getPropertyValue('--trace-primary').trim() || '#e8e6df';
      const secTrace = styles.getPropertyValue('--trace-secondary').trim() || '#7d7b74';
      const limitTrace = styles.getPropertyValue('--trace-limit').trim() || '#c85232';
      const gridColor = styles.getPropertyValue('--trace-grid').trim() || 'rgba(255,255,255,0.05)';
      const labelColor = styles.getPropertyValue('--trace-label').trim() || '#8a8880';

      // 1. Polar G-G Friction Circle
      const ggCanvas = ggCanvasRef.current;
      if (ggCanvas) {
        const rect = ggCanvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (ggCanvas.width !== w || ggCanvas.height !== h) {
          ggCanvas.width = w;
          ggCanvas.height = h;
        }
        const ctx = ggCanvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const W = rect.width;
          const H = rect.height;
          ctx.clearRect(0, 0, W, H);

          const cx = W * 0.5;
          const cy = H * 0.5;
          const maxR = Math.min(W, H) * 0.4;
          const maxScaleG = 0.8;

          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx - maxR - 6, cy);
          ctx.lineTo(cx + maxR + 6, cy);
          ctx.moveTo(cx, cy - maxR - 6);
          ctx.lineTo(cx, cy + maxR + 6);
          ctx.stroke();

          const rings = [
            { g: 0.25, color: gridColor, dash: [] as number[] },
            { g: 0.4, color: secTrace, dash: [3, 3] },
            { g: 0.65, color: gridColor, dash: [] as number[] },
          ];
          for (const r of rings) {
            ctx.save();
            ctx.setLineDash(r.dash);
            ctx.strokeStyle = r.color;
            ctx.globalAlpha = r.dash.length ? 0.5 : 1;
            ctx.beginPath();
            ctx.arc(cx, cy, (r.g / maxScaleG) * maxR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          ctx.font = '9px "IBM Plex Mono", monospace';
          ctx.fillStyle = labelColor;
          ctx.fillText('+G', cx + 3, cy - maxR + 8);
          ctx.fillText('-G', cx + 3, cy + maxR - 3);

          const trail = trailRef.current;
          if (trail.length > 1) {
            for (let i = 1; i < trail.length; i++) {
              const alpha = (i / trail.length) * 0.55;
              const p0 = trail[i - 1];
              const p1 = trail[i];
              const x0 = cx + Math.max(-1, Math.min(1, p0.latG / maxScaleG)) * maxR;
              const y0 = cy - Math.max(-1, Math.min(1, p0.longG / maxScaleG)) * maxR;
              const x1 = cx + Math.max(-1, Math.min(1, p1.latG / maxScaleG)) * maxR;
              const y1 = cy - Math.max(-1, Math.min(1, p1.longG / maxScaleG)) * maxR;
              ctx.save();
              ctx.globalAlpha = alpha;
              ctx.strokeStyle = primaryTrace;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(x0, y0);
              ctx.lineTo(x1, y1);
              ctx.stroke();
              ctx.restore();
            }
          }

          const vx = cx + Math.max(-1, Math.min(1, drawLatG / maxScaleG)) * maxR;
          const vy = cy - Math.max(-1, Math.min(1, drawLongG / maxScaleG)) * maxR;

          ctx.strokeStyle = m.totalG >= 0.4 ? limitTrace : secTrace;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(vx, vy);
          ctx.stroke();

          ctx.fillStyle = m.totalG >= 0.4 ? limitTrace : m.active || boot.active ? primaryTrace : labelColor;
          ctx.beginPath();
          ctx.arc(vx, vy, 3.6, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = labelColor;
          ctx.fillText(`${m.totalG.toFixed(2)}g`, 6, 13);
          ctx.fillText(`pk ${peakHoldGRef.current.toFixed(2)}`, W - 46, 13);

          ctx.restore();
        }
      }

      // 2. Velocity & Longitudinal G Strip Recorder
      const stripCanvas = stripCanvasRef.current;
      if (stripCanvas) {
        const rect = stripCanvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (stripCanvas.width !== w || stripCanvas.height !== h) {
          stripCanvas.width = w;
          stripCanvas.height = h;
        }
        const ctx = stripCanvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const W = rect.width;
          const H = rect.height;
          ctx.clearRect(0, 0, W, H);

          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          for (let i = 1; i < 4; i++) {
            const y = (H / 4) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
          }

          const samples = stripRef.current;
          if (samples.length < 2) {
            const phaseX = ((now * 0.07) % (W + 80)) - 40;
            const grad = ctx.createLinearGradient(phaseX - 35, 0, phaseX + 35, 0);
            grad.addColorStop(0, 'rgba(125, 123, 116, 0)');
            grad.addColorStop(0.5, 'rgba(125, 123, 116, 0.35)');
            grad.addColorStop(1, 'rgba(125, 123, 116, 0)');
            ctx.strokeStyle = grad;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(0, H * 0.5);
            ctx.lineTo(W, H * 0.5);
            ctx.stroke();

            ctx.font = '11px "IBM Plex Sans", sans-serif';
            ctx.fillStyle = labelColor;
            ctx.fillText('Idle — connect phone, OBD log, or rig', 12, H * 0.5 - 8);
          } else {
            const maxSpd = Math.max(110, th.speedLimitKmh * 1.45, ...samples.map((s) => s.speedKmh));
            const spdToY = (spd: number) => H - (Math.max(0, spd) / maxSpd) * (H - 24) - 10;
            const stepX = W / 200;

            const limY = spdToY(th.speedLimitKmh);
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = limitTrace;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            ctx.moveTo(0, limY);
            ctx.lineTo(W, limY);
            ctx.stroke();
            ctx.restore();

            ctx.strokeStyle = secTrace;
            ctx.lineWidth = 1.15;
            ctx.beginPath();
            samples.forEach((s, idx) => {
              const x = W - (samples.length - idx) * stepX;
              const gy = H * 0.5 - Math.max(-0.85, Math.min(0.85, s.longG)) * (H * 0.42);
              if (idx === 0) ctx.moveTo(x, gy);
              else ctx.lineTo(x, gy);
            });
            ctx.stroke();

            ctx.strokeStyle = m.patternFlags.speeding ? limitTrace : primaryTrace;
            ctx.lineWidth = 1.65;
            ctx.beginPath();
            samples.forEach((s, idx) => {
              const x = W - (samples.length - idx) * stepX;
              const sy = spdToY(s.speedKmh);
              if (idx === 0) ctx.moveTo(x, sy);
              else ctx.lineTo(x, sy);
            });
            ctx.stroke();

            ctx.font = '10px "IBM Plex Mono", monospace';
            ctx.fillStyle = primaryTrace;
            ctx.fillText(`${m.speedKmh.toFixed(1)} km/h`, 8, 14);
            ctx.fillStyle = labelColor;
            ctx.fillText(`lim ${th.speedLimitKmh} · ${m.longG >= 0 ? '+' : ''}${m.longG.toFixed(2)}g`, 74, 14);
          }

          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const countCat = (cat: IncidentRecord['category']) =>
    incidents.filter((i) => i.category === cat).length;

  return (
    <section className="inst-bay">
      <div className="inst-bay-header">
        <div>
          <div className="inst-bay-title">Vehicle Dynamics</div>
          <div className="inst-bay-subtitle">Chronometer, G-G friction envelope &amp; velocity trace</div>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-secondary)' }}>
          {metrics.active ? metrics.nodeLabel : 'Standby'}
        </span>
      </div>

      <div className="inst-bay-body">
        {/* Triple Instrument Cluster: Chronometer + Polar G-G + Strip Recorder */}
        <div className="kinematic-triple-scopes">
          <VelocityChronometer
            speedKmh={metrics.speedKmh}
            speedLimitKmh={thresholds.speedLimitKmh}
            governorEngaged={metrics.governorEngaged}
            governorCapKmh={thresholds.governorCapKmh}
            rpm={metrics.rpm}
          />
          <div className="scope-well" style={{ height: 164 }}>
            <canvas ref={ggCanvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          </div>
          <div className="scope-well" style={{ height: 164 }}>
            <canvas ref={stripCanvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          </div>
        </div>

        <div className="readout-grid">
          <div className="readout-cell">
            <div className="readout-label">
              <span>Speed</span>
              <span className="mono">lim {thresholds.speedLimitKmh}</span>
            </div>
            <div
              className="readout-val"
              style={{
                color: metrics.patternFlags.speeding ? 'var(--status-danger)' : 'var(--ink-primary)',
              }}
            >
              {metrics.speedKmh.toFixed(1)}
              <span className="readout-unit">km/h</span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Longitudinal</span>
              <span className="mono">{metrics.longG.toFixed(2)}g</span>
            </div>
            <div
              className="readout-val"
              style={{
                color:
                  metrics.patternFlags.harshBraking || metrics.patternFlags.rapidAccel
                    ? 'var(--status-danger)'
                    : 'var(--ink-primary)',
              }}
            >
              {metrics.accelLongMs2 >= 0 ? '+' : ''}
              {metrics.accelLongMs2.toFixed(2)}
              <span className="readout-unit">m/s²</span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Lateral</span>
              <span className="mono">{metrics.yawRateDegS.toFixed(0)}°/s</span>
            </div>
            <div
              className="readout-val"
              style={{
                color: Math.abs(metrics.accelLatMs2) >= thresholds.rashLatMs2 ? 'var(--status-danger)' : 'var(--ink-primary)',
              }}
            >
              {metrics.latG >= 0 ? '+' : ''}
              {metrics.latG.toFixed(2)}
              <span className="readout-unit">g</span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Jerk</span>
              <span className="mono">{metrics.distanceKm.toFixed(2)} km</span>
            </div>
            <div className="readout-val">
              {metrics.jerkMs3.toFixed(1)}
              <span className="readout-unit">m/s³</span>
            </div>
          </div>
        </div>

        <div className="pattern-grid">
          <div ref={cardBrakeRef} className={`pattern-card ${metrics.patternFlags.harshBraking ? 'tripped' : ''}`}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Harsh braking</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                ≤ {thresholds.harshBrakeMs2.toFixed(1)} m/s² ({(thresholds.harshBrakeMs2 / 9.81).toFixed(2)}g)
              </div>
            </div>
            <OdometerValue value={countCat('HARSH_BRAKING')} fontSize={14} />
          </div>

          <div ref={cardAccelRef} className={`pattern-card ${metrics.patternFlags.rapidAccel ? 'tripped' : ''}`}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Rapid acceleration</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                ≥ +{thresholds.rapidAccelMs2.toFixed(1)} m/s² (+{(thresholds.rapidAccelMs2 / 9.81).toFixed(2)}g)
              </div>
            </div>
            <OdometerValue value={countCat('RAPID_ACCELERATION')} fontSize={14} />
          </div>

          <div ref={cardSpeedRef} className={`pattern-card ${metrics.patternFlags.speeding ? 'tripped' : ''}`}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Speeding</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                Zone limit {thresholds.speedLimitKmh} km/h
              </div>
            </div>
            <OdometerValue value={countCat('SPEEDING')} fontSize={14} />
          </div>

          <div ref={cardRashRef} className={`pattern-card ${metrics.patternFlags.rashDriving ? 'tripped' : ''}`}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Rash driving &amp; weave</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-muted)' }}>
                Lat ≥ {(thresholds.rashLatMs2 / 9.81).toFixed(2)}g · Weave {metrics.weaveReversals}/3
              </div>
            </div>
            <OdometerValue value={countCat('RASH_DRIVING')} fontSize={14} />
          </div>
        </div>
      </div>
    </section>
  );
};
