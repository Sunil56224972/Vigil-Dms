import type {
  KinematicMetrics,
  KinematicSourceMode,
  ThresholdsConfig,
} from '../types/telemetry';

const G_TO_MS2 = 9.80665;

export interface ReplaySample {
  tSec: number;
  speedKmh: number;
  accelLongMs2: number;
  accelLatMs2: number;
  yawRateDegS: number;
  jerkMs3: number;
}

export interface ManualRigControls {
  throttle: boolean;
  boost: boolean;
  brake: boolean;
  emergencyBrake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
}

export class KinematicTelemetryEngine {
  private mode: KinematicSourceMode = 'DISCONNECTED';
  private nodeLabel = 'Standby';

  // Dedicated independent clocks so 60Hz tick() never corrupts IMU/WebSocket packet dt
  private lastSimTickMs = 0;
  private lastImuSampleMs = 0;
  private lastExternalPacketMs = 0;

  // Filtered kinematic state
  private speedKmh = 0;
  private accelLongMs2 = 0;
  private accelLatMs2 = 0;
  private yawRateDegS = 0;
  private jerkMs3 = 0;
  private distanceKm = 0;
  private rpm: number | null = null;
  private throttlePct: number | null = null;
  private brakePct: number | null = null;
  private gpsAccuracyM: number | null = null;
  private lat: number | null = null;
  private lon: number | null = null;

  // Lane-weaving yaw reversal window
  private yawReversalTimesMs: number[] = [];
  private lastYawSign = 0;

  // Local IMU + GPS listeners
  private gravityTare = { x: 0, y: 0, z: 0, captured: false };
  private latestRawGravity = { x: 0, y: 0, z: 0 };
  private geoWatchId: number | null = null;
  private boundMotionHandler: ((e: DeviceMotionEvent) => void) | null = null;

  // File replay state
  private replaySamples: ReplaySample[] = [];
  private replayCursor = 0;
  private replayElapsedSec = 0;
  private replaySpeedFactor = 1;
  private replayPaused = false;

  // Manual dynamics rig state
  private steerAngleRad = 0;
  private controls: ManualRigControls = {
    throttle: false,
    boost: false,
    brake: false,
    emergencyBrake: false,
    steerLeft: false,
    steerRight: false,
  };

  getMode(): KinematicSourceMode {
    return this.mode;
  }

  disconnect(): void {
    this.stopLocalHardwareListeners();
    this.mode = 'DISCONNECTED';
    this.nodeLabel = 'Standby';
    this.lastSimTickMs = 0;
    this.lastImuSampleMs = 0;
    this.lastExternalPacketMs = 0;
    this.speedKmh = 0;
    this.accelLongMs2 = 0;
    this.accelLatMs2 = 0;
    this.yawRateDegS = 0;
    this.jerkMs3 = 0;
    this.rpm = null;
    this.throttlePct = null;
    this.brakePct = null;
    this.gpsAccuracyM = null;
    this.yawReversalTimesMs = [];
    this.lastYawSign = 0;
    this.replaySamples = [];
  }

  resetDistance(): void {
    this.distanceKm = 0;
  }

  tareLocalGravity(): void {
    this.gravityTare = {
      x: this.latestRawGravity.x,
      y: this.latestRawGravity.y,
      z: this.latestRawGravity.z,
      captured: true,
    };
    this.accelLongMs2 = 0;
    this.accelLatMs2 = 0;
    this.jerkMs3 = 0;
  }

  async startLocalHardwareSensors(): Promise<{ ok: boolean; error?: string }> {
    this.disconnect();

    const dmAny = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof dmAny?.requestPermission === 'function') {
      const state = await dmAny.requestPermission();
      if (state !== 'granted') {
        return { ok: false, error: 'Motion sensor permission was denied by browser.' };
      }
    }

    this.mode = 'LOCAL_DEVICE_IMU';
    this.nodeLabel = 'Local IMU + GPS';
    this.lastImuSampleMs = 0;

