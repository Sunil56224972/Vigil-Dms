import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DB_PATH = process.env.DMS9_DB_PATH || path.join(DATA_DIR, 'blackbox_dms9.sqlite');
const GENESIS_HASH = '0'.repeat(64);

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    driver_tag TEXT NOT NULL,
    vehicle_profile TEXT NOT NULL,
    source_modes TEXT NOT NULL DEFAULT '[]',
    distance_km REAL NOT NULL DEFAULT 0,
    peak_speed_kmh REAL NOT NULL DEFAULT 0,
    peak_long_g REAL NOT NULL DEFAULT 0,
    peak_lat_g REAL NOT NULL DEFAULT 0,
    min_ear REAL,
    peak_perclos REAL NOT NULL DEFAULT 0,
    total_blinks INTEGER NOT NULL DEFAULT 0,
    total_yawns INTEGER NOT NULL DEFAULT 0,
    incident_count INTEGER NOT NULL DEFAULT 0,
    safety_index REAL NOT NULL DEFAULT 100
  );

  CREATE TABLE IF NOT EXISTS incidents (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session_id TEXT,
    timestamp_iso TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    stage INTEGER NOT NULL,
    summary TEXT NOT NULL,
    intervention_action TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    frame_evidence TEXT,
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  );
`);

export const DEFAULT_THRESHOLDS = {
  vehicleProfile: 'PASSENGER_SEDAN',
  speedLimitKmh: 60,
  harshBrakeMs2: -3.8,
  rapidAccelMs2: 3.4,
  rashLatMs2: 3.7,
  rashJerkMs3: 6.5,
  earClosureRatio: 0.72,
  earAbsoluteFloor: 0.20,
  drowsyHoldMs: 800,
  microsleepHoldMs: 1500,
  perclosWarnPct: 12,
  perclosCritPct: 20,
  yawnMarThreshold: 0.54,
  yawnHoldMs: 1600,
  distractionYawDeg: 24,
  distractionPitchDeg: 17,
  distractionHoldMs: 1500,
  audioArmed: true,
  voiceArmed: true,
  governorArmed: true,
  governorCapKmh: 40,
  nightVisionMode: 'AUTO',
  emergencyPhone: '7389416622',
  emergencyAutoCall: true,
  webhookUrl: '',
};

export const VEHICLE_PRESETS = {
  PASSENGER_SEDAN: {
    label: 'Passenger Vehicle (M1)',
    speedLimitKmh: 60,
    harshBrakeMs2: -3.8,
    rapidAccelMs2: 3.4,
    rashLatMs2: 3.7,
    rashJerkMs3: 6.5,
  },
  HEAVY_FREIGHT: {
    label: 'Heavy Commercial Haulage (N3)',
    speedLimitKmh: 50,
    harshBrakeMs2: -2.8,
    rapidAccelMs2: 2.4,
    rashLatMs2: 2.6,
    rashJerkMs3: 4.8,
  },
  TRANSIT_COACH: {
    label: 'Passenger Transit Coach (M3)',
    speedLimitKmh: 55,
    harshBrakeMs2: -3.0,
    rapidAccelMs2: 2.5,
    rashLatMs2: 2.8,
    rashJerkMs3: 5.0,
  },
  CAMPUS_UTILITY: {
    label: 'Campus / Restricted Zone',
    speedLimitKmh: 25,
    harshBrakeMs2: -3.4,
    rapidAccelMs2: 3.0,
    rashLatMs2: 3.2,
    rashJerkMs3: 5.8,
  },
};

function computeIncidentHash({
  prevHash,
  id,
  sessionId,
  timestampIso,
  category,
  severity,
  stage,
  summary,
  interventionAction,
  metricsJson,
}) {
  const canonical = [
    prevHash,
    id,
    sessionId ?? 'UNBOUND',
    timestampIso,
    category,
    severity,
    String(stage),
    summary,
    interventionAction,
    metricsJson,
  ].join('|');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function getThresholds() {
  const row = db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .get('thresholds');
  if (!row) {
    return { ...DEFAULT_THRESHOLDS };
  }
  try {
    const raw = JSON.parse(row.value);
    return {
      ...DEFAULT_THRESHOLDS,
      ...raw,
      emergencyPhone: String(raw.emergencyPhone ?? '').trim() || DEFAULT_THRESHOLDS.emergencyPhone,
      nightVisionMode: raw.nightVisionMode ?? DEFAULT_THRESHOLDS.nightVisionMode,
      emergencyAutoCall: raw.emergencyAutoCall ?? DEFAULT_THRESHOLDS.emergencyAutoCall,
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export function saveThresholds(partial) {
  const merged = { ...getThresholds(), ...partial };
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('thresholds', JSON.stringify(merged), now);
  return merged;
}

export function startSession({ driverTag = 'OPERATOR-01', vehicleProfile = 'PASSENGER_SEDAN', sourceModes = [] }) {
  const id = `SES-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const startedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (id, started_at, driver_tag, vehicle_profile, source_modes)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, startedAt, driverTag.trim() || 'OPERATOR-01', vehicleProfile, JSON.stringify(sourceModes));
  return getSessionById(id);
}

