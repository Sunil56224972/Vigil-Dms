import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type {
  OcularLandmarksOverlay,
  OcularMetrics,
  OpticalSourceMode,
  Point2D,
  ThresholdsConfig,
} from '../types/telemetry';

const LEFT_EYE_IDX = [33, 160, 158, 133, 153, 144] as const;
const RIGHT_EYE_IDX = [362, 385, 387, 263, 373, 380] as const;
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;
const MOUTH_OUTER_IDX = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const MOUTH_INNER_IDX = [78, 81, 13, 311, 308, 402, 14, 178];
const JAW_CONTOUR_IDX = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];

const RAD_TO_DEG = 180 / Math.PI;

function dist2D(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function computeEyeAspectRatio(pts: Point2D[]): number {
  if (pts.length < 6) return 0.3;
  const v1 = dist2D(pts[1], pts[5]);
  const v2 = dist2D(pts[2], pts[4]);
  const horiz = dist2D(pts[0], pts[3]);
  if (horiz < 1e-5) return 0.3;
  return (v1 + v2) / (2.0 * horiz);
}

function computeMouthAspectRatio(
  landmarks: Array<{ x: number; y: number }>,
  aspectW: number,
  aspectH: number
): number {
  const pt = (idx: number): Point2D => ({
    x: landmarks[idx].x * aspectW,
    y: landmarks[idx].y * aspectH,
  });
  const leftCorner = pt(78);
  const rightCorner = pt(308);
  const horiz = dist2D(leftCorner, rightCorner);
  if (horiz < 1e-5) return 0;

  const vCenter = dist2D(pt(13), pt(14));
  const vLeft = dist2D(pt(81), pt(178));
  const vRight = dist2D(pt(311), pt(402));
  return (vCenter + vLeft + vRight) / (3.0 * horiz);
}

function extractEulerPoseDeg(matrixData?: Float32Array | number[]): {
  pitch: number;
  yaw: number;
  roll: number;
} | null {
  if (!matrixData || matrixData.length < 16) return null;
  const m00 = matrixData[0];
  const m10 = matrixData[1];
  const m20 = matrixData[2];
  const m21 = matrixData[6];
  const m22 = matrixData[10];

  const sy = Math.hypot(m00, m10);
  const pitch = Math.atan2(-m21, m22) * RAD_TO_DEG;
  const yaw = Math.atan2(m20, sy) * RAD_TO_DEG;
  const roll = sy > 1e-5 ? Math.atan2(m10, m00) * RAD_TO_DEG : 0;
  return { pitch, yaw, roll };
}

export class OcularBiometricEngine {
  private landmarker: FaceLandmarker | null = null;
  private initializing: Promise<void> | null = null;
  private lastVideoTime = -1;
  private lastProcessWallMs = 0;
  private lastMpTimestampMs = 0;

  // Calibration state
  private calibrated = false;
  private calibrationSamples: Array<{ ear: number; pitch: number; yaw: number; roll: number }> = [];
  private calibrationStartedAt: number | null = null;
  private readonly CALIBRATION_DURATION_MS = 3000;

  private earBaseline = 0.285;
  private pitchZero = 0;
  private yawZero = 0;
  private rollZero = 0;

  // Smoothed signal accumulators
  private smoothEarLeft = 0.285;
  private smoothEarRight = 0.285;
  private smoothMar = 0.05;
  private smoothPitch = 0;
  private smoothYaw = 0;
  private smoothRoll = 0;
  private smoothFps = 0;

  // Temporal physiological state
  private eyeClosedSinceMs: number | null = null;
  private eyeClosedAccumMs = 0;
  private blinkTimestampsMs: number[] = [];
  private totalBlinks = 0;
  private lastBlinkDurationMs = 0;

  private yawnStartMs: number | null = null;
  private yawnCountedInCurrentOpen = false;
  private totalYawns = 0;
  private recentYawnTimestampsMs: number[] = [];

  private distractionStartMs: number | null = null;
  private headNodStartMs: number | null = null;
  private faceMissingStartMs: number | null = null;

  private perclosWindow: Array<{ tMs: number; dtMs: number; closed: boolean }> = [];

  async ensureInitialized(): Promise<void> {
    if (this.landmarker) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      const vision = await FilesetResolver.forVisionTasks('/wasm');
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/models/face_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      } catch {
        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/models/face_landmarker.task',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      }
    })();

    return this.initializing;
  }

  startNeutralCalibration(): void {
    this.calibrationSamples = [];
    this.calibrationStartedAt = performance.now();
  }

  resetSessionCounters(): void {
    this.eyeClosedSinceMs = null;
    this.eyeClosedAccumMs = 0;
    this.blinkTimestampsMs = [];
    this.totalBlinks = 0;
    this.lastBlinkDurationMs = 0;
    this.yawnStartMs = null;
    this.yawnCountedInCurrentOpen = false;
    this.totalYawns = 0;
    this.recentYawnTimestampsMs = [];
    this.distractionStartMs = null;
    this.headNodStartMs = null;
    this.faceMissingStartMs = null;
    this.perclosWindow = [];
    this.lastVideoTime = -1;
  }

  createStandbySnapshot(sourceMode: OpticalSourceMode = 'OFFLINE'): OcularMetrics {
    return {
      active: sourceMode !== 'OFFLINE',
      sourceMode,
      faceDetected: false,
      fps: 0,
      inferenceMs: 0,
      earLeft: 0,
      earRight: 0,
      earMean: 0,
      earBaseline: Number(this.earBaseline.toFixed(3)),
      earThreshold: Number((this.earBaseline * 0.72).toFixed(3)),
      eyeClosedMs: 0,
      perclos60: 0,
      blinkCount: this.totalBlinks,
      blinkRatePerMin: 0,
      lastBlinkDurationMs: this.lastBlinkDurationMs,
      mar: 0,
      yawnActive: false,
      yawnHoldMs: 0,
      yawnCount: this.totalYawns,
      pitchDeg: 0,
      yawDeg: 0,
      rollDeg: 0,
      gazeHorizontal: 0,
      gazeVertical: 0,
      distractionHoldMs: 0,
      headNodHoldMs: 0,
      faceMissingMs: 0,
      calibrated: this.calibrated,
      calibratingProgress: null,
      fatigueIndex: 0,
      attentionState: 'STANDBY',
    };
  }

  processVideoFrame(
    video: HTMLVideoElement,
    sourceMode: OpticalSourceMode,
    thresholds: ThresholdsConfig
  ): { metrics: OcularMetrics; overlay: OcularLandmarksOverlay | null } | null {
    if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) {
      return null;
    }

    // Skip redundant inference if browser RAF ticks faster than decoded camera/video frame rate
    if (video.currentTime === this.lastVideoTime) {
      return null;
    }
    this.lastVideoTime = video.currentTime;

    const nowMs = performance.now();
    const dtWallMs =
      this.lastProcessWallMs > 0 ? Math.min(250, Math.max(8, nowMs - this.lastProcessWallMs)) : 33;
    this.lastProcessWallMs = nowMs;

    const instantFps = 1000 / dtWallMs;
    this.smoothFps = this.smoothFps === 0 ? instantFps : this.smoothFps * 0.85 + instantFps * 0.15;

    // Guarantee strictly monotonic integer millisecond timestamp for MediaPipe WASM calculator graph
    const mpTimestampMs = Math.max(Math.floor(nowMs), this.lastMpTimestampMs + 1);
    this.lastMpTimestampMs = mpTimestampMs;

    let result;
    const t0 = performance.now();
    try {
      result = this.landmarker.detectForVideo(video, mpTimestampMs);
    } catch {
      return null;
    }
    const inferenceMs = performance.now() - t0;

    const w = video.videoWidth;
    const h = video.videoHeight;

    if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
      if (this.faceMissingStartMs == null) this.faceMissingStartMs = nowMs;
      const missingMs = Math.round(nowMs - this.faceMissingStartMs);
      return {
        overlay: null,
        metrics: {
          ...this.createStandbySnapshot(sourceMode),
          active: true,
          fps: Math.round(this.smoothFps),
          inferenceMs: Number(inferenceMs.toFixed(1)),
          faceMissingMs: missingMs,
          attentionState: 'NO_SUBJECT',
        },
      };
    }

    this.faceMissingStartMs = null;
    const lm = result.faceLandmarks[0];
    const toPx = (idx: number): Point2D => ({ x: lm[idx].x * w, y: lm[idx].y * h });
    const toNorm = (idx: number): Point2D => ({ x: lm[idx].x, y: lm[idx].y });

    const leftEyePx = LEFT_EYE_IDX.map(toPx);
    const rightEyePx = RIGHT_EYE_IDX.map(toPx);
    const rawEarLeft = computeEyeAspectRatio(leftEyePx);
    const rawEarRight = computeEyeAspectRatio(rightEyePx);

    const blendMap = new Map<string, number>();
    if (result.faceBlendshapes?.[0]?.categories) {
      for (const cat of result.faceBlendshapes[0].categories) {
        blendMap.set(cat.categoryName, cat.score);
      }
    }
    const blinkScoreL = blendMap.get('eyeBlinkLeft') ?? 0;
    const blinkScoreR = blendMap.get('eyeBlinkRight') ?? 0;

    const adjEarL = blinkScoreL > 0.55 ? Math.min(rawEarLeft, this.earBaseline * 0.55) : rawEarLeft;
    const adjEarR = blinkScoreR > 0.55 ? Math.min(rawEarRight, this.earBaseline * 0.55) : rawEarRight;

    this.smoothEarLeft = this.smoothEarLeft * 0.45 + adjEarL * 0.55;
    this.smoothEarRight = this.smoothEarRight * 0.45 + adjEarR * 0.55;
    const earMean = (this.smoothEarLeft + this.smoothEarRight) * 0.5;

    const rawMar = computeMouthAspectRatio(lm, w, h);
    this.smoothMar = this.smoothMar * 0.55 + rawMar * 0.45;

    const mat = result.facialTransformationMatrixes?.[0]?.data;
    const euler = extractEulerPoseDeg(mat);
    let rawPitch = 0;
    let rawYaw = 0;
    let rawRoll = 0;
    if (euler) {
      rawPitch = euler.pitch;
      rawYaw = euler.yaw;
      rawRoll = euler.roll;
    } else {
      const eyeMidX = (lm[33].x + lm[263].x) * 0.5;
      const eyeMidY = (lm[33].y + lm[263].y) * 0.5;
      const faceSpanX = Math.max(0.05, Math.abs(lm[263].x - lm[33].x));
      const faceSpanY = Math.max(0.05, Math.abs(lm[152].y - eyeMidY));
      rawYaw = ((lm[1].x - eyeMidX) / faceSpanX) * 75;
      rawPitch = ((eyeMidY - lm[1].y + faceSpanY * 0.36) / faceSpanY) * 65;
      rawRoll = Math.atan2(lm[263].y - lm[33].y, lm[263].x - lm[33].x) * RAD_TO_DEG;
    }

    this.smoothPitch = this.smoothPitch * 0.65 + rawPitch * 0.35;
    this.smoothYaw = this.smoothYaw * 0.65 + rawYaw * 0.35;
    this.smoothRoll = this.smoothRoll * 0.65 + rawRoll * 0.35;

    let calibratingProgress: number | null = null;
    if (this.calibrationStartedAt != null) {
      const elapsed = nowMs - this.calibrationStartedAt;
      calibratingProgress = Math.min(1, elapsed / this.CALIBRATION_DURATION_MS);
      if (rawEarLeft > 0.16 && rawEarRight > 0.16) {
        this.calibrationSamples.push({
          ear: (rawEarLeft + rawEarRight) * 0.5,
          pitch: this.smoothPitch,
          yaw: this.smoothYaw,
          roll: this.smoothRoll,
        });
      }
      if (elapsed >= this.CALIBRATION_DURATION_MS) {
        if (this.calibrationSamples.length >= 8) {
          const sortedEar = [...this.calibrationSamples.map((s) => s.ear)].sort((a, b) => a - b);
          const p65 = sortedEar[Math.floor(sortedEar.length * 0.65)];
          this.earBaseline = Math.max(0.21, Math.min(0.42, p65));
          this.pitchZero =
            this.calibrationSamples.reduce((a, s) => a + s.pitch, 0) / this.calibrationSamples.length;
          this.yawZero =
            this.calibrationSamples.reduce((a, s) => a + s.yaw, 0) / this.calibrationSamples.length;
          this.rollZero =
            this.calibrationSamples.reduce((a, s) => a + s.roll, 0) / this.calibrationSamples.length;
          this.calibrated = true;
        }
        this.calibrationStartedAt = null;
        calibratingProgress = null;
      }
    }

    const relPitch = this.smoothPitch - this.pitchZero;
    const relYaw = this.smoothYaw - this.yawZero;
    const relRoll = this.smoothRoll - this.rollZero;

    let gazeH = 0;
    let gazeV = 0;
    if (lm.length > RIGHT_IRIS_CENTER) {
      const lRatioX =
        (lm[LEFT_IRIS_CENTER].x - lm[33].x) / Math.max(1e-4, lm[133].x - lm[33].x) - 0.5;
      const rRatioX =
        (lm[RIGHT_IRIS_CENTER].x - lm[362].x) / Math.max(1e-4, lm[263].x - lm[362].x) - 0.5;
      gazeH = Math.max(-1, Math.min(1, (lRatioX + rRatioX) * 2.2));

      const lookDown =
        ((blendMap.get('eyeLookDownLeft') ?? 0) + (blendMap.get('eyeLookDownRight') ?? 0)) * 0.5;
      const lookUp =
        ((blendMap.get('eyeLookUpLeft') ?? 0) + (blendMap.get('eyeLookUpRight') ?? 0)) * 0.5;
      gazeV = Math.max(-1, Math.min(1, (lookDown - lookUp) * 1.4));
    }

    const earThreshold = Math.max(
      thresholds.earAbsoluteFloor * 0.85,
      this.earBaseline * thresholds.earClosureRatio
    );
    const isEyesClosed = earMean < earThreshold;

    this.perclosWindow.push({ tMs: nowMs, dtMs: dtWallMs, closed: isEyesClosed });
    while (this.perclosWindow.length > 0 && nowMs - this.perclosWindow[0].tMs > 60000) {
      this.perclosWindow.shift();
    }
    let totalWindowMs = 0;
    let closedWindowMs = 0;
    for (const item of this.perclosWindow) {
      totalWindowMs += item.dtMs;
      if (item.closed) closedWindowMs += item.dtMs;
    }
    const perclos60 = totalWindowMs > 1500 ? (closedWindowMs / totalWindowMs) * 100 : 0;

    if (isEyesClosed) {
      if (this.eyeClosedSinceMs == null) {
        this.eyeClosedSinceMs = nowMs;
      }
      this.eyeClosedAccumMs = nowMs - this.eyeClosedSinceMs;
    } else {
      if (this.eyeClosedSinceMs != null) {
        const closedDur = nowMs - this.eyeClosedSinceMs;
        if (closedDur >= 85 && closedDur <= 550) {
          this.totalBlinks += 1;
          this.lastBlinkDurationMs = Math.round(closedDur);
          this.blinkTimestampsMs.push(nowMs);
        } else if (closedDur > 550) {
          this.lastBlinkDurationMs = Math.round(closedDur);
        }
      }
      this.eyeClosedSinceMs = null;
      this.eyeClosedAccumMs = 0;
    }

    while (this.blinkTimestampsMs.length > 0 && nowMs - this.blinkTimestampsMs[0] > 60000) {
      this.blinkTimestampsMs.shift();
    }

    let yawnHoldMs = 0;
    if (this.smoothMar >= thresholds.yawnMarThreshold) {
      if (this.yawnStartMs == null) {
        this.yawnStartMs = nowMs;
        this.yawnCountedInCurrentOpen = false;
      }
      yawnHoldMs = nowMs - this.yawnStartMs;
      if (yawnHoldMs >= thresholds.yawnHoldMs && !this.yawnCountedInCurrentOpen) {
        this.totalYawns += 1;
        this.recentYawnTimestampsMs.push(nowMs);
        this.yawnCountedInCurrentOpen = true;
      }
    } else if (this.smoothMar < thresholds.yawnMarThreshold * 0.78) {
      this.yawnStartMs = null;
      this.yawnCountedInCurrentOpen = false;
    }
    while (this.recentYawnTimestampsMs.length > 0 && nowMs - this.recentYawnTimestampsMs[0] > 600000) {
      this.recentYawnTimestampsMs.shift();
    }

    let headNodHoldMs = 0;
    if (relPitch <= -15.5) {
      if (this.headNodStartMs == null) this.headNodStartMs = nowMs;
      headNodHoldMs = nowMs - this.headNodStartMs;
    } else {
      this.headNodStartMs = null;
    }

    const offRoadHead =
      Math.abs(relYaw) >= thresholds.distractionYawDeg ||
      Math.abs(relPitch) >= thresholds.distractionPitchDeg;
    const offRoadGaze = !isEyesClosed && (Math.abs(gazeH) >= 0.62 || gazeV >= 0.58);
    let distractionHoldMs = 0;
    if ((offRoadHead || offRoadGaze) && headNodHoldMs < 600) {
      if (this.distractionStartMs == null) this.distractionStartMs = nowMs;
      distractionHoldMs = nowMs - this.distractionStartMs;
    } else {
      this.distractionStartMs = null;
    }

    const perclosComponent = Math.min(45, perclos60 * 2.1);
    const closureComponent = Math.min(45, (this.eyeClosedAccumMs / thresholds.microsleepHoldMs) * 42);
    const yawnComponent = Math.min(
      22,
      this.recentYawnTimestampsMs.length * 7 + (yawnHoldMs >= 1000 ? 8 : 0)
    );
    const slowBlinkComponent =
      this.lastBlinkDurationMs > 300 ? Math.min(12, (this.lastBlinkDurationMs - 300) / 15) : 0;
    const nodComponent = headNodHoldMs > 600 ? Math.min(20, (headNodHoldMs / 1500) * 18) : 0;

    const fatigueIndex = Math.max(
      0,
      Math.min(
        100,
        Math.round(perclosComponent + closureComponent + yawnComponent + slowBlinkComponent + nodComponent)
      )
    );

    let attentionState: OcularMetrics['attentionState'] = 'NOMINAL';
    if (calibratingProgress != null) {
      attentionState = 'CALIBRATING';
    } else if (this.eyeClosedAccumMs >= thresholds.microsleepHoldMs) {
      attentionState = 'MICROSLEEP';
    } else if (
      this.eyeClosedAccumMs >= thresholds.drowsyHoldMs ||
      perclos60 >= thresholds.perclosCritPct
    ) {
      attentionState = 'DROWSY';
    } else if (headNodHoldMs >= 1200) {
      attentionState = 'HEAD_DROOP';
    } else if (yawnHoldMs >= thresholds.yawnHoldMs) {
      attentionState = 'YAWNING';
    } else if (distractionHoldMs >= thresholds.distractionHoldMs) {
      attentionState = 'DISTRACTED';
    }

    const overlay: OcularLandmarksOverlay = {
      leftEye: LEFT_EYE_IDX.map(toNorm),
      rightEye: RIGHT_EYE_IDX.map(toNorm),
      leftIris: lm.length > LEFT_IRIS_CENTER ? toNorm(LEFT_IRIS_CENTER) : null,
      rightIris: lm.length > RIGHT_IRIS_CENTER ? toNorm(RIGHT_IRIS_CENTER) : null,
      mouthOuter: MOUTH_OUTER_IDX.map(toNorm),
      mouthInner: MOUTH_INNER_IDX.map(toNorm),
      noseTip: toNorm(1),
      forehead: toNorm(10),
      chin: toNorm(152),
      jawContour: JAW_CONTOUR_IDX.map(toNorm),
    };

    const metrics: OcularMetrics = {
      active: true,
      sourceMode,
      faceDetected: true,
      fps: Math.round(this.smoothFps),
      inferenceMs: Number(inferenceMs.toFixed(1)),
      earLeft: Number(this.smoothEarLeft.toFixed(3)),
      earRight: Number(this.smoothEarRight.toFixed(3)),
      earMean: Number(earMean.toFixed(3)),
      earBaseline: Number(this.earBaseline.toFixed(3)),
      earThreshold: Number(earThreshold.toFixed(3)),
      eyeClosedMs: Math.round(this.eyeClosedAccumMs),
      perclos60: Number(perclos60.toFixed(1)),
      blinkCount: this.totalBlinks,
      blinkRatePerMin: this.blinkTimestampsMs.length,
      lastBlinkDurationMs: this.lastBlinkDurationMs,
      mar: Number(this.smoothMar.toFixed(3)),
      yawnActive: yawnHoldMs >= thresholds.yawnHoldMs,
      yawnHoldMs: Math.round(yawnHoldMs),
      yawnCount: this.totalYawns,
      pitchDeg: Number(relPitch.toFixed(1)),
      yawDeg: Number(relYaw.toFixed(1)),
      rollDeg: Number(relRoll.toFixed(1)),
      gazeHorizontal: Number(gazeH.toFixed(2)),
      gazeVertical: Number(gazeV.toFixed(2)),
      distractionHoldMs: Math.round(distractionHoldMs),
      headNodHoldMs: Math.round(headNodHoldMs),
      faceMissingMs: 0,
      calibrated: this.calibrated,
      calibratingProgress,
      fatigueIndex,
      attentionState,
    };

    return { metrics, overlay };
  }
}
