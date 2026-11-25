import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';

import {
  VEHICLE_PRESETS,
  getThresholds,
  saveThresholds,
  startSession,
  updateSessionTelemetry,
  endSession,
  listSessions,
  recordIncident,
  listIncidents,
  verifyLedgerIntegrity,
  clearAllLedgerData,
  getDbMetrics,
} from './db.mjs';
import { parseTelemetryPayload, analyzeKinematicSeries } from './kinematics.mjs';
import { dispatchTwilioVoiceCall, buildEmergencyMessageText } from '../api/emergency-call.mjs';
import {
  getWhatsAppStatus,
  hasSavedWhatsAppSession,
  startWhatsAppLink,
  disconnectWhatsApp,
  sendWhatsAppEmergency,
  setWhatsAppStatusListener,
} from './whatsappBridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const HTTP_PORT = Number(process.env.PORT || 4400);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 4443);
const IS_DEV = process.argv.includes('--dev') || !fs.existsSync(path.join(DIST_DIR, 'index.html'));
const BOOT_TIME = Date.now();
const PAIRING_TOKEN = crypto.randomBytes(4).toString('hex').toUpperCase();

function detectLanAddresses() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const lower = name.toLowerCase();
        const isVirtual =
          lower.includes('wsl') ||
          lower.includes('vethernet') ||
          lower.includes('vmware') ||
          lower.includes('virtualbox') ||
          lower.includes('docker');
        candidates.push({ name, address: iface.address, isVirtual });
      }
    }
  }
  candidates.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual));
  return candidates;
}