    this.boundMotionHandler = (ev: DeviceMotionEvent) => {
      const now = performance.now();
      const isFirstSample = this.lastImuSampleMs === 0;
      const dt = isFirstSample
        ? 0.05
        : Math.max(0.016, Math.min(0.25, (now - this.lastImuSampleMs) / 1000));
      this.lastImuSampleMs = now;

      let ax = ev.acceleration?.x ?? null;
      let ay = ev.acceleration?.y ?? null;

      if (ev.accelerationIncludingGravity) {
        const gx = ev.accelerationIncludingGravity.x ?? 0;
        const gy = ev.accelerationIncludingGravity.y ?? 0;
        const gz = ev.accelerationIncludingGravity.z ?? 0;
        this.latestRawGravity = { x: gx, y: gy, z: gz };
        if (!this.gravityTare.captured) {
          this.gravityTare = { x: gx, y: gy, z: gz, captured: true };
        }
        if (ax == null || ay == null) {
          ax = gx - this.gravityTare.x;
          ay = gy - this.gravityTare.y;
        }
      }

      const rawLat = ax ?? 0;
      const rawLong = ay ?? 0;

      const prevLong = this.accelLongMs2;
      const prevLat = this.accelLatMs2;

      this.accelLongMs2 = isFirstSample ? rawLong : this.accelLongMs2 * 0.62 + rawLong * 0.38;
      this.accelLatMs2 = isFirstSample ? rawLat : this.accelLatMs2 * 0.62 + rawLat * 0.38;
      this.jerkMs3 = isFirstSample
        ? 0
        : Math.min(45, Math.hypot(this.accelLongMs2 - prevLong, this.accelLatMs2 - prevLat) / dt);

      const rotZ = ev.rotationRate?.alpha ?? ev.rotationRate?.gamma ?? 0;
      this.yawRateDegS = isFirstSample ? rotZ : this.yawRateDegS * 0.6 + rotZ * 0.4;
      this.recordYawReversal(now);

      if (this.gpsAccuracyM == null && Math.abs(this.accelLongMs2) > 0.38) {
        this.speedKmh = Math.max(0, this.speedKmh + this.accelLongMs2 * dt * 3.6);
      }
      this.distanceKm += (this.speedKmh / 3600) * dt;
    };

    window.addEventListener('devicemotion', this.boundMotionHandler);