export function updateSessionTelemetry(sessionId, stats) {
  const existing = getSessionById(sessionId);
  if (!existing) return null;
  const distanceKm = Math.max(existing.distance_km, Number(stats.distanceKm ?? existing.distance_km));
  const peakSpeedKmh = Math.max(existing.peak_speed_kmh, Number(stats.peakSpeedKmh ?? existing.peak_speed_kmh));
  const peakLongG = Math.max(existing.peak_long_g, Math.abs(Number(stats.peakLongG ?? existing.peak_long_g)));
  const peakLatG = Math.max(existing.peak_lat_g, Math.abs(Number(stats.peakLatG ?? existing.peak_lat_g)));
  const minEar =
    stats.minEar != null
      ? existing.min_ear != null
        ? Math.min(existing.min_ear, Number(stats.minEar))
        : Number(stats.minEar)
      : existing.min_ear;
  const peakPerclos = Math.max(existing.peak_perclos, Number(stats.peakPerclos ?? existing.peak_perclos));
  const totalBlinks = Math.max(existing.total_blinks, Math.round(Number(stats.totalBlinks ?? existing.total_blinks)));
  const totalYawns = Math.max(existing.total_yawns, Math.round(Number(stats.totalYawns ?? existing.total_yawns)));
  const safetyIndex =
    stats.safetyIndex != null ? Math.max(0, Math.min(100, Number(stats.safetyIndex))) : existing.safety_index;
  const sourceModes = Array.isArray(stats.sourceModes)
    ? JSON.stringify(Array.from(new Set([...JSON.parse(existing.source_modes || '[]'), ...stats.sourceModes])))
    : existing.source_modes;

  db.prepare(`
    UPDATE sessions
    SET distance_km = ?,
        peak_speed_kmh = ?,
        peak_long_g = ?,
        peak_lat_g = ?,
        min_ear = ?,
        peak_perclos = ?,
        total_blinks = ?,
        total_yawns = ?,
        safety_index = ?,
        source_modes = ?
    WHERE id = ?
  `).run(
    distanceKm,
    peakSpeedKmh,
    peakLongG,
    peakLatG,
    minEar,
    peakPerclos,
    totalBlinks,
    totalYawns,
    safetyIndex,
    sourceModes,
    sessionId
  );
  return getSessionById(sessionId);
}

export function endSession(sessionId, finalStats = {}) {
  if (Object.keys(finalStats).length > 0) {
    updateSessionTelemetry(sessionId, finalStats);
  }
  const endedAt = new Date().toISOString();
  db.prepare('UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(endedAt, sessionId);
  return getSessionById(sessionId);
}

export function getSessionById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
}

export function listSessions(limit = 25) {
  return db
    .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 25)));
}

