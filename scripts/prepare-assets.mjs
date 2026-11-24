import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
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

function downloadModelIfMissing() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  if (fs.existsSync(MODEL_DEST) && fs.statSync(MODEL_DEST).size > 1_000_000) {
    console.log('[prepare-assets] Local face_landmarker.task verified.');
    return Promise.resolve();
  }

  console.log('[prepare-assets] Downloading face_landmarker.task...');
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(MODEL_DEST);
    https
      .get(MODEL_URL, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.rmSync(MODEL_DEST, { force: true });
          reject(new Error(`HTTP ${res.statusCode} fetching model`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('[prepare-assets] Downloaded face_landmarker.task to public/models/');
          resolve();
        });
      })
      .on('error', (err) => {
        file.close();
        fs.rmSync(MODEL_DEST, { force: true });
        reject(err);
      });
  });
}

copyWasmAssets();
await downloadModelIfMissing();
