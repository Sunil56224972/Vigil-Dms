function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeE164(raw, fallback = '+917389416622') {
  const trimmed = String(raw || '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return fallback;
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export async function dispatchTwilioVoiceCall({
  to,
  reason,
  speedKmh,
  lat,
  lon,
  twilioSid,
  twilioToken,
  twilioFrom,
}) {
  const accountSid = String(twilioSid || process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(twilioToken || process.env.TWILIO_AUTH_TOKEN || '').trim();
  const fromRaw = String(twilioFrom || process.env.TWILIO_FROM_NUMBER || '').trim();

  const dialTo = normalizeE164(to, '+917389416622');

  if (!accountSid || !authToken || !fromRaw) {
    return {
      ok: true,
      pstnDispatched: false,
      status: 'NO_GATEWAY',
      to: dialTo,
      message:
        'No Cloud PSTN credentials configured yet. Add Twilio Account SID, Auth Token & From Number in Cloud Call Setup (or Vercel env vars) to ring mobile phones directly from a PC.',
    };
  }

  const dialFrom = normalizeE164(fromRaw, fromRaw);
  const cleanReason = escapeXml(reason || 'Critical driver microsleep emergency');
  const speedPart =
    speedKmh != null && Number(speedKmh) > 0
      ? ` Vehicle speed ${Math.round(Number(speedKmh))} kilometers per hour.`
      : '';
  const gpsPart =
    lat != null && lon != null
      ? ` Last known G P S coordinates: latitude ${Number(lat).toFixed(4)}, longitude ${Number(lon).toFixed(4)}.`
      : '';

  const twiml = `<Response><Say voice="alice">Emergency S O S alert from Vigil Driver Monitoring System. ${cleanReason}.${speedPart}${gpsPart} Please contact the driver immediately.</Say><Pause length="1"/><Say voice="alice">Repeating emergency alert from Vigil D M S. Driver requires immediate assistance.</Say></Response>`;

  const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const form = new URLSearchParams();
  form.set('To', dialTo);
  form.set('From', dialFrom);
  form.set('Twiml', twiml);

  const twilioRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }
  );

  const data = await twilioRes.json().catch(() => ({}));
  if (!twilioRes.ok) {
    return {
      ok: false,
      pstnDispatched: false,
      status: 'FAILED',
      to: dialTo,
      message: data?.message || `Twilio HTTP ${twilioRes.status}: Unable to place PSTN voice call.`,
      code: data?.code || twilioRes.status,
    };
  }

  return {
    ok: true,
    pstnDispatched: true,
    status: 'RINGING',
    callSid: data.sid,
    twilioStatus: data.status,
    to: dialTo,
    from: dialFrom,
    message: `Real PSTN voice call placed to ${dialTo} (SID: ${String(data.sid).slice(0, 14)}…)`,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const result = await dispatchTwilioVoiceCall({
      to: body.phone || body.to || '7389416622',
      reason: body.reason,
      speedKmh: body.speedKmh,
      lat: body.lat,
      lon: body.lon,
      twilioSid: body.twilioSid,
      twilioToken: body.twilioToken,
      twilioFrom: body.twilioFrom,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      pstnDispatched: false,
      status: 'FAILED',
      message: err instanceof Error ? err.message : 'Serverless PSTN call error',
    });
  }
}
