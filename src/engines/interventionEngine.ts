import type {
  ActiveInterventionState,
  AlertStage,
  IncidentCategory,
  IncidentSeverity,
  KinematicMetrics,
  OcularMetrics,
  ThresholdsConfig,
} from '../types/telemetry';

export interface EmittedSafetyIncident {
  category: IncidentCategory;
  severity: IncidentSeverity;
  stage: AlertStage;
  summary: string;
  interventionAction: string;
  metrics: Record<string, unknown>;
  captureOpticalSnapshot: boolean;
}

class CabinAcousticSynthesizer {
  private ctx: AudioContext | null = null;
  private sirenInterval: number | null = null;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        this.ensureContext();
      }, 0);
    }
  }

  playAdvisoryChime(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [523.25, 659.25];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);
      gain.gain.setValueAtTime(0.0001, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.24);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.26);
    });
  }

  playWarningPulse(urgent = false): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const pulses = urgent ? 3 : 2;
    const baseFreq = urgent ? 880 : 740;

    for (let i = 0; i < pulses; i++) {
      const t = now + i * 0.13;
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(baseFreq, t);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2100, t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.095);

      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.105);
    }
  }

  startCriticalSiren(): void {
    if (this.sirenInterval != null) return;
    const fireCycle = () => {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const freqs = [960, 1320];
      freqs.forEach((f, idx) => {
        const t = now + idx * 0.16;
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(f, t);
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1150, t);
        filter.Q.setValueAtTime(1.4, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.24, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        osc.connect(filter).connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
      });
    };
    fireCycle();
    this.sirenInterval = window.setInterval(fireCycle, 380);
  }

  stopCriticalSiren(): void {
    if (this.sirenInterval != null) {
      clearInterval(this.sirenInterval);
      this.sirenInterval = null;
    }
  }

  playEmergencyRingback(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Standard Indian/ITU dual-tone cadence (400 Hz + 425 Hz: 0.4s ON, 0.2s OFF, 0.4s ON)
    const bursts = [
      [0.0, 0.38],
      [0.58, 0.96],
      [2.5, 2.88],
      [3.08, 3.46],
    ];
    for (const [tStart, tEnd] of bursts) {
      for (const freq of [400, 425]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + tStart);
        gain.gain.setValueAtTime(0.0001, now + tStart);
        gain.gain.exponentialRampToValueAtTime(0.11, now + tStart + 0.02);
        gain.gain.setValueAtTime(0.11, now + tEnd - 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + tEnd);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + tStart);
        osc.stop(now + tEnd + 0.01);
      }
    }
  }
}

export class PreventiveInterventionEngine {
  private synth = new CabinAcousticSynthesizer();
  private cooldownMap = new Map<IncidentCategory, number>();
  private voiceCooldownMap = new Map<string, number>();

  private speedingSinceMs: number | null = null;
  private lockoutActive = false;
  private governorActive = false;
  private hazardStrobeActive = false;
  private alertnessRecoveryMs = 0;
  private unresponsiveSosMs = 0;
  private lastAutoSosAtMs = -60000;
  private autoSosSuppressedForCycle = false;
  private lastEvalMs = 0;
  private activeBannerUntilMs = 0;
  private lastActiveState: ActiveInterventionState = {
    stage: 0,
    headline: 'SYSTEM NOMINAL',
    subline: 'Monitoring ocular & kinematic channels.',
    category: null,
    governorActive: false,
    hazardStrobeActive: false,
    wakeFlashActive: false,
    lockoutRequiresCheck: false,
    alertnessHoldProgress: 0,
    sosCountdownSec: null,
    triggeredAtMs: null,
  };

  unlockAudio(): void {
    this.synth.unlock();
  }

  runSelfCheck(audioArmed: boolean, voiceArmed: boolean): void {
    this.synth.unlock();
    window.setTimeout(() => {
      if (audioArmed) {
        this.synth.playAdvisoryChime();
      }
      this.speakCallout(
        'SELF_CHECK',
        'Cabin audio and voice intervention check nominal.',
        voiceArmed,
        1500
      );
    }, 0);
  }