    if ('geolocation' in navigator) {
      this.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.lat = pos.coords.latitude;
          this.lon = pos.coords.longitude;
          this.gpsAccuracyM = pos.coords.accuracy;
          if (pos.coords.speed != null && Number.isFinite(pos.coords.speed)) {
            this.speedKmh = Math.max(0, pos.coords.speed * 3.6);
          }
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 500, timeout: 6000 }
      );
    }

    return { ok: true };
  }

  private stopLocalHardwareListeners(): void {
    if (this.boundMotionHandler) {
      window.removeEventListener('devicemotion', this.boundMotionHandler);
      this.boundMotionHandler = null;
    }
    if (this.geoWatchId != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }
  }

  enableRemoteMobileMode(label = 'Paired phone IMU'): void {
    this.stopLocalHardwareListeners();
    this.mode = 'REMOTE_MOBILE_SENSOR';
    this.nodeLabel = label;
    this.lastExternalPacketMs = 0;
  }

  enableExternalBusMode(label = 'HTTP telemetry bus'): void {
    this.stopLocalHardwareListeners();
    this.mode = 'EXTERNAL_BUS';
    this.nodeLabel = label;
    this.lastExternalPacketMs = 0;
  }

  ingestExternalFrame(frame: Record<string, unknown>): void {
    if (
      this.mode !== 'REMOTE_MOBILE_SENSOR' &&
      this.mode !== 'EXTERNAL_BUS' &&
      this.mode !== 'DISCONNECTED'
    ) {
      return;
    }
    if (this.mode === 'DISCONNECTED') {
      this.mode = frame.source === 'MOBILE_SENSOR_NODE' ? 'REMOTE_MOBILE_SENSOR' : 'EXTERNAL_BUS';
    }

    const now = performance.now();
    const gapSec = this.lastExternalPacketMs > 0 ? (now - this.lastExternalPacketMs) / 1000 : null;
    this.lastExternalPacketMs = now;

    if (typeof frame.nodeId === 'string') {
      this.nodeLabel = frame.nodeId;
    }

    const nextLong = Number(frame.accelLongMs2 ?? 0);
    const nextLat = Number(frame.accelLatMs2 ?? 0);
    const prevLong = this.accelLongMs2;
    const prevLat = this.accelLatMs2;

    // Treat first packet (or packet after >1s pause) as fresh state without finite-difference spike
    if (gapSec == null || gapSec > 1.0) {
      this.accelLongMs2 = nextLong;
      this.accelLatMs2 = nextLat;
      this.jerkMs3 = 0;
    } else {
      const dt = Math.max(0.03, Math.min(0.5, gapSec));
      this.accelLongMs2 = this.accelLongMs2 * 0.45 + nextLong * 0.55;
      this.accelLatMs2 = this.accelLatMs2 * 0.45 + nextLat * 0.55;
      this.jerkMs3 = Math.min(45, Math.hypot(this.accelLongMs2 - prevLong, this.accelLatMs2 - prevLat) / dt);
    }

    const dtDist = gapSec != null && gapSec <= 1.0 ? Math.max(0.02, gapSec) : 0.05;
    this.yawRateDegS = this.yawRateDegS * 0.5 + Number(frame.yawRateDegS ?? 0) * 0.5;
    this.recordYawReversal(now);

    if (frame.speedKmh != null && Number.isFinite(Number(frame.speedKmh))) {
      this.speedKmh = Math.max(0, Number(frame.speedKmh));
    } else if (Math.abs(this.accelLongMs2) > 0.38) {
      this.speedKmh = Math.max(0, this.speedKmh + this.accelLongMs2 * dtDist * 3.6);
    }

    this.rpm = frame.rpm != null ? Number(frame.rpm) : this.rpm;
    this.throttlePct = frame.throttlePct != null ? Number(frame.throttlePct) : this.throttlePct;
    this.brakePct = frame.brakePct != null ? Number(frame.brakePct) : this.brakePct;
    this.gpsAccuracyM = frame.gpsAccuracyM != null ? Number(frame.gpsAccuracyM) : this.gpsAccuracyM;
    this.lat = frame.lat != null ? Number(frame.lat) : this.lat;
    this.lon = frame.lon != null ? Number(frame.lon) : this.lon;

    this.distanceKm += (this.speedKmh / 3600) * dtDist;
  }

  startFileReplay(samples: ReplaySample[], label = 'Log replay'): void {
    this.stopLocalHardwareListeners();
    this.mode = 'FILE_REPLAY';
    this.nodeLabel = label;
    this.replaySamples = samples;
    this.replayCursor = 0;
    this.replayElapsedSec = samples[0]?.tSec ?? 0;
    this.replayPaused = false;
    this.lastSimTickMs = performance.now();
  }

  setReplayControls(opts: { paused?: boolean; speedFactor?: number; seekIndex?: number }): void {
    if (opts.paused != null) this.replayPaused = opts.paused;
    if (opts.speedFactor != null) this.replaySpeedFactor = opts.speedFactor;
    if (opts.seekIndex != null && this.replaySamples[opts.seekIndex]) {
      this.replayCursor = opts.seekIndex;
      this.replayElapsedSec = this.replaySamples[opts.seekIndex].tSec;
    }
  }

  getReplayProgress(): { index: number; total: number; paused: boolean; speedFactor: number } {
    return {
      index: this.replayCursor,
      total: this.replaySamples.length,
      paused: this.replayPaused,
      speedFactor: this.replaySpeedFactor,
    };
  }

  enableManualDynamicsRig(): void {
    this.stopLocalHardwareListeners();
    this.mode = 'MANUAL_DYNAMICS_RIG';
    this.nodeLabel = 'Dynamics rig';
    this.speedKmh = 0;
    this.accelLongMs2 = 0;
    this.accelLatMs2 = 0;
    this.yawRateDegS = 0;
    this.jerkMs3 = 0;
    this.steerAngleRad = 0;
    this.rpm = 820;
    this.throttlePct = 0;
    this.brakePct = 0;
    this.lastSimTickMs = performance.now();
  }

  setManualControls(partial: Partial<ManualRigControls>): void {
    this.controls = { ...this.controls, ...partial };
  }

  private recordYawReversal(nowMs: number): void {
    if (Math.abs(this.yawRateDegS) >= 18 && this.speedKmh >= 18) {
      const sign = Math.sign(this.yawRateDegS);
      if (this.lastYawSign !== 0 && sign !== this.lastYawSign) {
        this.yawReversalTimesMs.push(nowMs);
      }
      this.lastYawSign = sign;
    }
    while (this.yawReversalTimesMs.length > 0 && nowMs - this.yawReversalTimesMs[0] > 8000) {
      this.yawReversalTimesMs.shift();
    }
  }

  tick(
    thresholds: ThresholdsConfig,
    governorEngaged: boolean,
    hazardBeaconsOn: boolean,
    autoDecelerateAssist: boolean
  ): KinematicMetrics {
    const now = performance.now();
    const dt =
      this.lastSimTickMs > 0
        ? Math.min(0.1, Math.max(0.008, (now - this.lastSimTickMs) / 1000))
        : 0.016;
    this.lastSimTickMs = now;

    if (this.mode === 'FILE_REPLAY' && this.replaySamples.length > 0) {
      if (!this.replayPaused) {
        this.replayElapsedSec += dt * this.replaySpeedFactor;
        while (
          this.replayCursor < this.replaySamples.length - 1 &&
          this.replaySamples[this.replayCursor + 1].tSec <= this.replayElapsedSec
        ) {
          this.replayCursor += 1;
        }
        if (this.replayCursor >= this.replaySamples.length - 1) {
          this.replayPaused = true;
        }
      }
      const cur = this.replaySamples[this.replayCursor];
      if (cur) {
        this.speedKmh = cur.speedKmh;
        this.accelLongMs2 = this.replayPaused ? 0 : cur.accelLongMs2;
        this.accelLatMs2 = this.replayPaused ? 0 : cur.accelLatMs2;
        this.yawRateDegS = this.replayPaused ? 0 : cur.yawRateDegS;
        this.jerkMs3 = this.replayPaused ? 0 : cur.jerkMs3;
        this.recordYawReversal(now);
        if (!this.replayPaused) {
          this.distanceKm += (this.speedKmh / 3600) * dt * this.replaySpeedFactor;
        }
      }
    } else if (this.mode === 'MANUAL_DYNAMICS_RIG') {
      const wheelbaseM = 2.72;
      const prevLong = this.accelLongMs2;
      const prevLat = this.accelLatMs2;
      const vMs = this.speedKmh / 3.6;

      const aeroDragMs2 = 0.00042 * vMs * vMs + (vMs > 0.1 ? 0.14 : 0);

      let targetLongMs2 = -aeroDragMs2;
      let throttlePct = 0;
      let brakePct = 0;

      if (autoDecelerateAssist) {
        brakePct = 38;
        targetLongMs2 = vMs > 0.2 ? -2.4 : 0;
      } else if (this.controls.emergencyBrake) {
        brakePct = 100;
        targetLongMs2 = vMs > 0.2 ? -6.8 : 0;
      } else if (this.controls.brake) {
        brakePct = 68;
        targetLongMs2 = vMs > 0.2 ? -4.4 : 0;
      } else if (this.controls.throttle) {
        if (governorEngaged && this.speedKmh >= thresholds.governorCapKmh) {
          throttlePct = 12;
          targetLongMs2 = -0.8;
        } else {
          throttlePct = this.controls.boost ? 100 : 62;
          targetLongMs2 = (this.controls.boost ? 4.8 : 2.35) - aeroDragMs2;
        }
      } else if (governorEngaged && this.speedKmh > thresholds.governorCapKmh + 2) {
        targetLongMs2 = -1.6;
      }

      const tau = 1 - Math.exp(-dt * 11);
      this.accelLongMs2 = prevLong + (targetLongMs2 - prevLong) * tau;

      const nextVMs = Math.max(0, vMs + this.accelLongMs2 * dt);
      this.speedKmh = nextVMs * 3.6;

      const maxSteerRad = 0.42 / (1 + nextVMs * 0.055);
      let steerTarget = 0;
      if (this.controls.steerLeft) steerTarget = -maxSteerRad;
      if (this.controls.steerRight) steerTarget = maxSteerRad;
      this.steerAngleRad += (steerTarget - this.steerAngleRad) * Math.min(1, dt * 8.5);

      const yawRateRadS = (nextVMs / wheelbaseM) * Math.tan(this.steerAngleRad);
      this.yawRateDegS = yawRateRadS * (180 / Math.PI);
      this.accelLatMs2 = nextVMs * yawRateRadS;
      this.jerkMs3 = Math.min(45, Math.hypot(this.accelLongMs2 - prevLong, this.accelLatMs2 - prevLat) / dt);

      this.recordYawReversal(now);
      this.distanceKm += (this.speedKmh / 3600) * dt;
      this.throttlePct = throttlePct;
      this.brakePct = brakePct;
      this.rpm = Math.round(820 + (this.speedKmh % 34) * 95 + throttlePct * 24);
    } else if (
      this.mode === 'REMOTE_MOBILE_SENSOR' ||
      this.mode === 'EXTERNAL_BUS' ||
      this.mode === 'LOCAL_DEVICE_IMU'
    ) {
      const lastPkt =
        this.mode === 'LOCAL_DEVICE_IMU' ? this.lastImuSampleMs : this.lastExternalPacketMs;
      const staleMs = lastPkt > 0 ? now - lastPkt : 9999;

      // Decay transient acceleration & jerk smoothly if packet stream pauses > 320ms
      if (staleMs > 320) {
        const decay = Math.exp(-dt * 7.5);
        this.accelLongMs2 = Math.abs(this.accelLongMs2 * decay) < 0.02 ? 0 : this.accelLongMs2 * decay;
        this.accelLatMs2 = Math.abs(this.accelLatMs2 * decay) < 0.02 ? 0 : this.accelLatMs2 * decay;
        this.yawRateDegS = Math.abs(this.yawRateDegS * decay) < 0.1 ? 0 : this.yawRateDegS * decay;
        this.jerkMs3 = Math.abs(this.jerkMs3 * decay) < 0.1 ? 0 : this.jerkMs3 * decay;
      }
      if (staleMs > 3000 && this.speedKmh > 0) {
        const spdDecay = Math.exp(-dt * 2.5);
        this.speedKmh = this.speedKmh * spdDecay < 0.2 ? 0 : this.speedKmh * spdDecay;
      }
      this.recordYawReversal(now);
    }

    const longG = this.accelLongMs2 / G_TO_MS2;
    const latG = this.accelLatMs2 / G_TO_MS2;
    const totalG = Math.hypot(longG, latG);

    const harshBraking = this.accelLongMs2 <= thresholds.harshBrakeMs2;
    const rapidAccel = this.accelLongMs2 >= thresholds.rapidAccelMs2;
    const speeding = this.speedKmh > thresholds.speedLimitKmh + 2.0;
    const rashDriving =
      Math.abs(this.accelLatMs2) >= thresholds.rashLatMs2 ||
      this.yawReversalTimesMs.length >= 3 ||
      (this.jerkMs3 >= thresholds.rashJerkMs3 && Math.abs(this.accelLatMs2) >= 1.2) ||
      (Math.abs(this.accelLongMs2) >= 2.4 &&
        Math.abs(this.accelLatMs2) >= 2.4 &&
        Math.hypot(this.accelLongMs2, this.accelLatMs2) >= 4.7);

    return {
      source: this.mode,
      active: this.mode !== 'DISCONNECTED',
      nodeLabel: this.nodeLabel,
      speedKmh: Number(this.speedKmh.toFixed(1)),
      speedLimitKmh: thresholds.speedLimitKmh,
      accelLongMs2: Number(this.accelLongMs2.toFixed(2)),
      accelLatMs2: Number(this.accelLatMs2.toFixed(2)),
      longG: Number(longG.toFixed(2)),
      latG: Number(latG.toFixed(2)),
      totalG: Number(totalG.toFixed(2)),
      yawRateDegS: Number(this.yawRateDegS.toFixed(1)),
      jerkMs3: Number(this.jerkMs3.toFixed(1)),
      distanceKm: Number(this.distanceKm.toFixed(3)),
      weaveReversals: this.yawReversalTimesMs.length,
      rpm: this.rpm,
      throttlePct: this.throttlePct,
      brakePct: this.brakePct,
      gpsAccuracyM: this.gpsAccuracyM,
      lat: this.lat,
      lon: this.lon,
      governorEngaged,
      hazardBeaconsOn,
      patternFlags: {
        harshBraking,
        rapidAccel,
        speeding,
        rashDriving,
      },
    };
  }
}
