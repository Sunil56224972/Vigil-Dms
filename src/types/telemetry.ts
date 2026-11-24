export type VehicleProfileKey =
  | 'PASSENGER_SEDAN'
  | 'HEAVY_FREIGHT'
  | 'TRANSIT_COACH'
  | 'CAMPUS_UTILITY';

export type IncidentCategory =
  | 'MICROSLEEP'
  | 'DROWSINESS_PERCLOS'
  | 'FATIGUE_YAWN'
  | 'HEAD_NOD'
  | 'VISUAL_DISTRACTION'
  | 'CAMERA_OCCLUSION'
  | 'HARSH_BRAKING'
  | 'RAPID_ACCELERATION'
  | 'SPEEDING'
  | 'RASH_DRIVING';

export type IncidentSeverity = 'ADVISORY' | 'WARNING' | 'CRITICAL';
export type AlertStage = 0 | 1 | 2 | 3;

export type KinematicSourceMode =
  | 'DISCONNECTED'
  | 'LOCAL_DEVICE_IMU'
  | 'REMOTE_MOBILE_SENSOR'
  | 'FILE_REPLAY'
  | 'EXTERNAL_BUS'
  | 'MANUAL_DYNAMICS_RIG';

export type OpticalSourceMode = 'OFFLINE' | 'LIVE_WEBCAM' | 'VIDEO_FILE';

export interface ThresholdsConfig {
  vehicleProfile: VehicleProfileKey;
  speedLimitKmh: number;
  harshBrakeMs2: number;
  rapidAccelMs2: number;
  rashLatMs2: number;
  rashJerkMs3: number;
  earClosureRatio: number;
  earAbsoluteFloor: number;
  drowsyHoldMs: number;
  microsleepHoldMs: number;
  perclosWarnPct: number;
  perclosCritPct: number;
  yawnMarThreshold: number;
  yawnHoldMs: number;
  distractionYawDeg: number;
  distractionPitchDeg: number;
  distractionHoldMs: number;
  audioArmed: boolean;
  voiceArmed: boolean;
  governorArmed: boolean;
  governorCapKmh: number;
  webhookUrl: string;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface OcularMetrics {
  active: boolean;
  sourceMode: OpticalSourceMode;
  faceDetected: boolean;
  fps: number;
  inferenceMs: number;
  earLeft: number;
  earRight: number;
  earMean: number;
  earBaseline: number;
  earThreshold: number;
  eyeClosedMs: number;
  perclos60: number;
  blinkCount: number;
  blinkRatePerMin: number;
  lastBlinkDurationMs: number;
  mar: number;
  yawnActive: boolean;
  yawnHoldMs: number;
  yawnCount: number;
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
  gazeHorizontal: number;
  gazeVertical: number;
  distractionHoldMs: number;
  headNodHoldMs: number;
  faceMissingMs: number;
  calibrated: boolean;
  calibratingProgress: number | null;
  fatigueIndex: number;
  attentionState:
    | 'STANDBY'
    | 'CALIBRATING'
    | 'NOMINAL'
    | 'DISTRACTED'
    | 'YAWNING'
    | 'HEAD_DROOP'
    | 'DROWSY'
    | 'MICROSLEEP'
    | 'NO_SUBJECT';
}

export interface OcularLandmarksOverlay {
  leftEye: Point2D[];
  rightEye: Point2D[];
  leftIris: Point2D | null;
  rightIris: Point2D | null;
  mouthOuter: Point2D[];
  mouthInner: Point2D[];
  noseTip: Point2D | null;
  forehead: Point2D | null;
  chin: Point2D | null;
  jawContour: Point2D[];
}

export interface KinematicMetrics {
  source: KinematicSourceMode;
  active: boolean;
  nodeLabel: string;
  speedKmh: number;
  speedLimitKmh: number;
  accelLongMs2: number;
  accelLatMs2: number;
  longG: number;
  latG: number;
  totalG: number;
  yawRateDegS: number;
  jerkMs3: number;
  distanceKm: number;
  weaveReversals: number;
  rpm: number | null;
  throttlePct: number | null;
  brakePct: number | null;
  gpsAccuracyM: number | null;
  lat: number | null;
  lon: number | null;
  governorEngaged: boolean;
  hazardBeaconsOn: boolean;
  patternFlags: {
    harshBraking: boolean;
    rapidAccel: boolean;
    speeding: boolean;
    rashDriving: boolean;
  };
}

export interface ActiveInterventionState {
  stage: AlertStage;
  headline: string;
  subline: string;
  category: IncidentCategory | null;
  governorActive: boolean;
  hazardStrobeActive: boolean;
  wakeFlashActive: boolean;
  lockoutRequiresCheck: boolean;
  alertnessHoldProgress: number;
  triggeredAtMs: number | null;
}

export interface SessionRecord {
  id: string;
  started_at: string;
  ended_at: string | null;
  driver_tag: string;
  vehicle_profile: string;
  source_modes: string[] | string;
  distance_km: number;
  peak_speed_kmh: number;
  peak_long_g: number;
  peak_lat_g: number;
  min_ear: number | null;
  peak_perclos: number;
  total_blinks: number;
  total_yawns: number;
  incident_count: number;
  safety_index: number;
}

export interface IncidentRecord {
  seq: number;
  id: string;
  session_id: string | null;
  timestamp_iso: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  stage: number;
  summary: string;
  intervention_action: string;
  metrics_json: string;
  frame_evidence?: string | null;
  prev_hash: string;
  entry_hash: string;
}

export interface LedgerVerification {
  valid: boolean;
  checkedCount: number;
  brokenAtSeq: number | null;
  brokenId: string | null;
  reason: string | null;
  headHash: string;
  genesisHash: string;
  durationMs: number;
  engine?: string;
}

export interface ConnectedSensorNode {
  nodeId: string;
  label: string;
  packetCount: number;
  lastPacketAt: number;
  hasGps: boolean;
  transport: 'SUPABASE_REALTIME' | 'LOCAL_WS';
}

export interface AnalyzedTelemetryReport {
  mappedColumns: Record<string, string | null>;
  samples: Array<{
    index: number;
    tSec: number;
    speedKmh: number;
    accelLongMs2: number;
    accelLatMs2: number;
    longG: number;
    latG: number;
    totalG: number;
    yawRateDegS: number;
    jerkMs3: number;
  }>;
  analysis: {
    summary: {
      sampleCount: number;
      durationSec: number;
      distanceKm: number;
      peakSpeedKmh: number;
      peakLongG: number;
      peakLatG: number;
      peakJerkMs3: number;
      eventCount: number;
      safetyScore: number;
      countsByCategory: {
        HARSH_BRAKING: number;
        RAPID_ACCELERATION: number;
        SPEEDING: number;
        RASH_DRIVING: number;
      };
    };
    events: Array<{
      tSec: number;
      category: IncidentCategory;
      severity: IncidentSeverity;
      stage: number;
      summary: string;
      interventionAction: string;
      metrics: Record<string, number>;
    }>;
  };
  persistedCount: number;
}
