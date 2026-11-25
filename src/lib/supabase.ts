import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import type {
  AnalyzedTelemetryReport,
  IncidentCategory,
  IncidentRecord,
  IncidentSeverity,
  LedgerVerification,
  SessionRecord,
  ThresholdsConfig,
} from '../types/telemetry';

const DEFAULT_PUBLIC_SUPABASE_URL = 'https://jdvafpwancenabxbnxbh.supabase.co';
const DEFAULT_PUBLIC_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpkdmFmcHdhbmNlbmFieGJueGJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMDMwNjgsImV4cCI6MjEwMTY3OTA2OH0.xVZOUOiO_uDzRLHbZ9jjCjV8bZ8cUpZaQINzIgn6QlA';

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || DEFAULT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_PUBLIC_SUPABASE_ANON_KEY;
export const SUPABASE_EDGE_URL =
  import.meta.env.VITE_SUPABASE_EDGE_URL ||
  `${SUPABASE_URL}/functions/v1/dms9-telemetry`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 40,
    },
  },
});

export const DEFAULT_THRESHOLDS_CLIENT: ThresholdsConfig = {
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

export const VEHICLE_PROFILE_PRESETS: Record<
  ThresholdsConfig['vehicleProfile'],
  {
    label: string;
    code: string;
    speedLimitKmh: number;
    harshBrakeMs2: number;
    rapidAccelMs2: number;
    rashLatMs2: number;
    rashJerkMs3: number;
  }
> = {
  PASSENGER_SEDAN: {
    label: 'Passenger Vehicle',
    code: 'CLASS-M1',
    speedLimitKmh: 60,
    harshBrakeMs2: -3.8,
    rapidAccelMs2: 3.4,
    rashLatMs2: 3.7,
    rashJerkMs3: 6.5,
  },
  HEAVY_FREIGHT: {
    label: 'Heavy Freight Haulage',
    code: 'CLASS-N3',
    speedLimitKmh: 50,
    harshBrakeMs2: -2.8,
    rapidAccelMs2: 2.4,
    rashLatMs2: 2.6,
    rashJerkMs3: 4.8,
  },
  TRANSIT_COACH: {
    label: 'Passenger Transit Coach',
    code: 'CLASS-M3',
    speedLimitKmh: 55,
    harshBrakeMs2: -3.0,
    rapidAccelMs2: 2.5,
    rashLatMs2: 2.8,
    rashJerkMs3: 5.0,
  },
  CAMPUS_UTILITY: {
    label: 'Restricted Campus Zone',
    code: 'ZONE-25',
    speedLimitKmh: 25,
    harshBrakeMs2: -3.4,
    rapidAccelMs2: 3.0,
    rashLatMs2: 3.2,
    rashJerkMs3: 5.8,
  },
};

function randomShortHex(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function fetchThresholdsConfig(): Promise<ThresholdsConfig> {
  const { data, error } = await supabase
    .from('dms9_config')
    .select('value')
    .eq('key', 'thresholds')
    .maybeSingle();

  if (error || !data?.value) {
    return { ...DEFAULT_THRESHOLDS_CLIENT };
  }
  const raw = data.value as Partial<ThresholdsConfig>;
  return {
    ...DEFAULT_THRESHOLDS_CLIENT,
    ...raw,
    emergencyPhone: raw.emergencyPhone?.trim() || DEFAULT_THRESHOLDS_CLIENT.emergencyPhone,
    nightVisionMode: raw.nightVisionMode ?? DEFAULT_THRESHOLDS_CLIENT.nightVisionMode,
    emergencyAutoCall: raw.emergencyAutoCall ?? DEFAULT_THRESHOLDS_CLIENT.emergencyAutoCall,
  };
}

export async function persistThresholdsConfig(next: Partial<ThresholdsConfig>): Promise<ThresholdsConfig> {
  const current = await fetchThresholdsConfig();
  const merged = { ...current, ...next };
  await supabase.from('dms9_config').upsert(
    {
      key: 'thresholds',
      value: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
  return merged;
}

export async function createDrivingSession(params: {
  driverTag: string;
  vehicleProfile: string;
  sourceModes: string[];
}): Promise<SessionRecord | null> {
  const id = `SES-${Date.now().toString(36).toUpperCase()}-${randomShortHex()}`;
  const { data, error } = await supabase
    .from('dms9_sessions')
    .insert({
      id,
      started_at: new Date().toISOString(),
      driver_tag: params.driverTag.trim() || 'OPERATOR-01',
      vehicle_profile: params.vehicleProfile,
      source_modes: params.sourceModes,
    })
    .select('*')
    .single();

  if (error) {
    console.error('[DMS-9 Supabase] Session creation error:', error.message);
    return null;
  }
  return data as SessionRecord;
}

export async function syncDrivingSessionMetrics(
  sessionId: string,
  metrics: {
    distanceKm: number;
    peakSpeedKmh: number;
    peakLongG: number;
    peakLatG: number;
    minEar: number | null;
    peakPerclos: number;
    totalBlinks: number;
    totalYawns: number;
    sourceModes: string[];
    ended?: boolean;
  }
): Promise<SessionRecord | null> {
  const payload: Record<string, unknown> = {
    distance_km: Number(metrics.distanceKm.toFixed(4)),
    peak_speed_kmh: Number(metrics.peakSpeedKmh.toFixed(1)),
    peak_long_g: Number(metrics.peakLongG.toFixed(3)),
    peak_lat_g: Number(metrics.peakLatG.toFixed(3)),
    min_ear: metrics.minEar != null ? Number(metrics.minEar.toFixed(3)) : null,
    peak_perclos: Number(metrics.peakPerclos.toFixed(1)),
    total_blinks: Math.round(metrics.totalBlinks),
    total_yawns: Math.round(metrics.totalYawns),
    source_modes: metrics.sourceModes,
  };
  if (metrics.ended) {
    payload.ended_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('dms9_sessions')
    .update(payload)
    .eq('id', sessionId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[DMS-9 Supabase] Session update error:', error.message);
    return null;
  }
  return (data as SessionRecord) ?? null;
}

export async function fetchDrivingSessions(limit = 30): Promise<SessionRecord[]> {
  const { data, error } = await supabase
    .from('dms9_sessions')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as SessionRecord[];
}

export async function logSafetyIncident(params: {
  sessionId: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  stage: number;
  summary: string;
  interventionAction: string;
  metrics: Record<string, unknown>;
  frameEvidence?: string | null;
  webhookUrl?: string;
}): Promise<IncidentRecord | null> {
  const id = `INC-${Date.now().toString(36).toUpperCase()}-${randomShortHex()}`;
  const timestampIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('dms9_incidents')
    .insert({
      id,
      session_id: params.sessionId,
      timestamp_iso: timestampIso,
      category: params.category,
      severity: params.severity,
      stage: params.stage,
      summary: params.summary,
      intervention_action: params.interventionAction,
      metrics_json: JSON.stringify(params.metrics ?? {}),
      frame_evidence: params.frameEvidence ?? null,
    })
    .select('*')
    .single();

  if (error) {
    // Offline / cellular dead-zone fallback to local SQLite SHA-256 ledger when available
    if (params.category !== 'EMERGENCY_SOS') {
      try {
        const localRes = await fetch('/api/incidents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: params.sessionId,
            timestampIso,
            category: params.category,
            severity: params.severity,
            stage: params.stage,
            summary: params.summary,
            interventionAction: params.interventionAction,
            metrics: params.metrics ?? {},
            frameEvidence: params.frameEvidence ?? null,
          }),
        });
        if (localRes.ok) {
          const localJson = await localRes.json();
          if (localJson?.incident) return localJson.incident as IncidentRecord;
        }
      } catch {
        // Ignore if static deployment without local API
      }
    }
    console.error('[DMS-9 Supabase] Incident insert error:', error.message);
    return null;
  }

  const record = data as IncidentRecord;

  // Also mirror to optional webhook via local relay if configured
  if (params.webhookUrl && params.webhookUrl.startsWith('http') && params.stage >= 2) {
    fetch(params.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'DMS9_SAFETY_INCIDENT',
        incident: record,
      }),
    }).catch(() => {});
  }

  return record;
}

