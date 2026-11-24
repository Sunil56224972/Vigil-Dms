import type { IncidentCategory } from '../types/telemetry';

const CATEGORY_LABELS: Record<string, string> = {
  MICROSLEEP: 'Microsleep',
  DROWSINESS_PERCLOS: 'Drowsiness · PERCLOS',
  FATIGUE_YAWN: 'Fatigue · Yawning',
  HEAD_NOD: 'Postural Head Droop',
  VISUAL_DISTRACTION: 'Off-Road Gaze',
  CAMERA_OCCLUSION: 'Camera Occluded',
  HARSH_BRAKING: 'Harsh Braking',
  RAPID_ACCELERATION: 'Rapid Acceleration',
  SPEEDING: 'Speed Limit Breach',
  RASH_DRIVING: 'Rash Maneuver',
};

const ACTION_TOKEN_MAP: Record<string, string> = {
  WAKE_SIREN: 'Wake siren',
  PERIPHERAL_STROBE: 'Cabin strobe',
  HAZARD_BEACONS: '4-way hazards',
  AUTO_HAZARD_BEACONS: '4-way hazards',
  HAZARD_BEACON_STROBE: '4-way hazards',
  VOICE_WAKE_ORDER: 'Voice wake callout',
  URGENT_CHIME: 'Warning tone',
  VOICE_REST_DIRECTIVE: 'Rest voice prompt',
  POSTURE_VOICE_ALERT: 'Posture voice prompt',
  WARNING_PULSE: 'Warning tone',
  FATIGUE_BREAK_VOICE_PROMPT: 'Break voice prompt',
  ADVISORY_HARMONIC_CHIME: 'Advisory chime',
  ATTENTION_CHIME: 'Attention chime',
  VOICE_EYES_ON_ROAD: 'Eyes-on-road voice',
  OPTICAL_LOSS_WARNING: 'Sensor loss tone',
  BRAKE_WARNING_PULSE: 'Brake tone',
  CABIN_CALLOUT: 'Cabin voice',
  VOICE_FOLLOWING_DISTANCE: 'Distance voice prompt',
  CABIN_CHIME: 'Cabin chime',
  FOLLOWING_DISTANCE_ADVISORY: 'Distance prompt',
  THROTTLE_MODERATION_ALERT: 'Throttle advisory',
  THROTTLE_SMOOTHING_ADVISORY: 'Smooth-throttle prompt',
  AUDIO_ALERT: 'Audio chime',
  SPEED_GOVERNOR_LIMITER: 'Speed governor',
  SPEED_GOVERNOR_ENGAGE: 'Speed governor',
  OVERSPEED_VOICE_WARNING: 'Overspeed voice',
  VOICE_DECELERATE_ORDER: 'Decelerate voice',
  OVERSPEED_CHIME: 'Overspeed chime',
  OVERSPEED_ACOUSTIC_PULSE: 'Overspeed chime',
  HUD_LIMIT_ALERT: 'Limit indicator',
  HUD_LIMIT_FLASH: 'Limit indicator',
  STABILITY_SPEED_CAP: 'Stability speed cap',
  STABILITY_GOVERNOR_CAP: 'Stability speed cap',
  VOICE_DIRECTIVE: 'Stability voice',
  CRITICAL_VOICE_INTERVENTION: 'Critical voice',
  LATERAL_STABILITY_ALERT: 'Lateral load tone',
  LATERAL_LOAD_WARNING: 'Lateral load tone',
  CABIN_ALERT: 'Cabin chime',
  AUDIO_VISUAL_ALERT: 'Cabin alert',
};

export function formatCategoryLabel(category: IncidentCategory | string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return category
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function formatInterventionLabel(raw: string): string {
  if (!raw) return 'Logged';
  // Already human-formatted sentence case
  if (!raw.includes('_') && raw !== raw.toUpperCase()) {
    return raw;
  }
  return raw
    .split(/\s*\+\s*/)
    .map((part) => {
      const trimmed = part.trim();
      if (ACTION_TOKEN_MAP[trimmed]) return ACTION_TOKEN_MAP[trimmed];
      const govMatch = trimmed.match(/^GOVERNOR_CAP_(\d+)KMH$/);
      if (govMatch) return `Governor ${govMatch[1]} km/h cap`;
      return trimmed
        .toLowerCase()
        .split('_')
        .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
    })
    .join(' · ');
}