  forceManualReset(): void {
    this.lockoutActive = false;
    this.governorActive = false;
    this.hazardStrobeActive = false;
    this.alertnessRecoveryMs = 0;
    this.unresponsiveSosMs = 0;
    this.autoSosSuppressedForCycle = false;
    this.synth.stopCriticalSiren();
    this.lastActiveState = {
      stage: 0,
      headline: 'INTERVENTION CLEARED',
      subline: 'Operator reset acknowledged. Active monitoring resumed.',
      category: null,
      governorActive: false,
      hazardStrobeActive: false,
      wakeFlashActive: false,
      lockoutRequiresCheck: false,
      alertnessHoldProgress: 0,
      sosCountdownSec: null,
      triggeredAtMs: null,
    };
  }

  cancelAutoSosCountdown(): void {
    this.unresponsiveSosMs = 0;
    this.autoSosSuppressedForCycle = true;
  }

  announceEmergencyCall(phoneRaw: string, audioArmed: boolean, voiceArmed: boolean): void {
    this.synth.unlock();
    window.setTimeout(() => {
      if (audioArmed) {
        this.synth.playEmergencyRingback();
      }
      const digitsSpoken = phoneRaw.replace(/\D/g, '').slice(-10).split('').join(' ');
      this.speakCallout(
        'EMERGENCY_SOS',
        `Calling emergency number ${digitsSpoken || phoneRaw}. Transmitting GPS location and driver telemetry.`,
        voiceArmed,
        3000
      );
    }, 0);
  }

  private speakCallout(key: string, phrase: string, armed: boolean, cooldownMs = 8000): void {
    if (!armed || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const now = performance.now();
    const nextAllowed = this.voiceCooldownMap.get(key) ?? 0;
    if (now < nextAllowed) return;
    this.voiceCooldownMap.set(key, now + cooldownMs);

    // Defer Windows SAPI / SpeechSynthesis IPC off the synchronous click/RAF frame to prevent INP stalls
    window.setTimeout(() => {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(phrase);
        utter.rate = 1.08;
        utter.pitch = 0.96;
        utter.volume = 1.0;
        window.speechSynthesis.speak(utter);
      } catch {
        // Ignore browser speech engine errors
      }
    }, 0);
  }

  private canEmit(cat: IncidentCategory, nowMs: number, cooldownMs: number): boolean {
    const until = this.cooldownMap.get(cat) ?? 0;
    if (nowMs < until) return false;
    this.cooldownMap.set(cat, nowMs + cooldownMs);
    return true;
  }

