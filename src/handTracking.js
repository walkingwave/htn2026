const FRAME_INTERVAL_MS = 1000 / 30;
const LOST_AFTER_MS = 250;

async function loadLandmarker() {
  const { createHandLandmarker } = await import('./vision/handLandmarker.js');
  return createHandLandmarker();
}

export async function startHandTracking(onPose, onStatus = () => {}, {
  signal,
  onError = () => {},
  createLandmarker = loadLandmarker,
} = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser.');
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('aria-label', 'Hand tracking camera preview');
  video.style.cssText = 'position:fixed;right:18px;bottom:54px;width:150px;border:1px solid #ffffff44;border-radius:10px;z-index:4;transform:scaleX(-1);opacity:.8;pointer-events:none';
  let stream = null;
  let landmarker = null;
  let frame = null;
  let stopped = false;
  let lastVideoTime = -1;
  let lastInferenceAt = -Infinity;
  let lastSeenAt = -Infinity;
  let tracked = false;
  let status = '';

  const notify = (message) => {
    if (message === status || stopped) return;
    status = message;
    onStatus(message);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
    video.remove();
    landmarker?.close();
    signal?.removeEventListener('abort', stop);
  };
  const loseHand = () => {
    if (tracked) onPose(null);
    tracked = false;
    notify('Show an open hand to the camera');
  };
  const fail = (error) => {
    if (stopped) return;
    stop();
    onError(error);
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) { stop(); return stop; }

  try {
    notify('Starting hand camera…');
    const openedStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    if (stopped) { openedStream.getTracks().forEach((track) => track.stop()); return stop; }
    stream = openedStream;
    stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => fail(new Error('Hand camera disconnected')), { once: true }));
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    if (stopped) return stop;
    notify('Loading hand tracking…');
    const loadedLandmarker = await createLandmarker();
    if (stopped) { loadedLandmarker.close(); return stop; }
    landmarker = loadedLandmarker;
    notify('Show an open hand to the camera');

    const loop = (now) => {
      if (stopped) return;
      try {
        // Inference is synchronous: cap it at 30 Hz and never run it twice on
        // one video frame. The renderer continues using the latest hand pose.
        if (video.readyState >= 2 && video.currentTime !== lastVideoTime
          && now - lastInferenceAt >= FRAME_INTERVAL_MS - 1) {
          lastVideoTime = video.currentTime;
          lastInferenceAt = now;
          const result = landmarker.detectForVideo(video, now);
          const landmarks = result.landmarks?.[0];
          const worldLandmarks = result.worldLandmarks?.[0];
          if (landmarks && worldLandmarks) {
            lastSeenAt = now;
            tracked = true;
            onPose({
              landmarks, worldLandmarks,
              handedness: result.handedness?.[0]?.[0]?.categoryName,
              aspect: video.videoWidth / video.videoHeight,
              timestamp: now,
            });
            notify('Hand tracking live — C to recenter');
          } else {
            loseHand();
          }
        } else if (tracked && now - lastSeenAt > LOST_AFTER_MS) {
          loseHand();
        }
      } catch (error) {
        fail(error);
        return;
      }
      if (!stopped) frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return stop;
  } catch (error) {
    if (stopped) return stop;
    stop();
    throw error;
  }
}