export async function fetchSafetyIncidents(sessionId?: string | null, limit = 100): Promise<IncidentRecord[]> {
  let q = supabase.from('dms9_incidents').select('*').order('seq', { ascending: false }).limit(limit);
  if (sessionId) {
    q = q.eq('session_id', sessionId);
  }
  const { data, error } = await q;
  if (error || !data) {
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (sessionId) qs.set('sessionId', sessionId);
      const localRes = await fetch(`/api/incidents?${qs.toString()}`);
      if (localRes.ok) {
        const localJson = await localRes.json();
        return (localJson?.incidents as IncidentRecord[]) ?? [];
      }
    } catch {
      // Ignore if static deployment
    }
    return [];
  }
  return data as IncidentRecord[];
}

export async function verifyBlackboxChain(): Promise<LedgerVerification> {
  const { data, error } = await supabase.rpc('dms9_verify_ledger');
  if (error || !data) {
    try {
      const localRes = await fetch('/api/ledger/verify');
      if (localRes.ok) {
        const localVerify = await localRes.json();
        if (typeof localVerify?.valid === 'boolean') {
          return {
            ...localVerify,
            engine: localVerify.engine || 'Local SQLite SHA-256 Edge Ledger',
          } as LedgerVerification;
        }
      }
    } catch {
      // Ignore if static deployment
    }
    return {
      valid: false,
      checkedCount: 0,
      brokenAtSeq: null,
      brokenId: null,
      reason: error?.message || 'RPC_UNREACHABLE',
      headHash: '0'.repeat(64),
      genesisHash: '0'.repeat(64),
      durationMs: 0,
      engine: 'Supabase PostgreSQL 17 pgcrypto',
    };
  }
  return data as LedgerVerification;
}

