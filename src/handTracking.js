import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function startHandTracking(onPose, onStatus = () => {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser.');
  const video = document.createElement('video');
  video.autoplay = true; video.muted = true; video.playsInline = true;
  video.style.cssText = 'position:fixed;right:18px;bottom:18px;width:150px;border:1px solid #ffffff44;border-radius:10px;z-index:4;transform:scaleX(-1);opacity:.8';
  document.body.appendChild(video);
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 960, height: 720 }, audio: false });
  video.srcObject = stream; await video.play(); onStatus('Loading hand model…');
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const landmarker = await HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: .55, minHandPresenceConfidence: .55, minTrackingConfidence: .55 });
  let frame = 0; let stopped = false; onStatus('Live hand tracking · move your racket hand');
  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2) {
      const result = landmarker.detectForVideo(video, performance.now()); const hand = result.landmarks?.[0];
      if (hand) { const wrist = hand[0]; const index = hand[8]; onPose({ x: (wrist.x + index.x) / 2, y: (wrist.y + index.y) / 2, angle: Math.atan2(index.y - wrist.y, index.x - wrist.x) }); }
    }
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
  return () => { stopped = true; cancelAnimationFrame(frame); stream.getTracks().forEach((track) => track.stop()); landmarker.close(); video.remove(); onStatus('Camera CV stopped'); };
}