export function recordIncident({
  sessionId = null,
  timestampIso = new Date().toISOString(),
  category,
  severity = 'WARNING',
  stage = 2,
  summary,
  interventionAction = 'AUDIO_VISUAL_ALERT',
  metrics = {},
  frameEvidence = null,
}) {
  const validSession = sessionId && getSessionById(sessionId) ? sessionId : null;
  const lastRow = db.prepare('SELECT entry_hash FROM incidents ORDER BY seq DESC LIMIT 1').get();
  const prevHash = lastRow ? lastRow.entry_hash : GENESIS_HASH;
  const id = `INC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const metricsJson = JSON.stringify(metrics ?? {});

  const entryHash = computeIncidentHash({
    prevHash,
    id,
    sessionId: validSession,
    timestampIso,
    category,
    severity,
    stage,
    summary,
    interventionAction,
    metricsJson,
  });

  db.prepare(`
    INSERT INTO incidents (
      id, session_id, timestamp_iso, category, severity, stage,
      summary, intervention_action, metrics_json, frame_evidence, prev_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    validSession,
    timestampIso,
    category,
    severity,
    stage,
    summary,
    interventionAction,
    metricsJson,
    frameEvidence,
    prevHash,
    entryHash
  );

  if (validSession) {
    const penalty = stage >= 3 ? 12 : stage === 2 ? 5 : 2;
    db.prepare(`
      UPDATE sessions
      SET incident_count = incident_count + 1,
          safety_index = MAX(0, safety_index - ?)
      WHERE id = ?
    `).run(penalty, validSession);
  }

  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
}

export function listIncidents({ sessionId = null, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  if (sessionId) {
    return db
      .prepare('SELECT * FROM incidents WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, cap);
  }
  return db.prepare('SELECT * FROM incidents ORDER BY seq DESC LIMIT ?').all(cap);
}

export function verifyLedgerIntegrity() {
  const startNs = process.hrtime.bigint();
  const rows = db.prepare('SELECT * FROM incidents ORDER BY seq ASC').all();
  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      return {
        valid: false,
        checkedCount: rows.length,
        brokenAtSeq: row.seq,
        brokenId: row.id,
        reason: 'PREV_HASH_MISMATCH',
        headHash: rows.at(-1)?.entry_hash ?? GENESIS_HASH,
        genesisHash: GENESIS_HASH,
        durationMs: Number(durationMs.toFixed(3)),
      };
    }

    const recomputed = computeIncidentHash({
      prevHash: row.prev_hash,
      id: row.id,
      sessionId: row.session_id,
      timestampIso: row.timestamp_iso,
      category: row.category,
      severity: row.severity,
      stage: row.stage,
      summary: row.summary,
      interventionAction: row.intervention_action,
      metricsJson: row.metrics_json,
    });

    if (recomputed !== row.entry_hash) {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      return {
        valid: false,
        checkedCount: rows.length,
        brokenAtSeq: row.seq,
        brokenId: row.id,
        reason: 'ENTRY_HASH_TAMPERED',
        headHash: rows.at(-1)?.entry_hash ?? GENESIS_HASH,
        genesisHash: GENESIS_HASH,
        durationMs: Number(durationMs.toFixed(3)),
      };
    }
    expectedPrev = row.entry_hash;
  }

  const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  return {
    valid: true,
    checkedCount: rows.length,
    brokenAtSeq: null,
    brokenId: null,
    reason: null,
    headHash: expectedPrev,
    genesisHash: GENESIS_HASH,
    durationMs: Number(durationMs.toFixed(3)),
  };
}

export function clearAllLedgerData() {
  db.exec('DELETE FROM incidents; DELETE FROM sessions;');
  return verifyLedgerIntegrity();
}

export function getDbMetrics() {
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(DB_PATH).size;
  } catch {
    sizeBytes = 0;
  }
  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  const incidentCount = db.prepare('SELECT COUNT(*) as count FROM incidents').get().count;
  return {
    dbPath: DB_PATH,
    sizeBytes,
    sessionCount,
    incidentCount,
  };
}
