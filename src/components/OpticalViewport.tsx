import React, { useEffect, useRef } from 'react';
import anime from 'animejs';
import { OdometerValue } from './OdometerValue';
import type {
  NightVisionMode,
  OcularLandmarksOverlay,
  OcularMetrics,
  ThresholdsConfig,
} from '../types/telemetry';

interface OpticalViewportProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  hudCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  getEnhancedCanvas: () => HTMLCanvasElement | null;
  metrics: OcularMetrics;
  overlayRef: React.MutableRefObject<OcularLandmarksOverlay | null>;
  thresholds: ThresholdsConfig;
  cameraError: string | null;
  modelLoading: boolean;
  onStartWebcam: () => void;
  onStopOptical: () => void;
  onUploadVideoFile: (file: File) => void;
  onCalibrateNeutral: () => void;
  onChangeNightVisionMode: (mode: NightVisionMode) => void;
}

const STATE_LABELS: Record<OcularMetrics['attentionState'], string> = {
  STANDBY: 'Camera idle',
  CALIBRATING: 'Calibrating pose',
  NOMINAL: 'Attentive',
  DISTRACTED: 'Off-road gaze',
  YAWNING: 'Yawning detected',
  HEAD_DROOP: 'Head droop',
  DROWSY: 'Drowsy closure',
  MICROSLEEP: 'Microsleep alert',
  NO_SUBJECT: 'No face in frame',
};

