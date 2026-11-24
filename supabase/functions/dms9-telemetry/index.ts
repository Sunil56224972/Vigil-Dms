import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const { data: ledger } = await supabase.rpc("dms9_verify_ledger");
      const { count: sessionCount } = await supabase
        .from("dms9_sessions")
        .select("*", { count: "exact", head: true });
      const { count: incidentCount } = await supabase
        .from("dms9_incidents")
        .select("*", { count: "exact", head: true });

      return new Response(
        JSON.stringify({
          ok: true,
          service: "Vigil DMS Cloud Edge Engine",
          region: Deno.env.get("SB_REGION") || "ap-south-1",
          sessionCount: sessionCount ?? 0,
          incidentCount: incidentCount ?? 0,
          ledger,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (req.method === "POST" && url.pathname.endsWith("/ingest")) {
      const body = await req.json();
      const frame = {
        source: body.source || "SUPABASE_CLOUD_INGEST",
        nodeId: body.nodeId || "EXT-BUS-01",
        timestampMs: Number(body.timestampMs || Date.now()),
        speedKmh: body.speedKmh != null ? Number(body.speedKmh) : null,
        accelLongMs2: Number(body.accelLongMs2 ?? 0),
        accelLatMs2: Number(body.accelLatMs2 ?? 0),
        yawRateDegS: Number(body.yawRateDegS ?? 0),
        rpm: body.rpm != null ? Number(body.rpm) : null,
        throttlePct: body.throttlePct != null ? Number(body.throttlePct) : null,
        brakePct: body.brakePct != null ? Number(body.brakePct) : null,
        lat: body.lat != null ? Number(body.lat) : null,
        lon: body.lon != null ? Number(body.lon) : null,
      };

      const channel = supabase.channel("dms9-telemetry-bus");
      await channel.send({
        type: "broadcast",
        event: "sensor_frame",
        payload: frame,
      });
      await supabase.removeChannel(channel);

      return new Response(JSON.stringify({ ok: true, relayedFrame: frame }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: "See server/kinematics.mjs for full CSV/JSON batch pipeline." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Edge execution error" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
