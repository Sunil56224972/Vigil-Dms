process.env.DMS9_DB_PATH = ':memory:';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelemetryPayload, analyzeKinematicSeries } from './kinematics.mjs';
const { DEFAULT_THRESHOLDS, recordIncident, verifyLedgerIntegrity } = await import('./db.mjs');

test('Kinematics engine detects harsh braking, rapid acceleration, speeding, and rash driving from real CSV', () => {
  const csv = [
    'time_s,speed_kmh,accel_x,accel_y,gyro_z',
    '0.0,30.0,0.2,0.1,1.0',
    '0.5,42.0,4.2,0.1,1.5',
    '1.0,48.0,0.3,0.0,0.5',
    '2.0,72.0,1.2,0.2,2.0',
    '3.5,76.0,0.4,0.2,1.0',
    '4.5,52.0,-5.1,0.3,2.5',
    '6.0,46.0,-0.2,4.4,26.0',
  ].join('\n');

  const parsed = parseTelemetryPayload(csv, 'csv');
  assert.equal(parsed.samples.length, 7);

  const report = analyzeKinematicSeries(parsed.samples, {
    ...DEFAULT_THRESHOLDS,
    speedLimitKmh: 60,
  });

  assert.equal(report.summary.countsByCategory.RAPID_ACCELERATION, 1);
  assert.equal(report.summary.countsByCategory.SPEEDING, 1);
  assert.equal(report.summary.countsByCategory.HARSH_BRAKING, 1);
  assert.equal(report.summary.countsByCategory.RASH_DRIVING, 1);
  assert.ok(report.summary.safetyScore < 100);
});

test('SHA-256 Blackbox Ledger builds a verifiable cryptographic hash chain', () => {
  const inc = recordIncident({
    category: 'HARSH_BRAKING',
    severity: 'WARNING',
    stage: 2,
    summary: 'Unit test braking verification -4.50 m/s²',
    interventionAction: 'CABIN_CHIME',
    metrics: { accelLongMs2: -4.5, speedKmh: 48.2 },
  });
  assert.ok(inc.entry_hash.length === 64);

  const check = verifyLedgerIntegrity();
  assert.equal(check.valid, true);
  assert.ok(check.checkedCount >= 1);
});
