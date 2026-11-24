import React, { useEffect, useRef } from 'react';
import { OcularGimbalRig } from './OcularGimbalRig';
import type { OcularMetrics, ThresholdsConfig } from '../types/telemetry';

interface BiometricOscilloscopeProps {
  metrics: OcularMetrics;
  thresholds: ThresholdsConfig;
}

interface BioTraceSample {
  ear: number;
  threshold: number;
  perclos: number;
  closed: boolean;
}

export const BiometricOscilloscope: React.FC<BiometricOscilloscopeProps> = ({
  metrics,
  thresholds,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<BioTraceSample[]>([]);
  const latestRef = useRef({ metrics, thresholds });
  latestRef.current = { metrics, thresholds };

  useEffect(() => {
    let rafId = 0;
    let lastSampleMs = 0;

    const renderLoop = (now: number) => {
      const { metrics: m, thresholds: th } = latestRef.current;

      if (m.active && m.faceDetected && now - lastSampleMs >= 45) {
        lastSampleMs = now;
        bufferRef.current.push({
          ear: m.earMean,
          threshold: m.earThreshold,
          perclos: m.perclos60,
          closed: m.earMean < m.earThreshold,
        });
        if (bufferRef.current.length > 220) {
          bufferRef.current.shift();
        }
      } else if (!m.active && bufferRef.current.length > 0) {
        bufferRef.current = [];
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }

        const styles = getComputedStyle(document.documentElement);
        const primaryTrace = styles.getPropertyValue('--trace-primary').trim() || '#e8e6df';
        const secTrace = styles.getPropertyValue('--trace-secondary').trim() || '#7d7b74';
        const limitTrace = styles.getPropertyValue('--trace-limit').trim() || '#a85644';
        const shadeColor = styles.getPropertyValue('--trace-shade').trim() || 'rgba(236, 234, 228, 0.07)';
        const gridColor = styles.getPropertyValue('--trace-grid').trim() || 'rgba(255,255,255,0.05)';
        const labelColor = styles.getPropertyValue('--trace-label').trim() || '#8a8880';

        const ctx = canvas.getContext('2d');
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
          for (let i = 1; i < 8; i++) {
            const x = (W / 8) * i;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
          }

          const samples = bufferRef.current;
          if (samples.length < 2) {
            // Subtle live breathing carrier sweep line while idle
            const phaseX = ((now * 0.08) % (W + 80)) - 40;
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
            ctx.fillText(
              m.active ? 'Acquiring facial landmarks…' : 'Waiting for optical input',
              14,
              H * 0.5 - 8
            );
          } else {
            const earToY = (ear: number) => {
              const clamped = Math.max(0.05, Math.min(0.45, ear));
              return H - ((clamped - 0.05) / 0.4) * (H - 18) - 9;
            };

            const stepX = W / 220;
            ctx.fillStyle = shadeColor;
            samples.forEach((s, idx) => {
              if (s.closed) {
                const x = W - (samples.length - idx) * stepX;
                ctx.fillRect(x, 0, stepX + 1, H);
              }
            });

            const thrY = earToY(m.earThreshold);
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = limitTrace;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, thrY);
            ctx.lineTo(W, thrY);
            ctx.stroke();
            ctx.restore();

            ctx.strokeStyle = secTrace;
            ctx.lineWidth = 1.15;
            ctx.beginPath();
            samples.forEach((s, idx) => {
              const x = W - (samples.length - idx) * stepX;
              const py = H - (Math.min(40, s.perclos) / 40) * (H - 20) - 10;
              if (idx === 0) ctx.moveTo(x, py);
              else ctx.lineTo(x, py);
            });
            ctx.stroke();

            ctx.strokeStyle = primaryTrace;
            ctx.lineWidth = 1.65;
            ctx.beginPath();
            samples.forEach((s, idx) => {
              const x = W - (samples.length - idx) * stepX;
              const y = earToY(s.ear);
              if (idx === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();

            ctx.font = '10px "IBM Plex Mono", monospace';
            ctx.fillStyle = primaryTrace;
            ctx.fillText(`EAR ${m.earMean.toFixed(3)}`, 10, 14);
            ctx.fillStyle = secTrace;
            ctx.fillText(
              `Thr ${m.earThreshold.toFixed(2)} · PERCLOS ${m.perclos60.toFixed(1)}% (warn ${th.perclosWarnPct}%)`,
              86,
              14
            );
          }

          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <section className="inst-bay">
      <div className="inst-bay-header">
        <div>
          <div className="inst-bay-title">Ocular &amp; Cranial Telemetry</div>
          <div className="inst-bay-subtitle">Mechanical aperture shutter, 3-axis gimbal &amp; 10s trace</div>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
          10s window
        </span>
      </div>
      <div className="inst-bay-body">
        <OcularGimbalRig metrics={metrics} thresholds={thresholds} />

        <div className="scope-well" style={{ height: 92 }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 6,
            marginTop: 8,
          }}
        >
          <div className="readout-cell">
            <div className="readout-label">
              <span>Blink rate</span>
            </div>
            <div className="mono" style={{ fontSize: 13, marginTop: 3 }}>
              {metrics.active ? `${metrics.blinkRatePerMin}/m` : '—'}
              <span style={{ color: 'var(--ink-muted)', fontSize: 10.5, marginLeft: 5 }}>
                ({metrics.lastBlinkDurationMs}ms)
              </span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Mouth MAR</span>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 13,
                marginTop: 3,
                color: metrics.yawnActive ? 'var(--status-warn)' : 'var(--ink-primary)',
              }}
            >
              {metrics.active && metrics.faceDetected ? metrics.mar.toFixed(2) : '—'}
              <span style={{ color: 'var(--ink-muted)', fontSize: 10.5, marginLeft: 5 }}>
                ({(metrics.yawnHoldMs / 1000).toFixed(1)}s)
              </span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Gaze H / V</span>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 13,
                marginTop: 3,
                color:
                  metrics.distractionHoldMs >= thresholds.distractionHoldMs
                    ? 'var(--status-warn)'
                    : 'var(--ink-primary)',
              }}
            >
              {metrics.active && metrics.faceDetected
                ? `${metrics.gazeHorizontal >= 0 ? '+' : ''}${metrics.gazeHorizontal.toFixed(2)} / ${metrics.gazeVertical.toFixed(2)}`
                : '—'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
