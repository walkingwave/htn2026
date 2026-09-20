// Marker-based tracking of a real ping pong paddle through a webcam.
//
// The detection and pose pipeline lives in a Web Worker (markerWorker.js).
// Decoding markers in a 640×480 frame costs 5–15 ms, and run on the main
// thread — as the first integration did — every one of those milliseconds
// came out of the game's frame budget, so the whole game stuttered at
// camera cadence. This side only grabs frames, ships them to the worker,
// and turns its answers into a controller pose.
//
// Frames are grabbed with requestVideoFrameCallback where available, so
// detection runs once per CAMERA frame rather than once per display frame:
// a 30 fps camera on a 120 Hz screen used to run the pipeline four times
// per new image, three of them for nothing.
//
// On top of the worker's measurements this side keeps the controller
// logic: neutral-hold calibration, the teleport sanity gate, edge-softened
// updates, an alpha–beta predictive filter that leads the measurement to
// hide camera latency, and the debug overlay.

import * as THREE from 'three';

export const TRACKER_STATE = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CALIBRATING: 'calibrating',
  TRACKING: 'tracking',
  LOST: 'lost',
  ERROR: 'error',
};

const FRONT_IDS = new Set([1, 2, 3, 4]);

// Alpha–beta filter with a prediction lead (ported from the webcam demo).
// A webcam pose is 60–120 ms old by the time it renders: one camera frame
// of exposure, one of transfer, the worker round-trip, then the display.
// Tracking velocity and reporting the position a beat AHEAD hides most of
// that — the paddle arrives where your hand is, not where it was.
class PredictivePositionFilter {
  constructor({ alpha = 0.52, beta = 0.11 } = {}) {
    this.alpha = alpha;
    this.beta = beta;
    this.reset();
  }

  reset() {
    this.position = null;
    this.velocity = new THREE.Vector3();
    this.lastTime = null;
  }

  filter(measurement, time, lead) {
    if (!this.position) {
      this.position = measurement.clone();
      this.lastTime = time;
      return this.position.clone();
    }
    const dt = THREE.MathUtils.clamp((time - this.lastTime) / 1000, 1 / 240, 0.1);
    const prediction = this.position.clone().addScaledVector(this.velocity, dt);
    const residual = measurement.clone().sub(prediction);
    this.position.copy(prediction).addScaledVector(residual, this.alpha);
    this.velocity.addScaledVector(residual, this.beta / dt);
    this.lastTime = time;
    return this.position.clone().addScaledVector(this.velocity, lead);
  }
}

export class MarkerPaddleTracker {
  constructor({ assistOnly = false } = {}) {
    this.assistOnly = assistOnly;
    this.screenBounds = null;
    this.state = TRACKER_STATE.IDLE;
    this.error = null;
    this.confidence = 0;
    this.markerCount = 0;
    this.fps = 0;

    // Latest pose as a controller would report it: `position` is the raw
    // DISPLACEMENT from the calibrated neutral hold, metres of camera space
    // — +X right, +Y up, +Z toward the screen. The quaternion is relative
    // to the neutral hold.
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();

    // How far ahead of the measurement to predict, seconds. The game feeds
    // this from the tuning panel.
    this.predictionLead = 0.06;

    this.onState = null;

    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;

    const frameCanvas = document.createElement('canvas');
    if (!frameCanvas || typeof frameCanvas.getContext !== 'function') {
      throw new Error('Canvas 2D is unavailable; phone CV needs a browser with canvas support.');
    }
    this.frame = frameCanvas;
    this.frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!this.frameCtx) {
      throw new Error('Could not create a Canvas 2D context for phone CV.');
    }

    this.debugCanvas = null;
    this.debugCtx = null;

    this._worker = null;
    this._workerBusy = false;
    this._seq = 0;
    this._stream = null;
    this._grabHandle = null;
    this._usingRVFC = false;
    this._lastFrameTime = 0;
    this._missed = 0;
    this._neutral = null;
    this._neutralPosition = null;
    this._lastAccepted = null;
    this._jumpFrames = 0;
    this._latestRawPose = null;
    this._lastMarkers = [];

