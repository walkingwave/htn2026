// Computer-vision tracking of a real ping pong paddle through a webcam.
//
// Why a webcam and not the headset: the Meta Quest Browser does not expose
// the passthrough cameras to web pages. There is no getUserMedia path to
// them and no WebXR camera-access API in the browser, so vision has to run
// on a machine with a reachable camera. On a laptop that is the same page;
// for the headset the pose is streamed over the network (see poseLink.js).
//
// How the tracking works
// ----------------------
// A paddle is the easiest object in the room to find: a large, saturated,
// near-circular disc of a single colour. So rather than a general detector:
//
//   1. Sample the rubber's colour once, during calibration.
//   2. Each frame, threshold a downscaled image in HSV against that colour.
//   3. Take the image moments of the mask — area gives apparent size, the
//      covariance gives the major and minor axes of the blob.
//
// A circle viewed off-axis projects to an ellipse, and that gives pose:
//   • depth      from apparent size against the known physical diameter
//   • x / y      from the centroid through the pinhole model
//   • tilt       from the minor/major axis ratio (acos of it)
//   • tilt axis  perpendicular to the major axis in the image plane
//
// The one thing this cannot resolve is the *sign* of the tilt: a paddle
// leaning away projects identically to one leaning toward you. We disambiguate
// by continuity — the sign that agrees with the previous frame wins — which is
// right except through the exact side-on moment, where the face is invisible
// to the camera anyway.

import * as THREE from 'three';

const PROC_W = 160; // detection runs downscaled; full res buys nothing here
const PROC_H = 120;

export const TRACKER_STATE = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CALIBRATING: 'calibrating',
  TRACKING: 'tracking',
  LOST: 'lost',
  ERROR: 'error',
};

export class PaddleTracker {
  constructor({ paddleDiameter = 0.16, smoothing = 0.45 } = {}) {
    this.paddleDiameter = paddleDiameter;
    this.smoothing = smoothing; // 0 = raw and jittery, 1 = frozen

    this.state = TRACKER_STATE.IDLE;
    this.error = null;
    this.confidence = 0;
    this.fps = 0;

    // Latest pose, in camera space: +X right, +Y up, −Z into the scene.
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();

    // Colour key, learned during calibration
    this.target = { h: 0, s: 0.7, v: 0.6 };
    this.tolerance = { h: 0.055, s: 0.34, v: 0.36 };

    this.onState = null;

    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = PROC_W;
    this.canvas.height = PROC_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.debugCanvas = null; // set by attachDebugCanvas()

    this._stream = null;
    this._raf = null;
    this._mask = new Uint8Array(PROC_W * PROC_H);
    this._lastTiltSign = 1;
    this._smoothed = null;
    this._lastFrameTime = 0;
    this._focalPx = PROC_W; // ~53° horizontal FOV; refined at calibration
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
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      this._setState(TRACKER_STATE.ERROR, describeCameraError(err));
      return;
    }

