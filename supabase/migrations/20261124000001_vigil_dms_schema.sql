-- Vigil DMS — Supabase PostgreSQL 17 Schema & Cryptographic SHA-256 Incident Chain
-- Isolated under dms9_* namespace with append-only Row Level Security

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.dms9_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dms9_sessions (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  driver_tag text NOT NULL DEFAULT 'Driver-01',
  vehicle_profile text NOT NULL DEFAULT 'PASSENGER_SEDAN',
  source_modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  distance_km double precision NOT NULL DEFAULT 0,
  peak_speed_kmh double precision NOT NULL DEFAULT 0,
  peak_long_g double precision NOT NULL DEFAULT 0,
  peak_lat_g double precision NOT NULL DEFAULT 0,
  min_ear double precision,
  peak_perclos double precision NOT NULL DEFAULT 0,
  total_blinks integer NOT NULL DEFAULT 0,
  total_yawns integer NOT NULL DEFAULT 0,
  incident_count integer NOT NULL DEFAULT 0,
  safety_index double precision NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS public.dms9_incidents (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text UNIQUE NOT NULL,
  session_id text REFERENCES public.dms9_sessions(id),
  timestamp_iso text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('ADVISORY', 'WARNING', 'CRITICAL')),
  stage integer NOT NULL CHECK (stage BETWEEN 1 AND 3),
  summary text NOT NULL,
  intervention_action text NOT NULL,
  metrics_json text NOT NULL DEFAULT '{}',
  frame_evidence text,
  prev_hash text NOT NULL DEFAULT repeat('0', 64),
  entry_hash text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_dms9_incidents_session ON public.dms9_incidents(session_id);
CREATE INDEX IF NOT EXISTS idx_dms9_incidents_seq_desc ON public.dms9_incidents(seq DESC);

CREATE OR REPLACE FUNCTION public.dms9_chain_incident_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_prev text;
  v_canonical text;
  v_penalty numeric;
BEGIN
  LOCK TABLE public.dms9_incidents IN SHARE ROW EXCLUSIVE MODE;

  SELECT entry_hash INTO v_prev
  FROM public.dms9_incidents
  ORDER BY seq DESC
  LIMIT 1;

  IF v_prev IS NULL THEN
    v_prev := repeat('0', 64);
  END IF;

  NEW.prev_hash := v_prev;

  v_canonical := v_prev || '|' ||
                 NEW.id || '|' ||
                 COALESCE(NEW.session_id, 'UNBOUND') || '|' ||
                 NEW.timestamp_iso || '|' ||
                 NEW.category || '|' ||
                 NEW.severity || '|' ||
                 NEW.stage::text || '|' ||
                 NEW.summary || '|' ||
                 NEW.intervention_action || '|' ||
                 COALESCE(NEW.metrics_json, '{}');

  NEW.entry_hash := encode(extensions.digest(convert_to(v_canonical, 'UTF8'), 'sha256'), 'hex');

  IF NEW.session_id IS NOT NULL THEN
    v_penalty := CASE WHEN NEW.stage >= 3 THEN 12 WHEN NEW.stage = 2 THEN 5 ELSE 2 END;
    UPDATE public.dms9_sessions
    SET incident_count = incident_count + 1,
        safety_index = GREATEST(0, safety_index - v_penalty)
    WHERE id = NEW.session_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dms9_chain_incident_hash() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_dms9_chain_incident_hash'
  ) THEN
    CREATE TRIGGER trg_dms9_chain_incident_hash
    BEFORE INSERT ON public.dms9_incidents
    FOR EACH ROW
    EXECUTE FUNCTION public.dms9_chain_incident_hash();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dms9_verify_ledger()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  r RECORD;
  v_expected_prev text := repeat('0', 64);
  v_recomputed text;
  v_canonical text;
  v_count integer := 0;
  v_t0 timestamptz := clock_timestamp();
  v_head text := repeat('0', 64);
