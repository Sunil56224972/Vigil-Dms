import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WASM_SRC = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DEST = path.join(ROOT, 'public', 'wasm');
const MODEL_DIR = path.join(ROOT, 'public', 'models');
const MODEL_DEST = path.join(MODEL_DIR, 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

function copyWasmAssets() {
  if (!fs.existsSync(WASM_SRC)) {
    console.warn('[prepare-assets] @mediapipe/tasks-vision not found yet; skipping WASM copy.');
    return;
  }
  fs.mkdirSync(WASM_DEST, { recursive: true });
  for (const file of fs.readdirSync(WASM_SRC)) {
    fs.copyFileSync(path.join(WASM_SRC, file), path.join(WASM_DEST, file));
  }
  console.log('[prepare-assets] Synced MediaPipe WASM runtime to public/wasm/');
}

async function downloadModelIfMissing() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  if (fs.existsSync(MODEL_DEST) && fs.statSync(MODEL_DEST).size > 1_000_000) {
    console.log('[prepare-assets] Local face_landmarker.task verified.');
    return;
  }

  console.log('[prepare-assets] Downloading face_landmarker.task...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching MediaPipe model`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(MODEL_DEST, buf);
  console.log(`[prepare-assets] Saved face_landmarker.task (${buf.length} bytes).`);
}

copyWasmAssets();
await downloadModelIfMissing();