    this._predictor = new PredictivePositionFilter();
    this._smoothedQuat = null;
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.onState?.(state, error);
  }

  async start() {
    if (this._stream) return;
    this._setState(TRACKER_STATE.REQUESTING);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is unavailable. Open the desktop arena over HTTPS or localhost.');
      }
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
    } catch (err) {
      this._setState(TRACKER_STATE.ERROR, describeCameraError(err));
      return;
    }

    await optimizeCameraForTracking(this._stream.getVideoTracks()[0]);
    this.video.srcObject = this._stream;
    await this.video.play();
    this.frame.width = this.video.videoWidth || 640;
    this.frame.height = this.video.videoHeight || 480;

    this._worker = new Worker(new URL('./markerWorker.js', import.meta.url), {
      type: 'module',
    });
    this._worker.onmessage = (event) => this._onWorkerResult(event.data);
    this._worker.onerror = (err) => {
      this._setState(TRACKER_STATE.ERROR, err.message ?? 'Tracker worker failed');
    };

    this._setState(TRACKER_STATE.CALIBRATING);
    this._scheduleGrab();
  }

  stop() {
    if (this._grabHandle !== null) {
      if (this._usingRVFC) this.video.cancelVideoFrameCallback?.(this._grabHandle);
      else cancelAnimationFrame(this._grabHandle);
      this._grabHandle = null;
    }
    this._worker?.terminate();
    this._worker = null;
    this._workerBusy = false;
    for (const track of this._stream?.getTracks() ?? []) track.stop();
    this._stream = null;
    this.video.srcObject = null;
    this._predictor.reset();
    this.markerCount = 0;
    this.screenBounds = null;
    this._setState(TRACKER_STATE.IDLE);
  }

  attachDebugCanvas(canvas) {
    this.debugCanvas = canvas ?? null;
    this.debugCtx = typeof canvas?.getContext === 'function'
      ? canvas.getContext('2d')
      : null;
  }

  // Kept under the colour tracker's name so the game's calibration gesture —
  // click while the tracker waits — works unchanged. Captures the neutral
  // hold: the current pose becomes "paddle at rest".
  calibrateColour() {
    if (!this._latestRawPose) return false;
    this._neutral = this._latestRawPose.quaternion.clone().invert();
    this._neutralPosition = this._latestRawPose.position.clone();
    this._smoothedQuat = null;
    this._predictor.reset();
    this.position.set(0, 0, 0);
    if (this.state === TRACKER_STATE.CALIBRATING) this._setState(TRACKER_STATE.TRACKING);
    return true;
  }

  // A decoded marker board knows which way it faces; the key stays harmless.
  flipTilt() {}

  // --- Frame pump -----------------------------------------------------------

  _scheduleGrab() {
    if (!this._stream) return;
    if (this.video.requestVideoFrameCallback) {
      this._usingRVFC = true;
      this._grabHandle = this.video.requestVideoFrameCallback(() => this._grabFrame());
    } else {
      this._usingRVFC = false;
      this._grabHandle = requestAnimationFrame(() => this._grabFrame());
    }
  }

  _grabFrame() {
    this._grabHandle = null;
    if (!this._stream || !this._worker) return;
    // If the worker is still chewing the last frame, skip this one — always
    // process the freshest image rather than queueing stale ones.
    if (!this._workerBusy && this.video.readyState >= 2 && this.video.videoWidth > 0) {
      const width = this.video.videoWidth;
      const height = this.video.videoHeight;
      if (this.frame.width !== width) {
        this.frame.width = width;
        this.frame.height = height;
      }
      this.frameCtx.drawImage(this.video, 0, 0, width, height);
      const imageData = this.frameCtx.getImageData(0, 0, width, height);
      this._workerBusy = true;
      this._worker.postMessage(
        { seq: ++this._seq, width, height, buffer: imageData.data.buffer },
        [imageData.data.buffer]
      );
    }
    this._scheduleGrab();
  }

  // --- Applying worker results ----------------------------------------------

  _onWorkerResult(result) {
    this._workerBusy = false;
    if (!this._stream) return;

    const now = performance.now();
    if (this._lastFrameTime) {
      const dt = (now - this._lastFrameTime) / 1000;
      if (dt > 0) this.fps = this.fps * 0.9 + (1 / dt) * 0.1;
    }
    this._lastFrameTime = now;

    this._lastMarkers = result.markers;
    this.markerCount = result.markers?.filter((marker) => marker.id >= 1 && marker.id <= 4).length ?? 0;
    this._drawDebug(result);

    this.screenBounds = result.assist?.bounds ?? null;
    if (!result.pose) {
      // Phone mode only accepts a board when at least two of its known markers
      // are visible. One black square can be a false positive; two matching
      // IDs establish that the tracked object is our phone target.
      const phoneMarkerLock = this.markerCount >= 2;
      if (this.assistOnly && result.assist && phoneMarkerLock) {
        this._missed = 0;
        this.confidence = 0.65;
        this.position.copy(new THREE.Vector3().fromArray(result.assist.position));
        if (this.state !== TRACKER_STATE.TRACKING) this._setState(TRACKER_STATE.TRACKING);
        return;
      }
      // Brief colour fallback keeps position alive through a blurred swing,
      // but only just after a confirmed marker pose.
      if (result.recentPose && result.assist && this._neutralPosition) {
        const measured = new THREE.Vector3().fromArray(result.assist.position);
        this.position.lerp(measured.sub(this._neutralPosition), 0.15);
        this.confidence = 0.3;
        return;
      }
      this._missed += 1;
      this.confidence = Math.max(0, this.confidence - 0.15);
      if (this._missed > 8 && this.state === TRACKER_STATE.TRACKING) {
        this._setState(TRACKER_STATE.LOST);
      }
      return;
    }

    this._missed = 0;
    const position = new THREE.Vector3().fromArray(result.pose.position);
    const quaternion = new THREE.Quaternion().fromArray(result.pose.quaternion);
    if (result.pose.markerSpacingDepth !== null) {
      position.z = -result.pose.markerSpacingDepth;
    }
    this.confidence = result.pose.usesWholeBoardPose ? 1 : 0.7;

    this._latestRawPose = { position, quaternion };
    if (!this._neutral) {
      this._neutral = quaternion.clone().invert();
      this._neutralPosition = position.clone();
    }
    if (this.state !== TRACKER_STATE.TRACKING) this._setState(TRACKER_STATE.TRACKING);

    // Sanity gate against teleports: when the board slides half out of frame
    // the surviving markers solve to somewhere wild for a frame or two. A
    // real swing is fast but continuous; a solve error is a discontinuity,
    // so a large jump is only believed once a second frame lands near it.
    if (this._lastAccepted && position.distanceTo(this._lastAccepted) > 0.45) {
      this._jumpFrames += 1;
      if (this._jumpFrames < 2) return;
    }
    this._jumpFrames = 0;
    this._lastAccepted = position.clone();

    const soft = result.pose.nearEdge || result.pose.markerCount < 2;
    const displacement = position.clone().sub(this._neutralPosition);

    if (soft) {
      // Suspect measurement: damped positional nudge, hold the last angle.
      this.position.lerp(displacement, 0.15);
      return;
    }

    this.position.copy(this._predictor.filter(displacement, now, this.predictionLead));
    const relative = quaternion.clone().premultiply(this._neutral);
    if (!this._smoothedQuat) this._smoothedQuat = relative.clone();
    else this._smoothedQuat.slerp(relative, 0.35);
    this.quaternion.copy(this._smoothedQuat);
  }

  // --- Debug preview ----------------------------------------------------

  _drawDebug(result) {
    const ctx = this.debugCtx;
    if (!ctx) return;
    const { width: w, height: h } = this.debugCanvas;
    ctx.save();
    ctx.scale(-1, 1); // mirrored, so moving right on screen matches you
    ctx.drawImage(this.video, -w, 0, w, h);
    ctx.restore();

    const sx = w / (this.video.videoWidth || 640);
    const sy = h / (this.video.videoHeight || 480);
    for (const marker of result.markers) {
      ctx.strokeStyle =
        marker.flowAge > 0 ? '#55e6ff' : FRONT_IDS.has(marker.id) ? '#3dff9b' : '#c895ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      marker.corners.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(w - x * sx, y * sy);
        else ctx.lineTo(w - x * sx, y * sy);
      });
      ctx.closePath();
      ctx.stroke();
    }
    if (!result.markers.length && result.assist) {
      const b = result.assist.bounds;
      ctx.strokeStyle = '#55e6ff';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(w - (b.left + b.width) * sx, b.top * sy, b.width * sx, b.height * sy);
      ctx.setLineDash([]);
    }
  }
}

async function optimizeCameraForTracking(track) {
  if (!track?.getCapabilities) return;
  const capabilities = track.getCapabilities();
  const advanced = {};
  if (capabilities.focusMode?.includes('continuous')) advanced.focusMode = 'continuous';
  if (capabilities.exposureMode?.includes('continuous')) advanced.exposureMode = 'continuous';
  if (capabilities.whiteBalanceMode?.includes('continuous')) advanced.whiteBalanceMode = 'continuous';
  if (capabilities.frameRate?.max) advanced.frameRate = Math.min(60, capabilities.frameRate.max);
  if (!Object.keys(advanced).length) return;
  try {
    await track.applyConstraints({ advanced: [advanced] });
  } catch {
    // Not every camera supports these; tracking works without them.
  }
}

function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Camera permission denied';
    case 'NotFoundError':
      return 'No camera found';
    case 'NotReadableError':
      return 'Camera is in use by another app';
    default:
      return err?.message ?? 'Could not open the camera';
  }
}