export async function analyzeTelemetryLogCloud(params: {
  content: string;
  format?: string;
  persistIncidents?: boolean;
  sessionId?: string | null;
}): Promise<AnalyzedTelemetryReport> {
  const res = await fetch(SUPABASE_EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: 'Telemetry analysis request failed' }));
    throw new Error(errBody.error || `Edge Function HTTP ${res.status}`);
  }
  return (await res.json()) as AnalyzedTelemetryReport;
}

let activeBusChannel: RealtimeChannel | null = null;

export async function broadcastEmergencySos(payload: {
  requestId?: string;
  fromCloudClient?: boolean;
  driverTag?: string;
  dialNumber: string;
  reason: string;
  speedKmh: number;
  lat: number | null;
  lon: number | null;
  frameEvidence?: string | null;
}): Promise<void> {
  try {
    const body = { ...payload, timestampMs: Date.now() };
    if (activeBusChannel) {
      await activeBusChannel.send({
        type: 'broadcast',
        event: 'emergency_sos',
        payload: body,
      });
      return;
    }
    const ch = supabase.channel('dms9-telemetry-bus-oneshot');
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.send({
          type: 'broadcast',
          event: 'emergency_sos',
          payload: body,
        });
        setTimeout(() => {
          supabase.removeChannel(ch).catch(() => {});
        }, 1200);
      }
    });
  } catch {
    // Ignore broadcast error if offline
  }
}

export function pingCloudWhatsAppBridge(): void {
  if (!activeBusChannel) return;
  activeBusChannel
    .send({
      type: 'broadcast',
      event: 'whatsapp_status_ping',
      payload: { t: Date.now() },
    })
    .catch(() => {});
}

export function createRealtimeTelemetryBus(handlers: {
  onSensorFrame?: (frame: Record<string, unknown>) => void;
  onIncidentInsert?: (incident: IncidentRecord) => void;
  onSessionChange?: (session: SessionRecord) => void;
  onWhatsAppBridgeStatus?: (status: { state: string; connectedUser: string | null }) => void;
  onEmergencySosAck?: (ack: { requestId?: string; ok: boolean; message: string }) => void;
}): RealtimeChannel {
  const channel = supabase
    .channel('dms9-telemetry-bus', {
      config: { broadcast: { self: false } },
    })
    .on('broadcast', { event: 'sensor_frame' }, (msg) => {
      if (msg.payload && handlers.onSensorFrame) {
        handlers.onSensorFrame(msg.payload as Record<string, unknown>);
      }
    })
    .on('broadcast', { event: 'whatsapp_status_pong' }, (msg) => {
      if (msg.payload && handlers.onWhatsAppBridgeStatus) {
        handlers.onWhatsAppBridgeStatus(
          msg.payload as { state: string; connectedUser: string | null }
        );
      }
    })
    .on('broadcast', { event: 'emergency_sos_ack' }, (msg) => {
      if (msg.payload && handlers.onEmergencySosAck) {
        handlers.onEmergencySosAck(
          msg.payload as { requestId?: string; ok: boolean; message: string }
        );
      }
    })
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'dms9_incidents' },
      (payload) => {
        if (payload.new && handlers.onIncidentInsert) {
          handlers.onIncidentInsert(payload.new as IncidentRecord);
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'dms9_sessions' },
      (payload) => {
        if (payload.new && handlers.onSessionChange) {
          handlers.onSessionChange(payload.new as SessionRecord);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        activeBusChannel = channel;
        pingCloudWhatsAppBridge();
      }
    });

  activeBusChannel = channel;
  return channel;
}