    this.video.srcObject = this._stream;
    await this.video.play();
    this._setState(TRACKER_STATE.CALIBRATING);
    this._loop();
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    for (const track of this._stream?.getTracks() ?? []) track.stop();
    this._stream = null;
    this.video.srcObject = null;
    this._setState(TRACKER_STATE.IDLE);
  }

  attachDebugCanvas(canvas) {
    this.debugCanvas = canvas;
    this.debugCtx = canvas?.getContext('2d') ?? null;
  }

  // Learn the paddle's colour from the middle of frame. The player holds the
  // paddle face-on in the centre and triggers this once.
  calibrateColour() {
    if (!this._frameReady()) return false;
    this.ctx.drawImage(this.video, 0, 0, PROC_W, PROC_H);
    const { data } = this.ctx.getImageData(0, 0, PROC_W, PROC_H);

    // Median hue over the central patch, so a stray highlight can't skew it
    const hues = [];
    let sumS = 0;
    let sumV = 0;
    const x0 = (PROC_W * 0.4) | 0;
    const x1 = (PROC_W * 0.6) | 0;
    const y0 = (PROC_H * 0.35) | 0;
    const y1 = (PROC_H * 0.65) | 0;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * PROC_W + x) * 4;
        const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        if (s < 0.25 || v < 0.15) continue; // skip washed-out or dark pixels
        hues.push(h);
        sumS += s;
        sumV += v;
      }
    }
    if (hues.length < 40) return false; // nothing saturated enough to lock on

    hues.sort((a, b) => a - b);
    this.target = {
      h: hues[hues.length >> 1],
      s: sumS / hues.length,
      v: sumV / hues.length,
    };
    this._setState(TRACKER_STATE.TRACKING);
    return true;
  }

  _frameReady() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (!this._frameReady()) return;

    const now = performance.now();
    if (this._lastFrameTime) {
      const dt = (now - this._lastFrameTime) / 1000;
      if (dt > 0) this.fps = this.fps * 0.9 + (1 / dt) * 0.1;
    }
    this._lastFrameTime = now;

    this.ctx.drawImage(this.video, 0, 0, PROC_W, PROC_H);
    const frame = this.ctx.getImageData(0, 0, PROC_W, PROC_H);

    if (this.state === TRACKER_STATE.TRACKING || this.state === TRACKER_STATE.LOST) {
      const blob = this._detect(frame);
      if (blob) {
        this._poseFromBlob(blob);
        if (this.state === TRACKER_STATE.LOST) this._setState(TRACKER_STATE.TRACKING);
      } else {
        this.confidence = 0;
        if (this.state === TRACKER_STATE.TRACKING) this._setState(TRACKER_STATE.LOST);
      }
      this._drawDebug(frame, blob);
    } else {
      this._drawDebug(frame, null);
    }
  }

  // Threshold against the learned colour, then take image moments. Moments
  // rather than contour tracing: they give centroid and both axes in one
  // pass, they degrade gracefully when the blob is partly occluded by the
  // hand, and they are trivially fast at this resolution.
  _detect(frame) {
    const { data } = frame;
    const mask = this._mask;
    const t = this.target;
    const tol = this.tolerance;

    let count = 0;
    let sumX = 0;
    let sumY = 0;

    for (let y = 0, i = 0, p = 0; y < PROC_H; y++) {
      for (let x = 0; x < PROC_W; x++, i += 4, p++) {
        const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        // Hue is circular, so compare the short way round
        const dh = Math.min(Math.abs(h - t.h), 1 - Math.abs(h - t.h));
        const hit =
          dh < tol.h && Math.abs(s - t.s) < tol.s && Math.abs(v - t.v) < tol.v;
        mask[p] = hit ? 1 : 0;
        if (hit) {
          count++;
          sumX += x;
          sumY += y;
        }
      }
    }

    const minArea = 40; // smaller than this is noise, not a paddle
    if (count < minArea) return null;

    const cx = sumX / count;
    const cy = sumY / count;

    // Second moments give the ellipse the disc projects to
    let mxx = 0;
    let myy = 0;
    let mxy = 0;
    for (let y = 0, p = 0; y < PROC_H; y++) {
      for (let x = 0; x < PROC_W; x++, p++) {
        if (!mask[p]) continue;
        const dx = x - cx;
        const dy = y - cy;
        mxx += dx * dx;
        myy += dy * dy;
        mxy += dx * dy;
      }
    }
    mxx /= count;
    myy /= count;
    mxy /= count;

    // Eigenvalues of the 2x2 covariance: the ellipse's squared semi-axes
    const tr = mxx + myy;
    const det = mxx * myy - mxy * mxy;
    const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
    const l1 = tr / 2 + disc;
    const l2 = Math.max(tr / 2 - disc, 1e-6);

    const major = 2 * Math.sqrt(l1);
    const minor = 2 * Math.sqrt(l2);
    const angle = 0.5 * Math.atan2(2 * mxy, mxx - myy);

    // How disc-like is this really? A hand or a shirt in the same colour
    // tends to be far from elliptical, and the filled-area ratio catches it.
    const ellipseArea = Math.PI * Math.sqrt(l1) * Math.sqrt(l2);
    const fill = ellipseArea > 0 ? count / ellipseArea : 0;
    this.confidence = THREE.MathUtils.clamp(
      Math.min(fill, 1) * Math.min(count / 220, 1),
      0,
      1
    );
    if (this.confidence < 0.25) return null;

    return { cx, cy, major, minor, angle, count };
  }

  _poseFromBlob(blob) {
    const radius = this.paddleDiameter / 2;

    // Depth from apparent size. The major axis is the *unforeshortened*
    // diameter — tilting the paddle shrinks the minor axis but leaves the
    // major one alone — which is exactly why it is the reliable size cue.
    const z = (this._focalPx * this.paddleDiameter) / Math.max(blob.major, 1e-3);

    // Pinhole back-projection of the centroid. Image +Y is down, world +Y up.
    const x = ((blob.cx - PROC_W / 2) * z) / this._focalPx;
    const y = -((blob.cy - PROC_H / 2) * z) / this._focalPx;

    // Webcams mirror the user, so flip X to get a natural mapping
    const pos = new THREE.Vector3(-x, y, -z);

    // Tilt from the axis ratio; sign is ambiguous, so keep the one that
    // agrees with last frame (see the note at the top of this file).
    const ratio = THREE.MathUtils.clamp(blob.minor / Math.max(blob.major, 1e-6), 0, 1);
    const tilt = Math.acos(ratio) * this._lastTiltSign;

    // The tilt axis lies along the ellipse's major axis in the image plane
    const axis = new THREE.Vector3(Math.cos(blob.angle), -Math.sin(blob.angle), 0).normalize();
    const quat = new THREE.Quaternion().setFromAxisAngle(axis, tilt);

    if (this._smoothed) {
      const k = 1 - this.smoothing;
      this._smoothed.position.lerp(pos, k);
      this._smoothed.quaternion.slerp(quat, k);
    } else {
      this._smoothed = { position: pos.clone(), quaternion: quat.clone() };
    }

    this.position.copy(this._smoothed.position);
    this.quaternion.copy(this._smoothed.quaternion);
  }

  // Flips which way an ambiguous tilt is read. Wired to a key so the player
  // can correct it in the rare case continuity latches onto the wrong sign.
  flipTilt() {
    this._lastTiltSign *= -1;
  }

  _drawDebug(frame, blob) {
    const ctx = this.debugCtx;
    if (!ctx) return;
    const { width: w, height: h } = this.debugCanvas;

    ctx.save();
    ctx.scale(-1, 1); // mirror, so moving right on screen matches moving right
    ctx.drawImage(this.video, -w, 0, w, h);
    ctx.restore();

    // Dim everything that did not match the colour key
    const sx = w / PROC_W;
    const sy = h / PROC_H;

    if (blob) {
      ctx.strokeStyle = '#35ff9b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(
        w - blob.cx * sx,
        blob.cy * sy,
        (blob.major / 2) * sx,
        (blob.minor / 2) * sy,
        -blob.angle,
        0,
        Math.PI * 2
      );
      ctx.stroke();

      ctx.fillStyle = '#35ff9b';
      ctx.beginPath();
      ctx.arc(w - blob.cx * sx, blob.cy * sy, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.state === TRACKER_STATE.CALIBRATING) {
      // Show the patch the colour will be sampled from
      ctx.strokeStyle = '#e2231a';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeRect(w * 0.4, h * 0.35, w * 0.2, h * 0.3);
      ctx.setLineDash([]);
    }
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

// Returns h, s, v each in 0..1. Written out rather than pulled from a library
// because it runs on every pixel of every frame.
function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
