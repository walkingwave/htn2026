import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import simdLoader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import simdBinary from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import plainLoader from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import plainBinary from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';

const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function createHandLandmarker() {
  // Bundle the runtime from the installed SDK so its JS/Wasm versions match.
  const simd = await FilesetResolver.isSimdSupported();
  const files = {
    wasmLoaderPath: simd ? simdLoader : plainLoader,
    wasmBinaryPath: simd ? simdBinary : plainBinary,
  };
  const options = {
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
  };
  try {
    return await HandLandmarker.createFromOptions(files, {
      ...options, baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
    });
  } catch {
    return HandLandmarker.createFromOptions(files, {
      ...options, baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
    });
  }
}
