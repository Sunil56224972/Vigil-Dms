import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WA_AUTH_DIR = path.resolve(__dirname, '..', 'data', 'wa_auth');

let sock = null;
let statusState = 'IDLE'; // 'IDLE' | 'CONNECTING' | 'QR_READY' | 'CONNECTED'
let latestQrDataUrl = null;
let latestPairingCode = null;
let connectedUser = null;
let lastError = null;
let reconnectTimer = null;
let onStatusChangeCb = null;

function notifyStatus() {
  if (typeof onStatusChangeCb === 'function') {
    try {
      onStatusChangeCb(getWhatsAppStatus());
    } catch {}
  }
}

export function setWhatsAppStatusListener(cb) {
  onStatusChangeCb = cb;
}

export function getWhatsAppStatus() {
  return {
    state: statusState,
    qrDataUrl: latestQrDataUrl,
    pairingCode: latestPairingCode,
    connectedUser,
    lastError,
  };
}

export function hasSavedWhatsAppSession() {
  try {
    return fs.existsSync(path.join(WA_AUTH_DIR, 'creds.json'));
  } catch {
    return false;
  }
}

export async function startWhatsAppLink({ phoneForPairingCode = '', usePairingCode = false } = {}) {
  if (statusState === 'CONNECTED' && sock) {
    return getWhatsAppStatus();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
  statusState = 'CONNECTING';
  lastError = null;
  latestPairingCode = null;
  notifyStatus();

  try {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;
    const pinoMod = await import('pino');
    const pino = pinoMod.default || pinoMod;

    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try {
      const vInfo = await fetchLatestBaileysVersion();
      if (vInfo?.version) version = vInfo.version;
    } catch {}

    if (sock) {
      try {
        sock.end(undefined);
      } catch {}
      sock = null;
    }

    // WhatsApp requires official Ubuntu/Chrome browser tuple for pairing codes & multi-device linking
    const browserTuple = Browsers?.ubuntu ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'];

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: browserTuple,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    const cleanPairDigits = String(phoneForPairingCode || '').replace(/\D/g, '');
    const pairTarget =
      cleanPairDigits.length === 10
        ? `91${cleanPairDigits}`
        : cleanPairDigits.length >= 11
        ? cleanPairDigits
        : '';

    let requestedCode = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        statusState = 'QR_READY';
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, {
            margin: 1,
            width: 240,
            color: { dark: '#141413', light: '#ffffff' },
          });
        } catch {}

        if (usePairingCode && pairTarget && !state.creds.registered && !requestedCode) {
          requestedCode = true;
          setTimeout(async () => {
            try {
              if (sock && !state.creds.registered) {
                const code = await sock.requestPairingCode(pairTarget);
                if (code) {
                  latestPairingCode = code.match(/.{1,4}/g)?.join('-') || code;
                  notifyStatus();
                }
              }
            } catch {
              // QR remains available
            }
          }, 1500);
        }
        notifyStatus();
      }

      if (connection === 'open') {
        statusState = 'CONNECTED';
        latestQrDataUrl = null;
        latestPairingCode = null;
        lastError = null;
        const rawId = sock?.user?.id || '';
        connectedUser = rawId.split(':')[0].split('@')[0] || 'Linked';
        notifyStatus();
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        if (loggedOut) {
          statusState = 'IDLE';
          connectedUser = null;
          latestQrDataUrl = null;
          latestPairingCode = null;
          sock = null;
          try {
            fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
          } catch {}
          notifyStatus();
        } else {
          // Auto-reconnect on 515 restartRequired right after QR scan or transient drops
          statusState = 'CONNECTING';
          notifyStatus();
          reconnectTimer = setTimeout(() => {
            startWhatsAppLink({}).catch(() => {});
          }, 1200);
        }
      }
    });

    return getWhatsAppStatus();
  } catch (err) {
    statusState = 'IDLE';
    lastError = err instanceof Error ? err.message : 'WhatsApp initialization failed';
    notifyStatus();
    return getWhatsAppStatus();
  }
}

export async function disconnectWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try {
      await sock.logout();
    } catch {}
    try {
      sock.end(undefined);
    } catch {}
    sock = null;
  }
  try {
    fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
  } catch {}
  statusState = 'IDLE';
  connectedUser = null;
  latestQrDataUrl = null;
  latestPairingCode = null;
  lastError = null;
  notifyStatus();
  return getWhatsAppStatus();
}

export async function sendWhatsAppEmergency({ phone, text, frameEvidence, lat, lon }) {
  if (!sock || statusState !== 'CONNECTED') {
    return { sent: false, reason: 'WHATSAPP_NOT_CONNECTED' };
  }

  const rawDigits = String(phone || '7389416622').replace(/\D/g, '');
  const fullDigits =
    rawDigits.length === 10 ? `91${rawDigits}` : rawDigits || '917389416622';

  let jid = `${fullDigits}@s.whatsapp.net`;
  try {
    const [exists] = await sock.onWhatsApp(fullDigits);
    if (exists?.jid) {
      jid = exists.jid;
    }
  } catch {}

  try {
    if (frameEvidence && typeof frameEvidence === 'string' && frameEvidence.includes('base64,')) {
      const b64 = frameEvidence.split('base64,')[1];
      const imgBuf = Buffer.from(b64, 'base64');
      await sock.sendMessage(jid, {
        image: imgBuf,
        caption: text,
      });
    } else {
      await sock.sendMessage(jid, { text });
    }

    if (lat != null && lon != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lon))) {
      await sock
        .sendMessage(jid, {
          location: {
            degreesLatitude: Number(lat),
            degreesLongitude: Number(lon),
            name: 'Vigil DMS Emergency SOS Location',
          },
        })
        .catch(() => {});
    }

    return { sent: true, jid };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : 'WhatsApp send error',
    };
  }
}
