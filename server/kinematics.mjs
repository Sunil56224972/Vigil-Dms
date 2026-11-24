const G_TO_MS2 = 9.80665;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD);
  const x =
    Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
    Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos((lon2 - lon1) * DEG_TO_RAD);
  return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
}

function shortestAngleDiffDeg(a, b) {
  let diff = ((b - a + 540) % 360) - 180;
  if (diff === -180) diff = 180;
  return diff;
}

function findColumnKey(headers, patterns) {
  const normalized = headers.map((h) => ({
    raw: h,
    clean: h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
  }));
  for (const pat of patterns) {
    const exact = normalized.find((item) => item.clean === pat);
    if (exact) return exact.raw;
  }
  for (const pat of patterns) {
    const partial = normalized.find((item) => item.clean.includes(pat));
    if (partial) return partial.raw;
  }
  return null;
}

function parseCsvRows(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length < 2) {
    throw new Error('Telemetry file must contain a header row and at least one data sample.');
  }

  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    if (vals.length === 0 || vals.every((v) => v === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = vals[c] ?? '';
    }
    rows.push(obj);
  }
  return { headers, rows };
}

function parseNumeric(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseTimeSeconds(rawVal, index, firstEpochRef) {
  if (rawVal == null || rawVal === '') return index * 0.1;
  const num = Number(rawVal);
  if (Number.isFinite(num)) {
    if (num > 1e11) {
      if (firstEpochRef.val == null) firstEpochRef.val = num;
      return (num - firstEpochRef.val) / 1000;
    }
    if (num > 1e9) {
      if (firstEpochRef.val == null) firstEpochRef.val = num;
      return num - firstEpochRef.val;
    }
    if (firstEpochRef.val == null) firstEpochRef.val = num;
    return num - firstEpochRef.val;
  }
  const parsedMs = Date.parse(String(rawVal));
  if (Number.isFinite(parsedMs)) {
    if (firstEpochRef.val == null) firstEpochRef.val = parsedMs;
    return (parsedMs - firstEpochRef.val) / 1000;
  }
  return index * 0.1;
}

export function parseTelemetryPayload(rawContent, formatHint = 'auto') {
  const trimmed = rawContent.trim();
  let rows = [];
  let headers = [];

  if (formatHint === 'json' || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.samples) ? parsed.samples : [parsed];
    if (rows.length === 0) {
      throw new Error('JSON telemetry array is empty.');
    }
    headers = Object.keys(rows[0]);
  } else {
    const csv = parseCsvRows(trimmed);
    headers = csv.headers;
    rows = csv.rows;
  }

  const colTime = findColumnKey(headers, ['time_s', 'timestamp', 'time_ms', 'elapsed', 'time', 't']);
  const colSpeedKmh = findColumnKey(headers, ['speed_kmh', 'vehicle_speed', 'obd_speed', 'velocity_kmh', 'kmh', 'kph']);
  const colSpeedMs = !colSpeedKmh ? findColumnKey(headers, ['speed_ms', 'velocity_ms', 'speed_m_s', 'speed']) : null;
  const colSpeedMph = !colSpeedKmh && !colSpeedMs ? findColumnKey(headers, ['speed_mph', 'mph']) : null;

  const colLongMs2 = findColumnKey(headers, [
    'accel_long_ms2',
    'longitudinal_accel',
    'lon_accel',
    'linear_acceleration_y',
    'accel_x',
    'ax_ms2',
    'ax',
  ]);
  const colLatMs2 = findColumnKey(headers, [
    'accel_lat_ms2',
    'lateral_accel',
    'lat_accel',
    'linear_acceleration_x',
    'accel_y',
    'ay_ms2',
    'ay',
  ]);
  const colLongG = !colLongMs2 ? findColumnKey(headers, ['long_g', 'gx', 'g_long']) : null;
  const colLatG = !colLatMs2 ? findColumnKey(headers, ['lat_g', 'gy', 'g_lat']) : null;

  const colYaw = findColumnKey(headers, ['yaw_rate_degs', 'yaw_rate', 'gyro_z', 'gz', 'wz', 'angular_velocity_z']);
  const colLat = findColumnKey(headers, ['latitude', 'lat', 'gps_lat']);
  const colLon = findColumnKey(headers, ['longitude', 'lon', 'lng', 'gps_lon']);
  const colRpm = findColumnKey(headers, ['rpm', 'engine_rpm']);
  const colThrottle = findColumnKey(headers, ['throttle_pct', 'throttle', 'pedal_pos']);
  const colBrake = findColumnKey(headers, ['brake_pct', 'brake']);

  const epochRef = { val: null };
  const samples = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tSec = parseTimeSeconds(colTime ? r[colTime] : null, i, epochRef);

    let speedKmh = colSpeedKmh ? parseNumeric(r[colSpeedKmh]) : null;
    if (speedKmh == null && colSpeedMs) {
      const v = parseNumeric(r[colSpeedMs]);
      if (v != null) {
        // Heuristic: standard mobile GPS exports speed in m/s unless header explicitly says kmh
        speedKmh = colSpeedMs.toLowerCase().includes('ms') || colSpeedMs.toLowerCase().includes('m_s') ? v * 3.6 : v;
      }
    }
    if (speedKmh == null && colSpeedMph) {
      const v = parseNumeric(r[colSpeedMph]);
      if (v != null) speedKmh = v * 1.60934;
    }

    let accelLongMs2 = colLongMs2 ? parseNumeric(r[colLongMs2]) : null;
    if (accelLongMs2 == null && colLongG) {
      const g = parseNumeric(r[colLongG]);
      if (g != null) accelLongMs2 = g * G_TO_MS2;
    }

    let accelLatMs2 = colLatMs2 ? parseNumeric(r[colLatMs2]) : null;
    if (accelLatMs2 == null && colLatG) {
      const g = parseNumeric(r[colLatG]);
      if (g != null) accelLatMs2 = g * G_TO_MS2;
    }

    let yawRateDegS = colYaw ? parseNumeric(r[colYaw]) : null;
    if (yawRateDegS != null && colYaw && colYaw.toLowerCase().includes('rad')) {
      yawRateDegS = yawRateDegS * RAD_TO_DEG;
    }

    const lat = colLat ? parseNumeric(r[colLat]) : null;
    const lon = colLon ? parseNumeric(r[colLon]) : null;
    const rpm = colRpm ? parseNumeric(r[colRpm]) : null;
    const throttlePct = colThrottle ? parseNumeric(r[colThrottle]) : null;
    const brakePct = colBrake ? parseNumeric(r[colBrake]) : null;

    samples.push({
      index: i,
      tSec,
      speedKmh,
      accelLongMs2,
      accelLatMs2,
      yawRateDegS,
      lat,
      lon,
      rpm,
      throttlePct,
      brakePct,
    });
  }

  samples.sort((a, b) => a.tSec - b.tSec);

  // Derive missing speed / heading / acceleration / jerk from physical kinematics
  let prevBearing = null;
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const dt = prev ? Math.max(0.015, cur.tSec - prev.tSec) : 0.1;

    if (cur.speedKmh == null && prev && cur.lat != null && cur.lon != null && prev.lat != null && prev.lon != null) {
      const distM = haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon);
      cur.speedKmh = (distM / dt) * 3.6;
    }
    if (cur.speedKmh == null) {
      if (prev && prev.speedKmh != null && cur.accelLongMs2 != null) {
        cur.speedKmh = Math.max(0, prev.speedKmh + cur.accelLongMs2 * dt * 3.6);
      } else {
        cur.speedKmh = prev?.speedKmh ?? 0;
      }
    }

    if (cur.yawRateDegS == null && prev && cur.lat != null && cur.lon != null && prev.lat != null && prev.lon != null) {
      const distM = haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon);
      if (distM > 0.4) {
        const brg = bearingDeg(prev.lat, prev.lon, cur.lat, cur.lon);
        if (prevBearing != null) {
          cur.yawRateDegS = shortestAngleDiffDeg(prevBearing, brg) / dt;
        }
        prevBearing = brg;
      } else {
        cur.yawRateDegS = 0;
      }
    }
    if (cur.yawRateDegS == null) cur.yawRateDegS = 0;

    if (cur.accelLongMs2 == null) {
      if (prev) {
        const dvMs = (cur.speedKmh - prev.speedKmh) / 3.6;
        cur.accelLongMs2 = dvMs / dt;
      } else {
        cur.accelLongMs2 = 0;
      }
    }

    if (cur.accelLatMs2 == null) {
      const vMs = cur.speedKmh / 3.6;
      const omegaRad = cur.yawRateDegS * DEG_TO_RAD;
      cur.accelLatMs2 = vMs * omegaRad;
    }

    if (prev) {
      const dLong = cur.accelLongMs2 - prev.accelLongMs2;
      const dLat = cur.accelLatMs2 - prev.accelLatMs2;
      cur.jerkMs3 = Math.hypot(dLong, dLat) / dt;
    } else {
      cur.jerkMs3 = 0;
    }

    cur.longG = Number((cur.accelLongMs2 / G_TO_MS2).toFixed(3));
    cur.latG = Number((cur.accelLatMs2 / G_TO_MS2).toFixed(3));
    cur.totalG = Number(Math.hypot(cur.longG, cur.latG).toFixed(3));
    cur.speedKmh = Number(cur.speedKmh.toFixed(2));
    cur.accelLongMs2 = Number(cur.accelLongMs2.toFixed(3));
    cur.accelLatMs2 = Number(cur.accelLatMs2.toFixed(3));
    cur.yawRateDegS = Number(cur.yawRateDegS.toFixed(2));
    cur.jerkMs3 = Number(cur.jerkMs3.toFixed(2));
  }

  return {
    mappedColumns: {
      time: colTime,
      speed: colSpeedKmh || colSpeedMs || colSpeedMph || (colLat && colLon ? 'DERIVED_HAVERSINE_GPS' : 'INTEGRATED_ACCEL'),
      longitudinalAccel: colLongMs2 || colLongG || 'DERIVED_DV_DT',
      lateralAccel: colLatMs2 || colLatG || 'DERIVED_CENTRIPETAL',
      yawRate: colYaw || (colLat && colLon ? 'DERIVED_GPS_BEARING' : 'NONE'),
    },
    samples,
  };
}