  evaluate(
    ocular: OcularMetrics,
    kinematic: KinematicMetrics,
    thresholds: ThresholdsConfig
  ): {
    state: ActiveInterventionState;
    emittedIncidents: EmittedSafetyIncident[];
    autoDecelerateAssist: boolean;
    triggerAutoEmergencyCall: boolean;
  } {
    const now = performance.now();
    const dtMs = this.lastEvalMs > 0 ? Math.min(200, now - this.lastEvalMs) : 33;
    this.lastEvalMs = now;

    const emitted: EmittedSafetyIncident[] = [];
    let frameStage: AlertStage = 0;
    let headline = 'SYSTEM NOMINAL';
    let subline = 'All ocular biometrics and vehicle dynamics within envelope.';
    let activeCat: IncidentCategory | null = null;
    let wakeFlash = false;

    // --- 1. OCULAR BIOMETRIC CHECKS ---
    if (ocular.active && ocular.faceDetected && ocular.calibratingProgress == null) {
      if (ocular.eyeClosedMs >= thresholds.microsleepHoldMs) {
        frameStage = 3;
        wakeFlash = true;
        activeCat = 'MICROSLEEP';
        headline = 'CRITICAL MICROSLEEP INTERVENTION';
        subline = `Eyes closed ${(ocular.eyeClosedMs / 1000).toFixed(1)}s (EAR ${ocular.earMean.toFixed(2)}). Acoustic wake siren + speed governor engaged.`;
        this.lockoutActive = true;
        if (thresholds.governorArmed) this.governorActive = true;
        this.hazardStrobeActive = true;

        if (this.canEmit('MICROSLEEP', now, 5500)) {
          this.speakCallout(
            'MICROSLEEP',
            'Critical microsleep detected. Wake up. Speed limiter and hazard beacons engaged.',
            thresholds.voiceArmed,
            6000
          );
          emitted.push({
            category: 'MICROSLEEP',
            severity: 'CRITICAL',
            stage: 3,
            summary: `Microsleep closure ${(ocular.eyeClosedMs / 1000).toFixed(2)}s (EAR ${ocular.earMean.toFixed(3)}, PERCLOS ${ocular.perclos60.toFixed(1)}%)`,
            interventionAction: thresholds.governorArmed
              ? `WAKE_SIREN + PERIPHERAL_STROBE + GOVERNOR_CAP_${thresholds.governorCapKmh}KMH + HAZARD_BEACONS`
              : 'WAKE_SIREN + PERIPHERAL_STROBE + VOICE_WAKE_ORDER',
            metrics: {
              earMean: ocular.earMean,
              eyeClosedMs: ocular.eyeClosedMs,
              perclos60: ocular.perclos60,
              speedKmh: kinematic.speedKmh,
              fatigueIndex: ocular.fatigueIndex,
            },
            captureOpticalSnapshot: true,
          });
        }
      } else if (
        ocular.eyeClosedMs >= thresholds.drowsyHoldMs ||
        ocular.perclos60 >= thresholds.perclosCritPct
      ) {
        frameStage = Math.max(frameStage, 2) as AlertStage;
        activeCat = 'DROWSINESS_PERCLOS';
        headline = 'DROWSINESS DETECTED';
        subline = `PERCLOS ${ocular.perclos60.toFixed(1)}% · Closure ${ocular.eyeClosedMs}ms. Immediate rest stop advised.`;

        if (this.canEmit('DROWSINESS_PERCLOS', now, 7500)) {
          if (thresholds.audioArmed) this.synth.playWarningPulse(true);
          this.speakCallout(
            'DROWSY',
            'Drowsiness warning. High eyelid closure detected. Prepare to stop and rest.',
            thresholds.voiceArmed
          );
          emitted.push({
            category: 'DROWSINESS_PERCLOS',
            severity: 'WARNING',
            stage: 2,
            summary: `Elevated drowsiness biomarkers: PERCLOS ${ocular.perclos60.toFixed(1)}%, EAR ${ocular.earMean.toFixed(3)}`,
            interventionAction: 'URGENT_CHIME + VOICE_REST_DIRECTIVE',
            metrics: {
              earMean: ocular.earMean,
              perclos60: ocular.perclos60,
              eyeClosedMs: ocular.eyeClosedMs,
              fatigueIndex: ocular.fatigueIndex,
            },
            captureOpticalSnapshot: true,
          });
        }
      } else if (ocular.headNodHoldMs >= 1200) {
        frameStage = Math.max(frameStage, 2) as AlertStage;
        activeCat = 'HEAD_NOD';
        headline = 'POSTURAL HEAD DROOP';
        subline = `Sustained downward head pitch ${ocular.pitchDeg.toFixed(1)}° for ${(ocular.headNodHoldMs / 1000).toFixed(1)}s.`;

        if (this.canEmit('HEAD_NOD', now, 7000)) {
          if (thresholds.audioArmed) this.synth.playWarningPulse(true);
          this.speakCallout('HEAD_NOD', 'Posture alert. Head nodding detected.', thresholds.voiceArmed);
          emitted.push({
            category: 'HEAD_NOD',
            severity: 'WARNING',
            stage: 2,
            summary: `Fatigue head droop (${ocular.pitchDeg.toFixed(1)}° pitch held ${(ocular.headNodHoldMs / 1000).toFixed(1)}s)`,
            interventionAction: 'POSTURE_VOICE_ALERT + WARNING_PULSE',
            metrics: {
              pitchDeg: ocular.pitchDeg,
              headNodHoldMs: ocular.headNodHoldMs,
              fatigueIndex: ocular.fatigueIndex,
            },
            captureOpticalSnapshot: true,
          });
        }
      } else if (ocular.yawnActive) {
        frameStage = Math.max(frameStage, 1) as AlertStage;
        activeCat = 'FATIGUE_YAWN';
        headline = 'FATIGUE SIGN: YAWNING';
        subline = `Sustained mouth aperture MAR ${ocular.mar.toFixed(2)} (Session yawns: ${ocular.yawnCount}).`;

        if (this.canEmit('FATIGUE_YAWN', now, 8000)) {
          const escalates = ocular.yawnCount >= 3;
          if (thresholds.audioArmed) {
            if (escalates) this.synth.playWarningPulse(false);
            else this.synth.playAdvisoryChime();
          }
          if (escalates) {
            this.speakCallout(
              'YAWN',
              `Repeated yawning detected. Fatigue index ${ocular.fatigueIndex} percent. Schedule a rest break.`,
              thresholds.voiceArmed
            );
          }
          emitted.push({
            category: 'FATIGUE_YAWN',
            severity: escalates ? 'WARNING' : 'ADVISORY',
            stage: escalates ? 2 : 1,
            summary: `Yawn detected (MAR ${ocular.mar.toFixed(2)}, cumulative yawns: ${ocular.yawnCount})`,
            interventionAction: escalates ? 'FATIGUE_BREAK_VOICE_PROMPT' : 'ADVISORY_HARMONIC_CHIME',
            metrics: {
              mar: ocular.mar,
              yawnCount: ocular.yawnCount,
              fatigueIndex: ocular.fatigueIndex,
            },
            captureOpticalSnapshot: true,
          });
        }
      } else if (ocular.distractionHoldMs >= thresholds.distractionHoldMs) {
        frameStage = Math.max(frameStage, 2) as AlertStage;
        activeCat = 'VISUAL_DISTRACTION';
        headline = 'OFF-ROAD VISUAL DISTRACTION';
        subline = `Gaze / head off-axis (Yaw ${ocular.yawDeg.toFixed(0)}°, Pitch ${ocular.pitchDeg.toFixed(0)}°) for ${(ocular.distractionHoldMs / 1000).toFixed(1)}s.`;

        if (this.canEmit('VISUAL_DISTRACTION', now, 6000)) {
          if (thresholds.audioArmed) this.synth.playWarningPulse(false);
          this.speakCallout('DISTRACTION', 'Attention. Keep eyes on the road.', thresholds.voiceArmed, 6500);
          emitted.push({
            category: 'VISUAL_DISTRACTION',
            severity: 'WARNING',
            stage: 2,
            summary: `Off-road visual distraction held ${(ocular.distractionHoldMs / 1000).toFixed(1)}s (Yaw ${ocular.yawDeg.toFixed(1)}°, Pitch ${ocular.pitchDeg.toFixed(1)}°, GazeH ${ocular.gazeHorizontal.toFixed(2)})`,
            interventionAction: 'ATTENTION_CHIME + VOICE_EYES_ON_ROAD',
            metrics: {
              yawDeg: ocular.yawDeg,
              pitchDeg: ocular.pitchDeg,
              gazeHorizontal: ocular.gazeHorizontal,
              gazeVertical: ocular.gazeVertical,
              distractionHoldMs: ocular.distractionHoldMs,
              speedKmh: kinematic.speedKmh,
            },
            captureOpticalSnapshot: true,
          });
        }
      } else if (ocular.perclos60 >= thresholds.perclosWarnPct) {
        frameStage = Math.max(frameStage, 1) as AlertStage;
        headline = 'EARLY FATIGUE ADVISORY';
        subline = `Rolling 60s PERCLOS elevated at ${ocular.perclos60.toFixed(1)}%.`;
      }
    } else if (ocular.active && !ocular.faceDetected && ocular.faceMissingMs >= 2500 && kinematic.speedKmh > 8) {
      frameStage = Math.max(frameStage, 2) as AlertStage;
      activeCat = 'CAMERA_OCCLUSION';
      headline = 'OPTICAL SENSOR UNATTENDED / OCCLUDED';
      subline = `Driver face absent for ${(ocular.faceMissingMs / 1000).toFixed(1)}s while vehicle moving at ${kinematic.speedKmh.toFixed(0)} km/h.`;

      if (this.canEmit('CAMERA_OCCLUSION', now, 10000)) {
        if (thresholds.audioArmed) this.synth.playWarningPulse(false);
        emitted.push({
          category: 'CAMERA_OCCLUSION',
          severity: 'WARNING',
          stage: 2,
          summary: `Driver face lost / camera occluded while moving at ${kinematic.speedKmh.toFixed(1)} km/h`,
          interventionAction: 'OPTICAL_LOSS_WARNING',
          metrics: { faceMissingMs: ocular.faceMissingMs, speedKmh: kinematic.speedKmh },
          captureOpticalSnapshot: false,
        });
      }
    }

    // --- 2. KINEMATIC RISKY DRIVING PATTERN CHECKS ---
    if (kinematic.active) {
      // Harsh Braking
      if (kinematic.patternFlags.harshBraking) {
        const crit = kinematic.accelLongMs2 <= thresholds.harshBrakeMs2 * 1.45;
        frameStage = Math.max(frameStage, crit ? 3 : 2) as AlertStage;
        activeCat = activeCat ?? 'HARSH_BRAKING';
        if (frameStage >= 2 && headline === 'SYSTEM NOMINAL') {
          headline = crit ? 'SEVERE EMERGENCY BRAKING' : 'HARSH BRAKING DETECTED';
          subline = `Longitudinal deceleration ${kinematic.accelLongMs2.toFixed(2)} m/s² (${kinematic.longG.toFixed(2)}g) at ${kinematic.speedKmh.toFixed(0)} km/h.`;
        }
        if (crit) this.hazardStrobeActive = true;

        if (this.canEmit('HARSH_BRAKING', now, 3500)) {
          if (thresholds.audioArmed) this.synth.playWarningPulse(crit);
          this.speakCallout(
            'HARSH_BRAKE',
            crit
              ? 'Severe braking event. Hazard beacons triggered.'
              : 'Harsh braking detected. Increase following distance.',
            thresholds.voiceArmed,
            5500
          );
          emitted.push({
            category: 'HARSH_BRAKING',
            severity: crit ? 'CRITICAL' : 'WARNING',
            stage: crit ? 3 : 2,
            summary: `Harsh braking ${kinematic.accelLongMs2.toFixed(2)} m/s² (${kinematic.longG.toFixed(2)}g) at ${kinematic.speedKmh.toFixed(1)} km/h`,
            interventionAction: crit
              ? 'AUTO_HAZARD_BEACONS + VOICE_FOLLOWING_DISTANCE'
              : 'BRAKE_WARNING_PULSE + CABIN_CALLOUT',
            metrics: {
              speedKmh: kinematic.speedKmh,
              accelLongMs2: kinematic.accelLongMs2,
              longG: kinematic.longG,
              jerkMs3: kinematic.jerkMs3,
              source: kinematic.source,
            },
            captureOpticalSnapshot: ocular.active,
          });
        }
      }

      // Rapid Acceleration
      if (kinematic.patternFlags.rapidAccel) {
        const crit = kinematic.accelLongMs2 >= thresholds.rapidAccelMs2 * 1.45;
        frameStage = Math.max(frameStage, 2) as AlertStage;
        if (headline === 'SYSTEM NOMINAL') {
          headline = 'RAPID ACCELERATION SURGE';
          subline = `Longitudinal surge +${kinematic.accelLongMs2.toFixed(2)} m/s² (+${kinematic.longG.toFixed(2)}g).`;
        }

        if (this.canEmit('RAPID_ACCELERATION', now, 3500)) {
          if (thresholds.audioArmed) this.synth.playAdvisoryChime();
          this.speakCallout('RAPID_ACCEL', 'Aggressive acceleration logged. Smooth throttle input.', thresholds.voiceArmed, 6500);
          emitted.push({
            category: 'RAPID_ACCELERATION',
            severity: crit ? 'CRITICAL' : 'WARNING',
            stage: crit ? 3 : 2,
            summary: `Rapid acceleration +${kinematic.accelLongMs2.toFixed(2)} m/s² (+${kinematic.longG.toFixed(2)}g) at ${kinematic.speedKmh.toFixed(1)} km/h`,
            interventionAction: 'THROTTLE_MODERATION_ALERT',
            metrics: {
              speedKmh: kinematic.speedKmh,
              accelLongMs2: kinematic.accelLongMs2,
              longG: kinematic.longG,
              source: kinematic.source,
            },
            captureOpticalSnapshot: false,
          });
        }
      }

      // Speeding with hysteresis
      if (kinematic.patternFlags.speeding) {
        if (this.speedingSinceMs == null) this.speedingSinceMs = now;
        const heldMs = now - this.speedingSinceMs;
        const overKmh = kinematic.speedKmh - thresholds.speedLimitKmh;
        if (heldMs >= 1200 || overKmh >= 15) {
          const crit = overKmh >= 20;
          frameStage = Math.max(frameStage, crit ? 3 : 2) as AlertStage;
          if (headline === 'SYSTEM NOMINAL') {
            headline = crit ? 'CRITICAL OVERSPEED VIOLATION' : 'SPEED LIMIT EXCEEDED';
            subline = `${kinematic.speedKmh.toFixed(0)} km/h in ${thresholds.speedLimitKmh} km/h zone (+${overKmh.toFixed(0)} km/h).`;
          }
          if (crit && thresholds.governorArmed) {
            this.governorActive = true;
          }

          if (this.canEmit('SPEEDING', now, 6000)) {
            if (thresholds.audioArmed) this.synth.playWarningPulse(crit);
            this.speakCallout(
              'SPEEDING',
              `Overspeed warning. ${Math.round(kinematic.speedKmh)} kilometers per hour in a ${thresholds.speedLimitKmh} zone.`,
              thresholds.voiceArmed,
              7000
            );
            emitted.push({
              category: 'SPEEDING',
              severity: crit ? 'CRITICAL' : 'WARNING',
              stage: crit ? 3 : 2,
              summary: `Speeding ${kinematic.speedKmh.toFixed(1)} km/h in ${thresholds.speedLimitKmh} km/h zone (+${overKmh.toFixed(1)} km/h)`,
              interventionAction:
                crit && thresholds.governorArmed
                  ? 'SPEED_GOVERNOR_LIMITER + OVERSPEED_VOICE_WARNING'
                  : 'OVERSPEED_CHIME + HUD_LIMIT_ALERT',
              metrics: {
                speedKmh: kinematic.speedKmh,
                speedLimitKmh: thresholds.speedLimitKmh,
                overspeedKmh: Number(overKmh.toFixed(1)),
                source: kinematic.source,
              },
              captureOpticalSnapshot: false,
            });
          }
        }
      } else {
        this.speedingSinceMs = null;
      }

      // Rash Driving (High Lateral G / Lane Weave / High Jerk)
      if (kinematic.patternFlags.rashDriving) {
        const crit = kinematic.totalG >= 0.52 || kinematic.weaveReversals >= 3;
        frameStage = Math.max(frameStage, crit ? 3 : 2) as AlertStage;
        if (headline === 'SYSTEM NOMINAL') {
          headline = 'RASH DRIVING MANEUVER';
          subline = `Lateral ${kinematic.latG.toFixed(2)}g · Yaw ${kinematic.yawRateDegS.toFixed(0)}°/s · Weave flips: ${kinematic.weaveReversals}.`;
        }
        if (crit && thresholds.governorArmed) {
          this.governorActive = true;
          this.hazardStrobeActive = true;
        }

        if (this.canEmit('RASH_DRIVING', now, 4500)) {
          if (thresholds.audioArmed) this.synth.playWarningPulse(true);
          this.speakCallout(
            'RASH',
            'Rash driving pattern detected. Stabilize steering and reduce speed.',
            thresholds.voiceArmed,
            6000
          );
          emitted.push({
            category: 'RASH_DRIVING',
            severity: crit ? 'CRITICAL' : 'WARNING',
            stage: crit ? 3 : 2,
            summary: `Rash driving: Lat ${kinematic.latG.toFixed(2)}g, Yaw ${kinematic.yawRateDegS.toFixed(1)}°/s, Jerk ${kinematic.jerkMs3.toFixed(1)} m/s³, Weave reversals ${kinematic.weaveReversals}`,
            interventionAction: crit
              ? 'STABILITY_SPEED_CAP + HAZARD_BEACONS + VOICE_DIRECTIVE'
              : 'LATERAL_STABILITY_ALERT + CABIN_CALLOUT',
            metrics: {
              speedKmh: kinematic.speedKmh,
              latG: kinematic.latG,
              longG: kinematic.longG,
              totalG: kinematic.totalG,
              yawRateDegS: kinematic.yawRateDegS,
              jerkMs3: kinematic.jerkMs3,
              weaveReversals: kinematic.weaveReversals,
              source: kinematic.source,
            },
            captureOpticalSnapshot: ocular.active,
          });
        }
      }
    }

    // --- 3. SIREN & ALERTNESS VERIFICATION LOCKOUT MANAGEMENT ---
    const isActivelyMicrosleeping =
      ocular.active && ocular.faceDetected && ocular.eyeClosedMs >= thresholds.microsleepHoldMs;

    if (isActivelyMicrosleeping && thresholds.audioArmed) {
      this.synth.startCriticalSiren();
    } else {
      this.synth.stopCriticalSiren();
    }

    // If in Stage-3 Fatigue Lockout, require 2.5s of steady open-eye forward gaze to auto-clear governor
    let alertnessHoldProgress = 0;
    if (this.lockoutActive) {
      const attentiveEyesOpen =
        ocular.active &&
        ocular.faceDetected &&
        ocular.eyeClosedMs === 0 &&
        ocular.distractionHoldMs === 0 &&
        ocular.headNodHoldMs === 0;

      if (attentiveEyesOpen) {
        this.alertnessRecoveryMs += dtMs;
        alertnessHoldProgress = Math.min(1, this.alertnessRecoveryMs / 2500);
        if (this.alertnessRecoveryMs >= 2500) {
          this.lockoutActive = false;
          this.governorActive = false;
          this.hazardStrobeActive = false;
          this.alertnessRecoveryMs = 0;
        }
      } else {
        this.alertnessRecoveryMs = Math.max(0, this.alertnessRecoveryMs - dtMs * 0.5);
        alertnessHoldProgress = Math.min(1, this.alertnessRecoveryMs / 2500);
      }
    } else if (frameStage === 0 && kinematic.speedKmh <= thresholds.speedLimitKmh) {
      this.governorActive = false;
      this.hazardStrobeActive = false;
    }

    // --- 4. UNRESPONSIVE DRIVER AUTO-SOS COUNTDOWN (5s unrecovered Stage-3 Microsleep) ---
    let sosCountdownSec: number | null = null;
    let triggerAutoEmergencyCall = false;
    const hasPhone = Boolean((thresholds.emergencyPhone || '').trim());
    const unrecoveredInMicrosleepLockout =
      this.lockoutActive &&
      ocular.active &&
      !(
        ocular.faceDetected &&
        ocular.eyeClosedMs === 0 &&
        ocular.distractionHoldMs === 0 &&
        ocular.headNodHoldMs === 0
      );

    if (
      (isActivelyMicrosleeping || unrecoveredInMicrosleepLockout) &&
      thresholds.emergencyAutoCall &&
      hasPhone &&
      !this.autoSosSuppressedForCycle &&
      now - this.lastAutoSosAtMs > 35000
    ) {
      this.unresponsiveSosMs += dtMs;
      const SOS_DELAY_MS = 5000;
      if (this.unresponsiveSosMs >= SOS_DELAY_MS) {
        triggerAutoEmergencyCall = true;
        this.lastAutoSosAtMs = now;
        this.unresponsiveSosMs = 0;
        this.autoSosSuppressedForCycle = true;
        sosCountdownSec = null;
      } else {
        sosCountdownSec = Math.max(1, Math.ceil((SOS_DELAY_MS - this.unresponsiveSosMs) / 1000));
      }
    } else {
      this.unresponsiveSosMs = Math.max(0, this.unresponsiveSosMs - dtMs * 2);
      if (!this.lockoutActive) {
        this.autoSosSuppressedForCycle = false;
        this.unresponsiveSosMs = 0;
      }
    }

    // Hold alert banner readable for 2.2s so transient impulses don't flicker unreadably
    if (frameStage >= 1) {
      this.activeBannerUntilMs = now + 2200;
      this.lastActiveState = {
        stage: frameStage,
        headline,
        subline,
        category: activeCat,
        governorActive: this.governorActive,
        hazardStrobeActive: this.hazardStrobeActive,
        wakeFlashActive: wakeFlash,
        lockoutRequiresCheck: this.lockoutActive,
        alertnessHoldProgress: Number(alertnessHoldProgress.toFixed(2)),
        sosCountdownSec,
        triggeredAtMs: now,
      };
    } else if (this.lockoutActive) {
      this.lastActiveState = {
        stage: 2,
        headline: 'GOVERNOR ENGAGED — VERIFY OCULAR ALERTNESS',
        subline: 'Hold steady forward gaze for 2.5s (or click Manual Reset) to restore full throttle authority.',
        category: 'MICROSLEEP',
        governorActive: this.governorActive,
        hazardStrobeActive: this.hazardStrobeActive,
        wakeFlashActive: false,
        lockoutRequiresCheck: true,
        alertnessHoldProgress: Number(alertnessHoldProgress.toFixed(2)),
        sosCountdownSec,
        triggeredAtMs: this.lastActiveState.triggeredAtMs,
      };
    } else if (now >= this.activeBannerUntilMs) {
      this.lastActiveState = {
        stage: 0,
        headline: 'SYSTEM NOMINAL',
        subline: 'Monitoring ocular biometrics & vehicle kinematics.',
        category: null,
        governorActive: this.governorActive,
        hazardStrobeActive: this.hazardStrobeActive,
        wakeFlashActive: false,
        lockoutRequiresCheck: false,
        alertnessHoldProgress: 0,
        sosCountdownSec: null,
        triggeredAtMs: null,
      };
    } else {
      this.lastActiveState = {
        ...this.lastActiveState,
        wakeFlashActive: false,
        governorActive: this.governorActive,
        hazardStrobeActive: this.hazardStrobeActive,
        sosCountdownSec,
      };
    }

    const autoDecelerateAssist =
      isActivelyMicrosleeping && ocular.eyeClosedMs >= thresholds.microsleepHoldMs + 1200;

    return {
      state: this.lastActiveState,
      emittedIncidents: emitted,
      autoDecelerateAssist,
      triggerAutoEmergencyCall,
    };
  }
}
