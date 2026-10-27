// Copies MediaPipe wasm into the renderer's public folder and downloads the models the sprite maker uses (the person cut-out and the
// face finder), so turning a photo into a sticker works offline and nothing is loaded from the web at run time.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'src/renderer/public/mediapipe/wasm');
const modelDst = join(root, 'src/renderer/public/mediapipe/face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// The person cut-out model (250 KB) that turns a photo into a sticker for the custom sprite.
const SEG_DST = join(root, 'src/renderer/public/mediapipe/selfie_segmenter.tflite');
const SEG_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

mkdirSync(wasmDst, { recursive: true });
for (const f of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, f), join(wasmDst, f));
console.log('copied mediapipe wasm');

if (!existsSync(modelDst)) {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()));
  console.log('downloaded face_landmarker.task');
}

if (!existsSync(SEG_DST)) {
  const res = await fetch(SEG_URL);
  if (!res.ok) throw new Error(`segmentation model download failed: ${res.status}`);
  writeFileSync(SEG_DST, Buffer.from(await res.arrayBuffer()));
  console.log('downloaded selfie_segmenter.tflite');
}

