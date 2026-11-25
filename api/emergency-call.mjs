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

export function buildEmergencyMessageText({ to, driverTag, reason, speedKmh, lat, lon }) {
  const cleanReason = String(reason || 'Unresponsive driver / microsleep alert').trim();
  const speedStr = `${Math.round(Number(speedKmh || 0))} km/h`;
  const hasGps = lat != null && lon != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lon));
  const mapsUrl = hasGps
    ? `https://maps.google.com/?q=${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`
    : null;
  const timeStr = new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return [
    `[VIGIL DMS EMERGENCY SOS]`,
    `Driver: ${driverTag || 'Operator-01'} (${to})`,
    `Alert: ${cleanReason}`,
    `Speed: ${speedStr} | Time: ${timeStr} IST`,
    mapsUrl ? `Live GPS Location: ${mapsUrl}` : `GPS: Acquiring fix`,
    `Immediate safety check required.`,
  ].join('\n');
}

export async function dispatchEmergencyCommunications({
  to,
  driverTag,
  reason,
  speedKmh,
  lat,
  lon,
  twilioSid,
  twilioToken,
  twilioFrom,
  fast2smsKey,
  callmebotKey,
}) {
  const dialTo = normalizeE164(to, '+917389416622');
  const digitsOnly = dialTo.replace(/\D/g, '');
  const digits10 = digitsOnly.slice(-10) || '7389416622';

  const accountSid = String(twilioSid || process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(twilioToken || process.env.TWILIO_AUTH_TOKEN || '').trim();
  const fromRaw = String(twilioFrom || process.env.TWILIO_FROM_NUMBER || '').trim();
  const f2sKey = String(fast2smsKey || process.env.FAST2SMS_API_KEY || '').trim();
  const cmbKey = String(callmebotKey || process.env.CALLMEBOT_API_KEY || '').trim();

  const smsText = buildEmergencyMessageText({
    to: dialTo,
    driverTag,
    reason,
    speedKmh,
    lat,
    lon,
  });

  const hasGps = lat != null && lon != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lon));
  const mapsUrl = hasGps
    ? `https://maps.google.com/?q=${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`
    : null;

  const channelsSent = [];
  const channelErrors = [];
  let callSid = null;

  // 1. Always dispatch instant zero-key mobile push message via ntfy.sh topic `vigil-sos-<10digits>`
  const ntfyTopic = `vigil-sos-${digits10}`;
  try {
    const ntfyHeaders = {
      Title: `VIGIL DMS SOS: ${reason || 'Critical Driver Alert'}`,
      Priority: '5',
      Tags: 'rotating_light,sos',
    };
    if (mapsUrl) {
      ntfyHeaders.Click = mapsUrl;
    }
    const ntfyRes = await fetch(`https://ntfy.sh/${ntfyTopic}`, {
      method: 'POST',
      headers: ntfyHeaders,
      body: smsText,
    });
    if (ntfyRes.ok) {
      channelsSent.push(`Push (${ntfyTopic})`);
    }
  } catch {
    // Non-fatal if offline/sandboxed
  }

  // 2. CallMeBot Free Automatic WhatsApp Message (if API key configured)
  if (cmbKey) {
    try {
      const cmbUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(
        digitsOnly
      )}&text=${encodeURIComponent(smsText)}&apikey=${encodeURIComponent(cmbKey)}`;
      const cmbRes = await fetch(cmbUrl, { method: 'GET' });
      const cmbBody = await cmbRes.text().catch(() => '');
      if (cmbRes.ok && !cmbBody.toLowerCase().includes('apikey is invalid')) {
        channelsSent.push('WhatsApp Auto-Msg');
      } else {
        channelErrors.push('CallMeBot WhatsApp: invalid key or unactivated');
      }
    } catch (err) {
      channelErrors.push(`CallMeBot: ${err instanceof Error ? err.message : 'network error'}`);
    }
  }

  // 3. Fast2SMS Automatic Indian Cellular SMS (+91)
  if (f2sKey) {
    try {
      const f2sRes = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          authorization: f2sKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          route: 'q',
          message: smsText,
          language: 'english',
          flash: 0,
          numbers: digits10,
        }),
      });
      const f2sData = await f2sRes.json().catch(() => ({}));
      if (f2sRes.ok && f2sData?.return === true) {
        channelsSent.push('Fast2SMS (+91)');
      } else {
        channelErrors.push(f2sData?.message || `Fast2SMS HTTP ${f2sRes.status}`);
      }
    } catch (err) {
      channelErrors.push(`Fast2SMS: ${err instanceof Error ? err.message : 'network error'}`);
    }
  }

  // 4. Twilio Automatic Cellular SMS + PSTN Voice Call
  if (accountSid && authToken && fromRaw) {
    const dialFrom = normalizeE164(fromRaw, fromRaw);
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    // 4a. Automatic Twilio SMS (`Messages.json`)
    try {
      const smsForm = new URLSearchParams();
      smsForm.set('To', dialTo);
      smsForm.set('From', dialFrom);
      smsForm.set('Body', smsText);
      const smsRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: smsForm.toString(),
        }
      );
      const smsData = await smsRes.json().catch(() => ({}));
      if (smsRes.ok) {
        channelsSent.push('Twilio SMS');
      } else if (smsData?.message) {
        channelErrors.push(`Twilio SMS: ${smsData.message}`);
      }
    } catch (err) {
      channelErrors.push(`Twilio SMS: ${err instanceof Error ? err.message : 'error'}`);
    }

    // 4b. Automatic Twilio PSTN Voice Call (`Calls.json`)
    try {
      const cleanReason = escapeXml(reason || 'Critical driver microsleep emergency');
      const speedPart =
        speedKmh != null && Number(speedKmh) > 0
          ? ` Vehicle speed ${Math.round(Number(speedKmh))} kilometers per hour.`
          : '';
      const gpsPart = hasGps
        ? ` Last known G P S coordinates: latitude ${Number(lat).toFixed(4)}, longitude ${Number(lon).toFixed(4)}.`
        : '';

      const twiml = `<Response><Say voice="alice">Emergency S O S alert from Vigil Driver Monitoring System. ${cleanReason}.${speedPart}${gpsPart} Emergency message with live map link has also been sent. Please contact the driver immediately.</Say></Response>`;

      const callForm = new URLSearchParams();
      callForm.set('To', dialTo);
      callForm.set('From', dialFrom);
      callForm.set('Twiml', twiml);

      const callRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
        {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: callForm.toString(),
        }
      );
      const callData = await callRes.json().catch(() => ({}));
      if (callRes.ok) {
        callSid = callData.sid || null;
        channelsSent.push('Twilio Voice Call');
      } else if (callData?.message) {
        channelErrors.push(`Twilio Voice: ${callData.message}`);
      }
    } catch (err) {
      channelErrors.push(`Twilio Voice: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  const directCarrierSent = channelsSent.some(
    (c) => c.includes('SMS') || c.includes('WhatsApp') || c.includes('Voice')
  );

  let status = 'NO_GATEWAY';
  let message = '';

  if (directCarrierSent) {
    status = 'RINGING';
    message = `Auto-dispatched to ${dialTo} via: ${channelsSent.join(' + ')}`;
  } else if (channelErrors.length > 0) {
    status = 'FAILED';
    message = `${channelErrors.join(' | ')}${
      channelsSent.length ? ` (Push sent to ntfy.sh/${ntfyTopic})` : ''
    }`;
  } else {
    status = 'NO_GATEWAY';
    message =
      channelsSent.length > 0
        ? `Instant push alert sent to ntfy.sh/${ntfyTopic}. Add CallMeBot / Fast2SMS / Twilio key in Auto-Msg Setup for direct WhatsApp/SMS.`
        : `Add CallMeBot (free WhatsApp), Fast2SMS, or Twilio key in Auto-Msg Setup for silent background SMS/WhatsApp to ${dialTo}.`;
  }

  return {
    ok: status !== 'FAILED',
    pstnDispatched: directCarrierSent,
    channelsSent,
    ntfyTopic,
    ntfyUrl: `https://ntfy.sh/${ntfyTopic}`,
    status,
    callSid,
    to: dialTo,
    smsText,
    message,
  };
}

// Backward-compatible export alias
export const dispatchTwilioVoiceCall = dispatchEmergencyCommunications;

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
    const result = await dispatchEmergencyCommunications({
      to: body.phone || body.to || '7389416622',
      driverTag: body.driverTag,
      reason: body.reason,
      speedKmh: body.speedKmh,
      lat: body.lat,
      lon: body.lon,
      twilioSid: body.twilioSid,
      twilioToken: body.twilioToken,
      twilioFrom: body.twilioFrom,
      fast2smsKey: body.fast2smsKey,
      callmebotKey: body.callmebotKey,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      pstnDispatched: false,
      status: 'FAILED',
      message: err instanceof Error ? err.message : 'Serverless SOS dispatch error',
    });
  }
}