export const OpticalViewport: React.FC<OpticalViewportProps> = ({
  videoRef,
  hudCanvasRef,
  getEnhancedCanvas,
  metrics,
  overlayRef,
  thresholds,
  cameraError,
  modelLoading,
  onStartWebcam,
  onStopOptical,
  onUploadVideoFile,
  onCalibrateNeutral,
  onChangeNightVisionMode,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shutterTopRef = useRef<HTMLDivElement | null>(null);
  const shutterBotRef = useRef<HTMLDivElement | null>(null);
  const metricsLatestRef = useRef<OcularMetrics>(metrics);
  metricsLatestRef.current = metrics;
  const thresholdsLatestRef = useRef<ThresholdsConfig>(thresholds);
  thresholdsLatestRef.current = thresholds;

  // Mechanical 2-curtain camera shutter reveal when optical stream engages
  useEffect(() => {
    if (!metrics.active) return;
    if (shutterTopRef.current && shutterBotRef.current) {
      shutterTopRef.current.style.display = 'block';
      shutterBotRef.current.style.display = 'block';
      anime({
        targets: shutterTopRef.current,
        translateY: ['0%', '-102%'],
        duration: 540,
        easing: 'cubicBezier(0.16, 1, 0.3, 1)',
      });
      anime({
        targets: shutterBotRef.current,
        translateY: ['0%', '102%'],
        duration: 540,
        easing: 'cubicBezier(0.16, 1, 0.3, 1)',
        complete: () => {
          if (shutterTopRef.current) shutterTopRef.current.style.display = 'none';
          if (shutterBotRef.current) shutterBotRef.current.style.display = 'none';
        },
      });
    }
  }, [metrics.active, metrics.sourceMode]);

  useEffect(() => {
    let rafId = 0;

    const renderHud = () => {
      const canvas = hudCanvasRef.current;
      const video = videoRef.current;
      const m = metricsLatestRef.current;
      const th = thresholdsLatestRef.current;
      const ov = overlayRef.current;

      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.max(1, Math.floor(rect.width * dpr));
        const targetH = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const W = rect.width;
          const H = rect.height;
          ctx.clearRect(0, 0, W, H);

          const isMirrored = m.sourceMode === 'LIVE_WEBCAM';

          // Render real-time Adaptive Night-Vision / Low-Light enhanced buffer when active
          const enhCanvas = m.active && m.nightVisionActive ? getEnhancedCanvas() : null;
          if (enhCanvas && enhCanvas.width > 0 && enhCanvas.height > 0) {
            const vidAspect = enhCanvas.width / enhCanvas.height;
            const boxAspect = W / H;
            let drawW = W;
            let drawH = H;
            let offsetX = 0;
            let offsetY = 0;
            if (vidAspect > boxAspect) {
              drawW = H * vidAspect;
              offsetX = (W - drawW) * 0.5;
            } else {
              drawH = W / vidAspect;
              offsetY = (H - drawH) * 0.5;
            }
            ctx.save();
            if (isMirrored) {
              ctx.translate(W, 0);
              ctx.scale(-1, 1);
            }
            ctx.drawImage(enhCanvas, offsetX, offsetY, drawW, drawH);
            ctx.restore();
          }
          const mapX = (nx: number) => {
            if (!video || video.videoWidth === 0) return nx * W;
            const vidAspect = video.videoWidth / video.videoHeight;
            const boxAspect = W / H;
            let drawW = W;
            let offsetX = 0;
            if (vidAspect > boxAspect) {
              drawW = H * vidAspect;
              offsetX = (W - drawW) * 0.5;
            }
            const x = offsetX + nx * drawW;
            return isMirrored ? W - x : x;
          };

          const mapY = (ny: number) => {
            if (!video || video.videoWidth === 0) return ny * H;
            const vidAspect = video.videoWidth / video.videoHeight;
            const boxAspect = W / H;
            let drawH = H;
            let offsetY = 0;
            if (vidAspect <= boxAspect) {
              drawH = W / vidAspect;
              offsetY = (H - drawH) * 0.5;
            }
            return offsetY + ny * drawH;
          };

          // Subtle Leica-style viewfinder framing ticks
          const bLen = 14;
          const pad = 12;
          ctx.strokeStyle =
            m.attentionState === 'MICROSLEEP'
              ? '#cc4430'
              : m.attentionState !== 'NOMINAL' && m.attentionState !== 'STANDBY'
              ? '#c7882c'
              : 'rgba(236, 234, 228, 0.32)';
          ctx.lineWidth = 1;

          const corners = [
            [pad, pad + bLen, pad, pad, pad + bLen, pad],
            [W - pad - bLen, pad, W - pad, pad, W - pad, pad + bLen],
            [pad, H - pad - bLen, pad, H - pad, pad + bLen, H - pad],
            [W - pad - bLen, H - pad, W - pad, H - pad, W - pad, H - pad - bLen],
          ];
          for (const [x1, y1, x2, y2, x3, y3] of corners) {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.lineTo(x3, y3);
            ctx.stroke();
          }

          if (m.active) {
            // Clean monochrome Yaw Reference Scale
            const tapeW = Math.min(200, W * 0.48);
            const tapeX = (W - tapeW) * 0.5;
            const tapeY = 16;
            ctx.strokeStyle = 'rgba(236, 234, 228, 0.22)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tapeX, tapeY);
            ctx.lineTo(tapeX + tapeW, tapeY);
            ctx.stroke();

            const safeFrac = Math.min(1, th.distractionYawDeg / 45);
            const safeSpan = tapeW * safeFrac;
            ctx.strokeStyle = 'rgba(236, 234, 228, 0.58)';
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(W * 0.5 - safeSpan * 0.5, tapeY);
            ctx.lineTo(W * 0.5 + safeSpan * 0.5, tapeY);
            ctx.stroke();

            const clampedYaw = Math.max(-45, Math.min(45, isMirrored ? -m.yawDeg : m.yawDeg));
            const yawX = W * 0.5 + (clampedYaw / 45) * (tapeW * 0.5);
            ctx.fillStyle = Math.abs(m.yawDeg) >= th.distractionYawDeg ? '#c7882c' : '#eceae4';
            ctx.beginPath();
            ctx.moveTo(yawX, tapeY + 2);
            ctx.lineTo(yawX - 3.5, tapeY + 8);
            ctx.lineTo(yawX + 3.5, tapeY + 8);
            ctx.closePath();
            ctx.fill();

            ctx.font = '10px "IBM Plex Mono", monospace';
            ctx.fillStyle = 'rgba(236, 234, 228, 0.72)';
            ctx.fillText(`Yaw ${m.yawDeg >= 0 ? '+' : ''}${m.yawDeg.toFixed(0)}°`, tapeX, tapeY + 18);
            ctx.fillText(`Pitch ${m.pitchDeg >= 0 ? '+' : ''}${m.pitchDeg.toFixed(0)}°`, tapeX + tapeW - 64, tapeY + 18);
          }

          if (m.active && m.faceDetected && ov) {
            const isEyeClosed = m.earMean < m.earThreshold;
            const eyeStroke =
              m.eyeClosedMs >= th.microsleepHoldMs
                ? '#cc4430'
                : isEyeClosed
                ? '#c7882c'
                : 'rgba(236, 234, 228, 0.88)';

            if (ov.jawContour.length > 2) {
              ctx.strokeStyle = 'rgba(236, 234, 228, 0.18)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ov.jawContour.forEach((p, idx) => {
                const x = mapX(p.x);
                const y = mapY(p.y);
                if (idx === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              });
              ctx.stroke();
            }

            const drawEye = (pts: typeof ov.leftEye, iris: typeof ov.leftIris, earVal: number, tag: string) => {
              if (pts.length < 6) return;
              ctx.strokeStyle = eyeStroke;
              ctx.lineWidth = 1.35;
              ctx.beginPath();
              pts.forEach((p, i) => {
                const x = mapX(p.x);
                const y = mapY(p.y);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              });
              ctx.closePath();
              ctx.stroke();

              if (iris && !isEyeClosed) {
                const ix = mapX(iris.x);
                const iy = mapY(iris.y);
                ctx.strokeStyle = 'rgba(236, 234, 228, 0.75)';
                ctx.lineWidth = 1.1;
                ctx.beginPath();
                ctx.arc(ix, iy, 3, 0, Math.PI * 2);
                ctx.stroke();

                const gx = ix + (isMirrored ? -m.gazeHorizontal : m.gazeHorizontal) * 22;
                const gy = iy + m.gazeVertical * 16;
                ctx.strokeStyle =
                  Math.abs(m.gazeHorizontal) >= 0.62 ? '#c7882c' : 'rgba(236, 234, 228, 0.55)';
                ctx.beginPath();
                ctx.moveTo(ix, iy);
                ctx.lineTo(gx, gy);
                ctx.stroke();
              }

              const anchorX = mapX(pts[0].x);
              const anchorY = mapY(pts[1].y) - 8;
              ctx.font = '9.5px "IBM Plex Mono", monospace';
              ctx.fillStyle = eyeStroke;
              ctx.fillText(`${tag} ${earVal.toFixed(2)}`, anchorX - 8, anchorY);
            };

            drawEye(ov.leftEye, ov.leftIris, m.earLeft, 'L');
            drawEye(ov.rightEye, ov.rightIris, m.earRight, 'R');

            if (ov.mouthInner.length >= 6) {
              ctx.strokeStyle = m.yawnActive ? '#c7882c' : 'rgba(236, 234, 228, 0.3)';
              ctx.lineWidth = m.yawnActive ? 1.5 : 1;
              ctx.beginPath();
              ov.mouthInner.forEach((p, i) => {
                const x = mapX(p.x);
                const y = mapY(p.y);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              });
              ctx.closePath();
              ctx.stroke();
            }
          }

          if (m.calibratingProgress != null) {
            const cx = W * 0.5;
            const cy = H * 0.5;
            ctx.fillStyle = 'rgba(16, 16, 15, 0.6)';
            ctx.fillRect(0, 0, W, H);

            ctx.strokeStyle = 'rgba(236, 234, 228, 0.22)';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(cx, cy, 40, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = '#eceae4';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(
              cx,
              cy,
              40,
              -Math.PI / 2,
              -Math.PI / 2 + Math.PI * 2 * m.calibratingProgress
            );
            ctx.stroke();

            ctx.font = '600 12px "IBM Plex Sans", sans-serif';
            ctx.fillStyle = '#eceae4';
            ctx.textAlign = 'center';
            ctx.fillText('Calibrating neutral pose', cx, cy - 3);
            ctx.font = '11px "IBM Plex Mono", monospace';
            ctx.fillStyle = '#a8a59d';
            ctx.fillText(`${Math.round(m.calibratingProgress * 100)}% — look straight ahead`, cx, cy + 14);
            ctx.textAlign = 'start';
          }

          if (m.active) {
            ctx.fillStyle = 'rgba(16, 16, 15, 0.76)';
            ctx.fillRect(12, H - 28, 224, 19);
            ctx.font = '10px "IBM Plex Mono", monospace';
            ctx.fillStyle = '#d4d1c9';
            ctx.fillText(
              `${m.calibrated ? 'Calibrated' : 'Default baseline'} · ${m.inferenceMs.toFixed(1)}ms · ${m.fps} fps`,
              18,
              H - 15
            );

            if (m.nightVisionActive) {
              const irLabel = `Night IR +${m.nightGainDb.toFixed(1)}dB · Luma ${m.ambientLuma}`;
              ctx.font = '10px "IBM Plex Mono", monospace';
              const tw = ctx.measureText(irLabel).width + 14;
              ctx.fillStyle = 'rgba(16, 16, 15, 0.82)';
              ctx.fillRect(W - tw - 12, H - 28, tw, 19);
              ctx.strokeStyle = 'rgba(236, 234, 228, 0.35)';
              ctx.lineWidth = 1;
              ctx.strokeRect(W - tw - 12, H - 28, tw, 19);
              ctx.fillStyle = '#eceae4';
              ctx.fillText(irLabel, W - tw - 5, H - 15);
            }
          }

          ctx.restore();
        }
      }
      rafId = requestAnimationFrame(renderHud);
    };

    rafId = requestAnimationFrame(renderHud);
    return () => cancelAnimationFrame(rafId);
  }, [hudCanvasRef, overlayRef, videoRef]);

  const friendlyError =
    cameraError && cameraError.toLowerCase().includes('permission')
      ? 'Camera permission is blocked in browser site settings. Allow camera access in the address bar or load a recorded driver video.'
      : cameraError;

  return (
    <section className="inst-bay">
      <div className="inst-bay-header">
        <div>
          <div className="inst-bay-title">Cabin Vision</div>
          <div className="inst-bay-subtitle">478-point mesh, Night-IR gain &amp; gaze cone</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className={`hw-btn ${(thresholds.nightVisionMode ?? 'AUTO') === 'ON' || metrics.nightVisionActive ? 'selected' : ''}`}
            style={{ height: 24, padding: '0 8px', fontSize: 11 }}
            title="Cycle low-light Night-IR enhancement (Auto / On / Off)"
            onClick={() => {
              const cur = thresholds.nightVisionMode ?? 'AUTO';
              const next: NightVisionMode =
                cur === 'AUTO' ? 'ON' : cur === 'ON' ? 'OFF' : 'AUTO';
              onChangeNightVisionMode(next);
            }}
          >
            Night IR: {thresholds.nightVisionMode === 'ON' ? 'On' : thresholds.nightVisionMode === 'OFF' ? 'Off' : 'Auto'}
            {metrics.active && metrics.nightVisionActive ? ` (+${metrics.nightGainDb.toFixed(1)}dB)` : ''}
          </button>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color:
                metrics.attentionState === 'MICROSLEEP'
                  ? 'var(--status-danger)'
                  : metrics.attentionState !== 'NOMINAL' && metrics.attentionState !== 'STANDBY'
                  ? 'var(--status-warn)'
                  : 'var(--ink-secondary)',
            }}
          >
            {STATE_LABELS[metrics.attentionState]}
          </span>
        </div>
      </div>

      <div className="inst-bay-body">
        <div className="optical-well">
          <video
            ref={videoRef}
            className={`optical-video ${metrics.sourceMode === 'LIVE_WEBCAM' ? 'mirrored' : ''}`}
            playsInline
            muted
            style={{ visibility: metrics.active ? 'visible' : 'hidden' }}
          />
          <canvas ref={hudCanvasRef} className="optical-hud-canvas" />
          <div
            ref={shutterTopRef}
            aria-hidden="true"
            style={{
              display: 'none',
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '51%',
              background: '#121211',
              borderBottom: '1px solid #353530',
              zIndex: 4,
              pointerEvents: 'none',
            }}
          />
          <div
            ref={shutterBotRef}
            aria-hidden="true"
            style={{
              display: 'none',
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: '51%',
              background: '#121211',
              borderTop: '1px solid #353530',
              zIndex: 4,
              pointerEvents: 'none',
            }}
          />

          {!metrics.active && (
            <div className="optical-idle-overlay">
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#eceae4', marginBottom: 4 }}>
                No optical stream connected
              </div>
              <div style={{ fontSize: 12, color: '#8e8c84', maxWidth: 310, marginBottom: 14 }}>
                Connect an in-cabin webcam or load recorded footage to measure live eyelid closure, yawning, and gaze direction.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="hw-btn"
                  style={{ background: '#eceae4', color: '#141413', borderColor: '#eceae4', fontWeight: 600 }}
                  onClick={onStartWebcam}
                  disabled={modelLoading}
                >
                  {modelLoading ? 'Loading local vision model…' : 'Engage webcam'}
                </button>
                <button
                  type="button"
                  className="hw-btn"
                  style={{ background: '#232320', color: '#e2e0da', borderColor: '#363631' }}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={modelLoading}
                >
                  Load driver video
                </button>
              </div>
              {friendlyError && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '7px 11px',
                    background: '#1c1b19',
                    border: '1px solid #3d3b36',
                    borderLeft: '3px solid #b83a2c',
                    borderRadius: 4,
                    color: '#d8d5ce',
                    fontSize: 11.5,
                    maxWidth: 340,
                  }}
                >
                  {friendlyError}
                </div>
              )}
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadVideoFile(f);
            e.target.value = '';
          }}
        />

        {metrics.active && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              marginTop: 9,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="hw-btn danger" onClick={onStopOptical}>
                Disconnect camera
              </button>
              {metrics.sourceMode === 'VIDEO_FILE' && (
                <button
                  type="button"
                  className="hw-btn"
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    if (v.paused) v.play().catch(() => {});
                    else v.pause();
                  }}
                >
                  Play / Pause video
                </button>
              )}
              <button
                type="button"
                className="hw-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={modelLoading}
              >
                {metrics.sourceMode === 'VIDEO_FILE' ? 'Switch video' : 'Load video'}
              </button>
            </div>

            <button
              type="button"
              className="hw-btn primary"
              disabled={!metrics.faceDetected || metrics.calibratingProgress != null}
              onClick={onCalibrateNeutral}
            >
              {metrics.calibrated ? 'Recalibrate baseline (3s)' : 'Calibrate neutral pose (3s)'}
            </button>
          </div>
        )}

        <div className="readout-grid">
          <div className="readout-cell">
            <div className="readout-label">
              <span>EAR</span>
              <span className="mono">thr {metrics.earThreshold.toFixed(2)}</span>
            </div>
            <div
              className="readout-val"
              style={{
                color:
                  metrics.active && metrics.faceDetected && metrics.earMean < metrics.earThreshold
                    ? 'var(--status-danger)'
                    : 'var(--ink-primary)',
              }}
            >
              {metrics.active && metrics.faceDetected ? metrics.earMean.toFixed(3) : '—'}
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>PERCLOS</span>
              <span className="mono">60s</span>
            </div>
            <div
              className="readout-val"
              style={{
                color:
                  metrics.perclos60 >= thresholds.perclosCritPct
                    ? 'var(--status-danger)'
                    : metrics.perclos60 >= thresholds.perclosWarnPct
                    ? 'var(--status-warn)'
                    : 'var(--ink-primary)',
              }}
            >
              {metrics.active ? metrics.perclos60.toFixed(1) : '0.0'}
              <span className="readout-unit">%</span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Closure</span>
              <span className="mono">{metrics.blinkCount} bl</span>
            </div>
            <div
              className="readout-val"
              style={{
                color:
                  metrics.eyeClosedMs >= thresholds.microsleepHoldMs
                    ? 'var(--status-danger)'
                    : metrics.eyeClosedMs >= thresholds.drowsyHoldMs
                    ? 'var(--status-warn)'
                    : 'var(--ink-primary)',
              }}
            >
              {metrics.active ? (metrics.eyeClosedMs / 1000).toFixed(2) : '0.00'}
              <span className="readout-unit">s</span>
            </div>
          </div>

          <div className="readout-cell">
            <div className="readout-label">
              <span>Fatigue</span>
              <span className="mono">{metrics.yawnCount} yn</span>
            </div>
            <div
              className="readout-val"
              style={{
                color:
                  metrics.fatigueIndex >= 65
                    ? 'var(--status-danger)'
                    : metrics.fatigueIndex >= 35
                    ? 'var(--status-warn)'
                    : 'var(--ink-primary)',
              }}
            >
              <OdometerValue value={metrics.active ? metrics.fatigueIndex : 0} suffix="/100" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