BEGIN
  SELECT COALESCE(
    (SELECT entry_hash FROM public.dms9_incidents ORDER BY seq DESC LIMIT 1),
    repeat('0', 64)
  ) INTO v_head;

  FOR r IN SELECT * FROM public.dms9_incidents ORDER BY seq ASC LOOP
    v_count := v_count + 1;

    IF r.prev_hash <> v_expected_prev THEN
      RETURN jsonb_build_object(
        'valid', false,
        'checkedCount', v_count,
        'brokenAtSeq', r.seq,
        'brokenId', r.id,
        'reason', 'PREV_HASH_MISMATCH',
        'headHash', v_head,
        'genesisHash', repeat('0', 64),
        'durationMs', round((EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::numeric, 3),
        'engine', 'Supabase PostgreSQL 17 pgcrypto'
      );
    END IF;

    v_canonical := r.prev_hash || '|' ||
                   r.id || '|' ||
                   COALESCE(r.session_id, 'UNBOUND') || '|' ||
                   r.timestamp_iso || '|' ||
                   r.category || '|' ||
                   r.severity || '|' ||
                   r.stage::text || '|' ||
                   r.summary || '|' ||
                   r.intervention_action || '|' ||
                   COALESCE(r.metrics_json, '{}');

    v_recomputed := encode(extensions.digest(convert_to(v_canonical, 'UTF8'), 'sha256'), 'hex');

    IF v_recomputed <> r.entry_hash THEN
      RETURN jsonb_build_object(
        'valid', false,
        'checkedCount', v_count,
        'brokenAtSeq', r.seq,
        'brokenId', r.id,
        'reason', 'ENTRY_HASH_TAMPERED',
        'headHash', v_head,
        'genesisHash', repeat('0', 64),
        'durationMs', round((EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::numeric, 3),
        'engine', 'Supabase PostgreSQL 17 pgcrypto'
      );
    END IF;

    v_expected_prev := r.entry_hash;
  END LOOP;

  RETURN jsonb_build_object(
    'valid', true,
    'checkedCount', v_count,
    'brokenAtSeq', null,
    'brokenId', null,
    'reason', null,
    'headHash', v_expected_prev,
    'genesisHash', repeat('0', 64),
    'durationMs', round((EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::numeric, 3),
    'engine', 'Supabase PostgreSQL 17 pgcrypto'
  );
END;
$$;

ALTER TABLE public.dms9_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dms9_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dms9_incidents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_config' AND policyname = 'dms9_config_read') THEN
    CREATE POLICY "dms9_config_read" ON public.dms9_config FOR SELECT TO anon, authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_config' AND policyname = 'dms9_config_write') THEN
    CREATE POLICY "dms9_config_write" ON public.dms9_config FOR INSERT TO anon, authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_config' AND policyname = 'dms9_config_update') THEN
    CREATE POLICY "dms9_config_update" ON public.dms9_config FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_sessions' AND policyname = 'dms9_sessions_select') THEN
    CREATE POLICY "dms9_sessions_select" ON public.dms9_sessions FOR SELECT TO anon, authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_sessions' AND policyname = 'dms9_sessions_insert') THEN
    CREATE POLICY "dms9_sessions_insert" ON public.dms9_sessions FOR INSERT TO anon, authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_sessions' AND policyname = 'dms9_sessions_update') THEN
    CREATE POLICY "dms9_sessions_update" ON public.dms9_sessions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
  END IF;

  -- Append-only tamper-evident RLS on incidents (SELECT + INSERT only)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_incidents' AND policyname = 'dms9_incidents_select') THEN
    CREATE POLICY "dms9_incidents_select" ON public.dms9_incidents FOR SELECT TO anon, authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dms9_incidents' AND policyname = 'dms9_incidents_insert') THEN
    CREATE POLICY "dms9_incidents_insert" ON public.dms9_incidents FOR INSERT TO anon, authenticated WITH CHECK (true);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dms9_verify_ledger() TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'dms9_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.dms9_sessions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'dms9_incidents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.dms9_incidents;
  END IF;
END;
$$;