async function dispatchSafetyWebhook(webhookUrl, payload) {
  if (!webhookUrl || !webhookUrl.startsWith('http')) return null;
  const start = performance.now();
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', PAIRING_TOKEN).update(body).digest('hex');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DMS9-Signature': `sha256=${sig}`,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'Webhook dispatch error',
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '16mb' }));

  const cockpitSockets = new Set();
  const sensorNodes = new Map();

  function broadcastToCockpits(msgObj) {
    const raw = JSON.stringify(msgObj);
    for (const client of cockpitSockets) {
      if (client.readyState === 1) {
        client.send(raw);
      }
    }
  }

  function broadcastSensorRoster() {
    const nodes = Array.from(sensorNodes.values()).map((n) => ({
      nodeId: n.nodeId,
      label: n.label,
      connectedAt: n.connectedAt,
      lastPacketAt: n.lastPacketAt,
      packetCount: n.packetCount,
      hasGps: n.hasGps,
    }));
    broadcastToCockpits({ type: 'SENSOR_ROSTER', nodes });
  }

  // --- API ROUTES ---

  app.get('/api/system/status', async (_req, res) => {
    const lans = detectLanAddresses();
    const primaryIp = lans[0]?.address || '127.0.0.1';
    const sensorHttpsUrl = `https://${primaryIp}:${HTTPS_PORT}/sensor?token=${PAIRING_TOKEN}`;
    const sensorHttpUrl = `http://${primaryIp}:${HTTP_PORT}/sensor?token=${PAIRING_TOKEN}`;
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(sensorHttpsUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#e8e4dc', light: '#00000000' },
      });
    } catch {
      qrSvg = '';
    }

    res.json({
      system: 'BLACKBOX // DMS-9',
      uptimeSec: Math.floor((Date.now() - BOOT_TIME) / 1000),
      pairingToken: PAIRING_TOKEN,
      network: {
        httpPort: HTTP_PORT,
        httpsPort: HTTPS_PORT,
        primaryLanIp: primaryIp,
        interfaces: lans,
        sensorHttpsUrl,
        sensorHttpUrl,
        qrSvg,
      },
      connectedSensors: Array.from(sensorNodes.values()).map((n) => ({
        nodeId: n.nodeId,
        label: n.label,
        packetCount: n.packetCount,
        lastPacketAt: n.lastPacketAt,
        hasGps: n.hasGps,
      })),
      db: getDbMetrics(),
      ledger: verifyLedgerIntegrity(),
      thresholds: getThresholds(),
      presets: VEHICLE_PRESETS,
    });
  });

  app.get('/api/config/thresholds', (_req, res) => {
    res.json({ thresholds: getThresholds(), presets: VEHICLE_PRESETS });
  });

  app.post('/api/config/thresholds', (req, res) => {
    const updated = saveThresholds(req.body ?? {});
    broadcastToCockpits({ type: 'THRESHOLDS_UPDATED', thresholds: updated });
    res.json({ thresholds: updated });
  });

  app.get('/api/sessions', (req, res) => {
    const sessions = listSessions(req.query.limit);
    res.json({ sessions });
  });

  app.post('/api/sessions/start', (req, res) => {
    const session = startSession(req.body ?? {});
    broadcastToCockpits({ type: 'SESSION_STARTED', session });
    res.json({ session });
  });

  app.post('/api/sessions/:id/telemetry', (req, res) => {
    const session = updateSessionTelemetry(req.params.id, req.body ?? {});
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  });

  app.post('/api/sessions/:id/end', (req, res) => {
    const session = endSession(req.params.id, req.body ?? {});
    if (!session) return res.status(404).json({ error: 'Session not found' });
    broadcastToCockpits({ type: 'SESSION_ENDED', session });
    res.json({ session });
  });

  app.get('/api/incidents', (req, res) => {
    const incidents = listIncidents({
      sessionId: req.query.sessionId || null,
      limit: req.query.limit || 100,
    });
    res.json({ incidents });
  });

  app.post('/api/incidents', async (req, res) => {
    const body = req.body ?? {};
    if (!body.category || !body.summary) {
      return res.status(400).json({ error: 'category and summary are required' });
    }
    const saved = recordIncident({
      sessionId: body.sessionId ?? null,
      timestampIso: body.timestampIso || new Date().toISOString(),
      category: body.category,
      severity: body.severity || 'WARNING',
      stage: Number(body.stage || 2),
      summary: body.summary,
      interventionAction: body.interventionAction || 'AUDIO_VISUAL_ALERT',
      metrics: body.metrics || {},
      frameEvidence: body.frameEvidence || null,
    });

    const thresholds = getThresholds();
    let webhookResult = null;
    if (thresholds.webhookUrl && saved.stage >= 2) {
      webhookResult = await dispatchSafetyWebhook(thresholds.webhookUrl, {
        event: 'DMS9_SAFETY_INCIDENT',
        incident: {
          id: saved.id,
          seq: saved.seq,
          timestampIso: saved.timestamp_iso,
          category: saved.category,
          severity: saved.severity,
          stage: saved.stage,
          summary: saved.summary,
          interventionAction: saved.intervention_action,
          metrics: JSON.parse(saved.metrics_json || '{}'),
          entryHash: saved.entry_hash,
        },
      });
    }

    broadcastToCockpits({ type: 'INCIDENT_RECORDED', incident: saved, webhookResult });
    res.json({ incident: saved, webhookResult });
  });

  app.get('/api/ledger/verify', (_req, res) => {
    res.json(verifyLedgerIntegrity());
  });

  setWhatsAppStatusListener((waStatus) => {
    broadcastToCockpits({ type: 'WHATSAPP_STATUS', whatsapp: waStatus });
  });
  if (hasSavedWhatsAppSession()) {
    startWhatsAppLink({}).catch(() => {});
  }

  app.get('/api/whatsapp/status', (_req, res) => {
    res.json({ ok: true, whatsapp: getWhatsAppStatus() });
  });

  app.post('/api/whatsapp/connect', async (req, res) => {
    const phone = String(req.body?.phone || getThresholds().emergencyPhone || '7389416622');
    const usePairingCode = Boolean(req.body?.usePairingCode);
    const wa = await startWhatsAppLink({ phoneForPairingCode: phone, usePairingCode });
    res.json({ ok: true, whatsapp: wa });
  });

  app.post('/api/whatsapp/disconnect', async (_req, res) => {
    const wa = await disconnectWhatsApp();
    res.json({ ok: true, whatsapp: wa });
  });

  const handleEmergencyCall = async (req, res) => {
    const body = req.body || {};
    const thresholds = getThresholds();
    const rawPhone = String(body.phone || body.to || thresholds.emergencyPhone || '7389416622').trim();
    const digits = rawPhone.replace(/\D/g, '') || '7389416622';
    const dialNumber = rawPhone.startsWith('+')
      ? `+${digits}`
      : digits.length === 10
      ? `+91${digits}`
      : `+${digits}`;

    const smsText = buildEmergencyMessageText({
      to: dialNumber,
      driverTag: body.driverTag,
      reason: body.reason || 'Driver emergency',
      speedKmh: body.speedKmh,
      lat: body.lat,
      lon: body.lon,
    });

    // 1. Built-in Direct WhatsApp Auto-Sender (zero API key, sends text + Night-IR photo + GPS location pin)
    const waOut = await sendWhatsAppEmergency({
      phone: dialNumber,
      text: smsText,
      frameEvidence: body.frameEvidence || null,
      lat: body.lat,
      lon: body.lon,
    }).catch((err) => ({
      sent: false,
      reason: err instanceof Error ? err.message : 'WA error',
    }));

    const pstnResult = await dispatchTwilioVoiceCall({
      to: dialNumber,
      driverTag: body.driverTag,
      reason: body.reason || 'Driver emergency',
      speedKmh: body.speedKmh,
      lat: body.lat,
      lon: body.lon,
      twilioSid: body.twilioSid,
      twilioToken: body.twilioToken,
      twilioFrom: body.twilioFrom,
      fast2smsKey: body.fast2smsKey,
      callmebotKey: body.callmebotKey,
    }).catch((err) => ({
      ok: false,
      pstnDispatched: false,
      status: 'FAILED',
      message: err instanceof Error ? err.message : 'PSTN gateway error',
    }));

    if (waOut.sent) {
      pstnResult.ok = true;
      pstnResult.pstnDispatched = true;
      pstnResult.status = 'RINGING';
      pstnResult.channelsSent = ['Direct WhatsApp + Photo + GPS', ...(pstnResult.channelsSent || [])];
      pstnResult.message = `Auto-sent WhatsApp SOS${
        body.frameEvidence ? ' + Cabin Snapshot' : ''
      } + GPS to ${dialNumber}`;
    }

    const saved = recordIncident({
      sessionId: body.sessionId ?? null,
      timestampIso: new Date().toISOString(),
      category: 'EMERGENCY_SOS',
      severity: 'CRITICAL',
      stage: 3,
      summary: `Emergency SOS call dispatched to ${dialNumber} (${body.reason || 'Driver emergency'})`,
      interventionAction: pstnResult.pstnDispatched
        ? 'TWILIO_PSTN_VOICE_CALL + GPS_SOS_DISPATCH + HAZARD_BEACONS'
        : 'EMERGENCY_VOICE_CALL + GPS_SOS_DISPATCH + HAZARD_BEACONS',
      metrics: {
        dialNumber,
        reason: body.reason || 'Driver emergency',
        autoTriggered: Boolean(body.autoTriggered),
        pstnDispatched: Boolean(pstnResult.pstnDispatched),
        callSid: pstnResult.callSid ?? null,
        speedKmh: body.speedKmh ?? 0,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
      },
      frameEvidence: body.frameEvidence || null,
    });

    let webhookResult = null;
    if (thresholds.webhookUrl) {
      webhookResult = await dispatchSafetyWebhook(thresholds.webhookUrl, {
        event: 'DMS9_EMERGENCY_SOS_CALL',
        dialNumber,
        pstnResult,
        incident: saved,
      });
    }

    const wsPayload = {
      type: 'EMERGENCY_CALL_DISPATCHED',
      dialNumber,
      reason: body.reason || 'Driver emergency',
      pstnResult,
      incident: saved,
      webhookResult,
    };
    broadcastToCockpits(wsPayload);
    for (const ws of sensorNodes.keys()) {
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify(wsPayload));
        } catch {}
      }
    }

    res.status(pstnResult.status === 'FAILED' ? 400 : 200).json({
      ...pstnResult,
      ok: pstnResult.status !== 'FAILED',
      dialNumber,
      telUri: `tel:${dialNumber}`,
      incident: saved,
      webhookResult,
    });
  };

  app.post('/api/emergency/call', handleEmergencyCall);
  app.post('/api/emergency-call', handleEmergencyCall);

  app.delete('/api/ledger/reset', (_req, res) => {
    const verification = clearAllLedgerData();
    broadcastToCockpits({ type: 'LEDGER_CLEARED', verification });
    res.json({ ok: true, verification });
  });

  app.post('/api/telemetry/analyze-file', (req, res) => {
    try {
      const content = typeof req.body === 'string' ? req.body : req.body?.content;
      const format = typeof req.body === 'object' ? req.body?.format || 'auto' : 'auto';
      const persistIncidents = typeof req.body === 'object' ? Boolean(req.body?.persistIncidents) : false;
      const sessionId = typeof req.body === 'object' ? req.body?.sessionId || null : null;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'Provide raw CSV or JSON telemetry content.' });
      }

      const thresholds = getThresholds();
      const parsed = parseTelemetryPayload(content, format);
      const analysis = analyzeKinematicSeries(parsed.samples, thresholds);

      const persisted = [];
      if (persistIncidents && analysis.events.length > 0) {
        const baseMs = Date.now();
        for (const ev of analysis.events) {
          const row = recordIncident({
            sessionId,
            timestampIso: new Date(baseMs + ev.tSec * 1000).toISOString(),
            category: ev.category,
            severity: ev.severity,
            stage: ev.stage,
            summary: ev.summary,
            interventionAction: ev.interventionAction,
            metrics: { ...ev.metrics, tSec: ev.tSec, source: 'FILE_TELEMETRY_ANALYSIS' },
          });
          persisted.push(row);
        }
      }

      res.json({
        mappedColumns: parsed.mappedColumns,
        samples: parsed.samples,
        analysis,
        persistedCount: persisted.length,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to parse telemetry payload.',
      });
    }
  });

  // Real live hardware / OBD-II HTTP ingest endpoint
  app.post('/api/telemetry/ingest', (req, res) => {
    const p = req.body ?? {};
    const frame = {
      source: p.source || 'EXTERNAL_HTTP_BUS',
      timestampMs: Number(p.timestampMs || Date.now()),
      speedKmh: p.speedKmh != null ? Number(p.speedKmh) : null,
      accelLongMs2: p.accelLongMs2 != null ? Number(p.accelLongMs2) : 0,
      accelLatMs2: p.accelLatMs2 != null ? Number(p.accelLatMs2) : 0,
      yawRateDegS: p.yawRateDegS != null ? Number(p.yawRateDegS) : 0,
      rpm: p.rpm != null ? Number(p.rpm) : null,
      throttlePct: p.throttlePct != null ? Number(p.throttlePct) : null,
      brakePct: p.brakePct != null ? Number(p.brakePct) : null,
      lat: p.lat != null ? Number(p.lat) : null,
      lon: p.lon != null ? Number(p.lon) : null,
    };
    broadcastToCockpits({ type: 'EXTERNAL_TELEMETRY_FRAME', frame });
    res.json({ ok: true, relayedTo: cockpitSockets.size });
  });

  app.get('/api/export/forensic', (req, res) => {
    const format = String(req.query.format || 'json').toLowerCase();
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
    const incidents = listIncidents({ sessionId, limit: 500 });
    const sessions = listSessions(100);
    const ledger = verifyLedgerIntegrity();

    if (format === 'csv') {
      const header = [
        'seq',
        'id',
        'session_id',
        'timestamp_iso',
        'category',
        'severity',
        'stage',
        'summary',
        'intervention_action',
        'prev_hash',
        'entry_hash',
        'metrics_json',
      ].join(',');
      const lines = incidents.map((r) =>
        [
          r.seq,
          r.id,
          r.session_id || '',
          r.timestamp_iso,
          r.category,
          r.severity,
          r.stage,
          `"${String(r.summary).replace(/"/g, '""')}"`,
          `"${String(r.intervention_action).replace(/"/g, '""')}"`,
          r.prev_hash,
          r.entry_hash,
          `"${String(r.metrics_json).replace(/"/g, '""')}"`,
        ].join(',')
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="dms9-forensic-ledger.csv"');
      return res.send([header, ...lines].join('\n'));
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="dms9-forensic-bundle.json"');
    return res.send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          system: 'BLACKBOX // DMS-9',
          ledgerVerification: ledger,
          thresholds: getThresholds(),
          sessions,
          incidents: incidents.map((r) => ({
            ...r,
            metrics: JSON.parse(r.metrics_json || '{}'),
          })),
        },
        null,
        2
      )
    );
  });

  // --- FRONTEND SERVING (VITE MIDDLEWARE OR PRODUCTION STATIC) ---
  if (IS_DEV) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: ROOT_DIR,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  // --- WEBSOCKET ATTACHMENT ---
  function attachWebSocketBus(server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, url);
        });
      }
    });

    wss.on('connection', (ws, _req, url) => {
      const role = url.searchParams.get('role') || 'cockpit';
      if (role === 'sensor') {
        const nodeId = `IMU-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const label = url.searchParams.get('label') || 'Handheld IMU/GPS Node';
        sensorNodes.set(ws, {
          nodeId,
          label,
          connectedAt: new Date().toISOString(),
          lastPacketAt: null,
          packetCount: 0,
          hasGps: false,
        });
        ws.send(JSON.stringify({ type: 'SENSOR_ACK', nodeId }));
        broadcastSensorRoster();

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'SENSOR_FRAME') {
              const meta = sensorNodes.get(ws);
              if (meta) {
                meta.packetCount += 1;
                meta.lastPacketAt = Date.now();
                if (msg.frame?.speedKmh != null || msg.frame?.lat != null) {
                  meta.hasGps = true;
                }
                if (meta.packetCount % 40 === 1) {
                  broadcastSensorRoster();
                }
              }
              broadcastToCockpits({
                type: 'EXTERNAL_TELEMETRY_FRAME',
                frame: {
                  ...msg.frame,
                  source: 'MOBILE_SENSOR_NODE',
                  nodeId,
                },
              });
            }
          } catch {
            // Ignore malformed frame
          }
        });

        ws.on('close', () => {
          sensorNodes.delete(ws);
          broadcastSensorRoster();
        });
      } else {
        cockpitSockets.add(ws);
        ws.send(
          JSON.stringify({
            type: 'COCKPIT_READY',
            pairingToken: PAIRING_TOKEN,
            nodes: Array.from(sensorNodes.values()),
          })
        );
        ws.on('close', () => {
          cockpitSockets.delete(ws);
        });
      }
    });
  }

  const httpServer = http.createServer(app);
  attachWebSocketBus(httpServer);

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    const lans = detectLanAddresses();
    const lanIp = lans[0]?.address || '127.0.0.1';
    console.log(`[DMS-9] Cockpit HTTP Server ready -> http://localhost:${HTTP_PORT}`);
    console.log(`[DMS-9] LAN Interface             -> http://${lanIp}:${HTTP_PORT}`);
  });

  try {
    const lans = detectLanAddresses();
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...lans.map((l) => ({ type: 7, ip: l.address })),
    ];
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'DMS9-Telemetry-Bridge' }], {
      days: 365,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
    attachWebSocketBus(httpsServer);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      const lanIp = lans[0]?.address || '127.0.0.1';
      console.log(`[DMS-9] Mobile Sensor HTTPS Bridge -> https://${lanIp}:${HTTPS_PORT}/sensor?token=${PAIRING_TOKEN}`);
    });
  } catch (err) {
    console.warn('[DMS-9] HTTPS bridge skipped:', err instanceof Error ? err.message : err);
  }
}

bootstrap();