export function analyzeKinematicSeries(samples, thresholds) {
  const events = [];
  const cooldownUntil = {
    HARSH_BRAKING: -999,
    RAPID_ACCELERATION: -999,
    SPEEDING: -999,
    RASH_DRIVING: -999,
  };

  let speedViolationStart = null;
  let peakSpeedViolation = 0;
  const yawSignWindow = [];
  let lastSignificantYawSign = 0;

  let distanceKm = 0;
  let peakSpeedKmh = 0;
  let peakLongG = 0;
  let peakLatG = 0;
  let peakJerkMs3 = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const dt = prev ? Math.max(0.01, s.tSec - prev.tSec) : 0;

    distanceKm += (s.speedKmh / 3600) * dt;
    peakSpeedKmh = Math.max(peakSpeedKmh, s.speedKmh);
    peakLongG = Math.max(peakLongG, Math.abs(s.longG));
    peakLatG = Math.max(peakLatG, Math.abs(s.latG));
    peakJerkMs3 = Math.max(peakJerkMs3, Math.abs(s.jerkMs3));

    // Track rapid lane-weaving sign reversals in yaw rate
    if (Math.abs(s.yawRateDegS) >= 18 && s.speedKmh >= 20) {
      const sign = Math.sign(s.yawRateDegS);
      if (lastSignificantYawSign !== 0 && sign !== lastSignificantYawSign) {
        yawSignWindow.push(s.tSec);
      }
      lastSignificantYawSign = sign;
    }
    while (yawSignWindow.length > 0 && s.tSec - yawSignWindow[0] > 8.0) {
      yawSignWindow.shift();
    }

    // 1. Harsh Braking
    if (s.accelLongMs2 <= thresholds.harshBrakeMs2 && s.tSec >= cooldownUntil.HARSH_BRAKING) {
      const isCritical = s.accelLongMs2 <= thresholds.harshBrakeMs2 * 1.45;
      events.push({
        tSec: Number(s.tSec.toFixed(2)),
        category: 'HARSH_BRAKING',
        severity: isCritical ? 'CRITICAL' : 'WARNING',
        stage: isCritical ? 3 : 2,
        summary: `Harsh braking impulse ${s.accelLongMs2.toFixed(2)} m/s² (${s.longG.toFixed(2)}g) at ${s.speedKmh.toFixed(1)} km/h`,
        interventionAction: isCritical
          ? 'HAZARD_BEACON_STROBE + VOICE_DISTANCE_CALLOUT'
          : 'CABIN_CHIME + FOLLOWING_DISTANCE_ADVISORY',
        metrics: {
          speedKmh: s.speedKmh,
          accelLongMs2: s.accelLongMs2,
          longG: s.longG,
          jerkMs3: s.jerkMs3,
        },
      });
      cooldownUntil.HARSH_BRAKING = s.tSec + 3.0;
    }

    // 2. Rapid Acceleration
    if (s.accelLongMs2 >= thresholds.rapidAccelMs2 && s.tSec >= cooldownUntil.RAPID_ACCELERATION) {
      const isCritical = s.accelLongMs2 >= thresholds.rapidAccelMs2 * 1.45;
      events.push({
        tSec: Number(s.tSec.toFixed(2)),
        category: 'RAPID_ACCELERATION',
        severity: isCritical ? 'CRITICAL' : 'WARNING',
        stage: isCritical ? 3 : 2,
        summary: `Rapid throttle surge +${s.accelLongMs2.toFixed(2)} m/s² (+${s.longG.toFixed(2)}g) reaching ${s.speedKmh.toFixed(1)} km/h`,
        interventionAction: 'THROTTLE_SMOOTHING_ADVISORY + AUDIO_ALERT',
        metrics: {
          speedKmh: s.speedKmh,
          accelLongMs2: s.accelLongMs2,
          longG: s.longG,
          jerkMs3: s.jerkMs3,
        },
      });
      cooldownUntil.RAPID_ACCELERATION = s.tSec + 3.0;
    }

    // 3. Speeding (hysteresis >= 1.2s or acute > 15 km/h over limit)
    const overMargin = s.speedKmh - thresholds.speedLimitKmh;
    if (overMargin > 2.0) {
      if (speedViolationStart == null) {
        speedViolationStart = s.tSec;
        peakSpeedViolation = s.speedKmh;
      } else {
        peakSpeedViolation = Math.max(peakSpeedViolation, s.speedKmh);
      }
      const heldSec = s.tSec - speedViolationStart;
      if ((heldSec >= 1.2 || overMargin >= 15) && s.tSec >= cooldownUntil.SPEEDING) {
        const isCritical = overMargin >= 20;
        events.push({
          tSec: Number(s.tSec.toFixed(2)),
          category: 'SPEEDING',
          severity: isCritical ? 'CRITICAL' : 'WARNING',
          stage: isCritical ? 3 : 2,
          summary: `Speeding ${peakSpeedViolation.toFixed(1)} km/h in ${thresholds.speedLimitKmh} km/h zone (+${(peakSpeedViolation - thresholds.speedLimitKmh).toFixed(1)} km/h)`,
          interventionAction: isCritical
            ? 'SPEED_GOVERNOR_ENGAGE + VOICE_DECELERATE_ORDER'
            : 'OVERSPEED_ACOUSTIC_PULSE + HUD_LIMIT_FLASH',
          metrics: {
            speedKmh: Number(peakSpeedViolation.toFixed(1)),
            speedLimitKmh: thresholds.speedLimitKmh,
            overspeedKmh: Number((peakSpeedViolation - thresholds.speedLimitKmh).toFixed(1)),
          },
        });
        cooldownUntil.SPEEDING = s.tSec + 5.0;
      }
    } else {
      speedViolationStart = null;
      peakSpeedViolation = 0;
    }

    // 4. Rash Driving (High Lateral Cornering G, Erratic Jerk Spike under load, Slalom Lane Weaving, or Combined Friction Overload)
    const highLat = Math.abs(s.accelLatMs2) >= thresholds.rashLatMs2;
    const highJerk =
      s.jerkMs3 >= thresholds.rashJerkMs3 &&
      Math.abs(s.accelLatMs2) >= 1.2 &&
      Math.hypot(s.accelLongMs2, s.accelLatMs2) >= 2.4;
    const slalomWeave = yawSignWindow.length >= 3;
    const combinedFriction =
      Math.abs(s.accelLongMs2) >= 2.4 &&
      Math.abs(s.accelLatMs2) >= 2.4 &&
      Math.hypot(s.accelLongMs2, s.accelLatMs2) >= 4.7;

    if ((highLat || highJerk || slalomWeave || combinedFriction) && s.tSec >= cooldownUntil.RASH_DRIVING) {
      const reasons = [];
      if (highLat) reasons.push(`lateral load ${s.latG.toFixed(2)}g`);
      if (slalomWeave) reasons.push(`lane-weave ${yawSignWindow.length} yaw reversals`);
      if (combinedFriction) reasons.push(`combined G-vector ${s.totalG.toFixed(2)}g`);
      if (highJerk && reasons.length === 0) reasons.push(`abrupt control jerk ${s.jerkMs3.toFixed(1)} m/s³`);

      const isCritical = s.totalG >= 0.55 || slalomWeave;
      events.push({
        tSec: Number(s.tSec.toFixed(2)),
        category: 'RASH_DRIVING',
        severity: isCritical ? 'CRITICAL' : 'WARNING',
        stage: isCritical ? 3 : 2,
        summary: `Rash driving maneuver (${reasons.join(', ')}) at ${s.speedKmh.toFixed(1)} km/h`,
        interventionAction: isCritical
          ? 'STABILITY_GOVERNOR_CAP + CRITICAL_VOICE_INTERVENTION'
          : 'LATERAL_LOAD_WARNING + CABIN_ALERT',
        metrics: {
          speedKmh: s.speedKmh,
          latG: s.latG,
          longG: s.longG,
          totalG: s.totalG,
          yawRateDegS: s.yawRateDegS,
          jerkMs3: s.jerkMs3,
          weaveReversals: yawSignWindow.length,
        },
      });
      cooldownUntil.RASH_DRIVING = s.tSec + 4.0;
      if (slalomWeave) yawSignWindow.length = 0;
    }
  }

  const penaltySum = events.reduce((acc, ev) => acc + (ev.stage >= 3 ? 11 : 5), 0);
  const safetyScore = Math.max(0, Math.min(100, Number((100 - penaltySum).toFixed(1))));

  return {
    summary: {
      sampleCount: samples.length,
      durationSec: samples.length > 1 ? Number((samples.at(-1).tSec - samples[0].tSec).toFixed(2)) : 0,
      distanceKm: Number(distanceKm.toFixed(3)),
      peakSpeedKmh: Number(peakSpeedKmh.toFixed(1)),
      peakLongG: Number(peakLongG.toFixed(3)),
      peakLatG: Number(peakLatG.toFixed(3)),
      peakJerkMs3: Number(peakJerkMs3.toFixed(2)),
      eventCount: events.length,
      safetyScore,
      countsByCategory: {
        HARSH_BRAKING: events.filter((e) => e.category === 'HARSH_BRAKING').length,
        RAPID_ACCELERATION: events.filter((e) => e.category === 'RAPID_ACCELERATION').length,
        SPEEDING: events.filter((e) => e.category === 'SPEEDING').length,
        RASH_DRIVING: events.filter((e) => e.category === 'RASH_DRIVING').length,
      },
    },
    events,
  };
}
