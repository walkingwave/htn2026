// Marker-based tracking of a real ping pong paddle through a webcam.
//
// Ported from the standalone webcam demo on the computercam branch into the
// game's tracker interface, so the webcam bat runs on printed ArUco markers
// instead of colour alone. Colour tracking knows only "a patch of roughly
// this colour" — red rubber and a face share a hue, which is how the bat
// ended up tracking the player's head. A decoded marker ID cannot be a face:
// it either reads back one of our nine codes or it is ignored.
//
// The paddle carries a 2×2 board of 4x4 ArUco markers on each face
// (IDs 1–4 on the red side, 5–8 on the black side), 3 cm squares with ~1 cm
// gaps. Pose comes from, in order of preference:
//
//   1. a homography over every decoded corner (up to 16 points) — steadiest
//   2. POSIT on the board's four outer corners when all four IDs decode
//   3. per-marker POSIT poses, outlier-rejected and confidence-averaged
//
// Depth prefers the projected spacing between marker centres — a known
// physical baseline — over any single marker's apparent size. A light colour
// pass (anchored to the markers, never free-running) steadies screen X/Y,
// and markers lost to motion blur are held for a few frames by pyramidal
// optical flow on their corners. One-Euro filters smooth the output: tight
// when the bat is slow, loose when it swings.

import * as THREE from 'three';
import { AR } from 'js-aruco2';
import * as CVModule from 'js-aruco2/src/cv.js';
import { POS } from 'js-aruco2/src/posit1.js';

const { CV } = CVModule.default;

export const TRACKER_STATE = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CALIBRATING: 'calibrating',
  TRACKING: 'tracking',
  LOST: 'lost',
  ERROR: 'error',
};

// OpenCV / MATLAB DICT_4X4_250 entries 0–8; the printed board uses 1–8.
AR.DICTIONARIES.MATLAB_DICT_4X4_250 = {
  nBits: 16,
  tau: 2,
  codeList: [
    [181, 50], [15, 154], [51, 45], [153, 70], [84, 158],
    [121, 205], [158, 46], [196, 242], [254, 218],
  ],
};

const FRONT_IDS = new Set([1, 2, 3, 4]);
const BACK_IDS = new Set([5, 6, 7, 8]);

const MARKER_SIZE_MM = 30;
// Marker centres in millimetres relative to the paddle centre: a 2×2 board
// of 3 cm markers with roughly 1 cm gaps, seen face-on.
const MARKER_CENTRES_MM = {
  1: [-20, 20, 0], 2: [20, 20, 0], 3: [20, -20, 0], 4: [-20, -20, 0],
  5: [-20, 20, 0], 6: [20, 20, 0], 7: [20, -20, 0], 8: [-20, -20, 0],
};

// Adaptive-threshold blur radii for the fallback detection pass. js-aruco2
// expresses the window as a blur radius: 1, 6, 11 ≈ OpenCV windows 3, 13, 23.
const FALLBACK_BLUR_RADII = [1, 6, 11];

class OneEuroFilter {
  constructor({ minCutoff = 1, beta = 0, derivativeCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.reset();
  }

  reset() {
    this.value = null;
    this.rawValue = null;
    this.derivative = 0;
    this.lastTime = null;
  }

  filter(nextValue, time) {
    if (this.lastTime === null) {
      this.value = nextValue;
      this.rawValue = nextValue;
      this.lastTime = time;
      return nextValue;
    }
    const dt = THREE.MathUtils.clamp((time - this.lastTime) / 1000, 1 / 240, 0.1);
    const rawDerivative = (nextValue - this.rawValue) / dt;
    this.derivative += this._alpha(this.derivativeCutoff, dt) * (rawDerivative - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += this._alpha(cutoff, dt) * (nextValue - this.value);
    this.rawValue = nextValue;
    this.lastTime = time;
    return this.value;
  }

  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

export class MarkerPaddleTracker {
  constructor() {
    this.state = TRACKER_STATE.IDLE;
    this.error = null;
    this.confidence = 0;
    this.fps = 0;

    // Latest pose as a controller would report it: `position` is the
    // DISPLACEMENT from the calibrated neutral hold, in metres of (gained)
    // camera space — +X right, +Y up, −Z toward the screen. Absolute camera
    // position is useless to the game: it depends on where the webcam sits
    // and how far back the player's chair is, which is exactly why the
    // paddle used to appear parked near the ceiling. The quaternion is
    // likewise relative to the neutral hold.
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();

    this.onState = null;

    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;

    this.frame = document.createElement('canvas');
    this.frameCtx = this.frame.getContext('2d', { willReadFrequently: true });

    this.debugCanvas = null;
    this.debugCtx = null;

    this._detector = new AR.Detector({ dictionaryName: 'MATLAB_DICT_4X4_250' });
    this._stream = null;
    this._raf = null;
    this._lastPoseAt = 0;
    this._lastFrameTime = 0;
    this._missed = 0;
    this._activeFace = 'red';
    this._neutral = null; // quaternion captured while the player holds still
    this._neutralPosition = null;
    this._lastAccepted = null; // last raw position that passed the sanity gate
    this._jumpFrames = 0;
    this._latestRawPose = null;
    this._previousGrey = null;
    this._previousMarkers = [];
    this._lastBounds = null;

    const positionOptions = { minCutoff: 0.9, beta: 0.8 };
    this._filterX = new OneEuroFilter(positionOptions);
    this._filterY = new OneEuroFilter(positionOptions);
    // Depth changes are far smaller than lateral ones, so it reacts faster.
    this._filterZ = new OneEuroFilter({ minCutoff: 1.1, beta: 0.9 });
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
    this._setState(TRACKER_STATE.CALIBRATING);
    this._loop();
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    for (const track of this._stream?.getTracks() ?? []) track.stop();
    this._stream = null;
    this.video.srcObject = null;
    this._previousGrey = null;
    this._previousMarkers = [];
    this._setState(TRACKER_STATE.IDLE);
  }

  attachDebugCanvas(canvas) {
    this.debugCanvas = canvas;
    this.debugCtx = canvas?.getContext('2d') ?? null;
  }

  // Kept under the colour tracker's name so the game's calibration gesture —
  // click while the tracker waits — works unchanged. Here it captures the
  // neutral hold: the current orientation becomes "bat square to the table".
  calibrateColour() {
    if (!this._latestRawPose) return false;
    this._neutral = this._latestRawPose.quaternion.clone().invert();
    this._neutralPosition = this._latestRawPose.position.clone();
    this._smoothedQuat = null;
    this._filterX.reset();
    this._filterY.reset();
    this._filterZ.reset();
    this.position.set(0, 0, 0);
    if (this.state === TRACKER_STATE.CALIBRATING) this._setState(TRACKER_STATE.TRACKING);
    return true;
  }

  // The colour tracker's tilt-sign toggle has no meaning here — a decoded
  // marker board knows which way it faces — but the key stays harmless.
  flipTilt() {}

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

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (this.frame.width !== width) {
      this.frame.width = width;
      this.frame.height = height;
    }
    this.frameCtx.drawImage(this.video, 0, 0, width, height);
    const imageData = this.frameCtx.getImageData(0, 0, width, height);

    const markers = refineMarkerCorners(this._detect(imageData), this._detector.grey);
    const paddleMarkers = markers.filter((m) => FRONT_IDS.has(m.id) || BACK_IDS.has(m.id));
    const flowMarkers = this._recoverWithOpticalFlow(paddleMarkers, this._detector.grey);
    this._rememberFrame(this._detector.grey, flowMarkers);

    const assist = this._findPaddleByColour(imageData, this._activeFace, flowMarkers);
    const boardPose = this._estimateBoardPose(flowMarkers, width, height);

    this._drawDebug(imageData, flowMarkers, boardPose, assist);

    if (!boardPose) {
      // Brief colour fallback keeps position alive through a blurred swing,
      // but only just after a confirmed marker pose — a free-running colour
      // blob is exactly the face bug this tracker exists to kill.
      const recentlyConfirmed = now - this._lastPoseAt < 750;
      if (recentlyConfirmed && assist && this._neutralPosition) {
        const displacement = this._assistPosition(assist, width).sub(this._neutralPosition);
        this._applyPose(displacement, null, now, true);
        this.confidence = 0.3;
        return;
      }
      this._missed += 1;
      this.confidence = Math.max(0, this.confidence - 0.15);
      if (
        this._missed > 15 &&
        (this.state === TRACKER_STATE.TRACKING || this.state === TRACKER_STATE.LOST)
      ) {
        if (this.state === TRACKER_STATE.TRACKING) this._setState(TRACKER_STATE.LOST);
      }
      return;
    }

    this._missed = 0;
    this._activeFace = boardPose.isFrontBoard ? 'red' : 'black';
    this._lastPoseAt = now;
    this._lastBounds = assist ? { ...assist } : boundsAroundMarkers(boardPose.markers);
    this.confidence = boardPose.usesWholeBoardPose ? 1 : 0.7;

    // Raw metres; how far real motion moves the virtual paddle is the
    // game's decision (it is player-tunable there), not the tracker's.
    const position = boardPose.position.clone();
    // Depth from the marker-centre baseline where available: two centres a
    // known distance apart measure the whole board, which is far steadier
    // than one marker's apparent size.
    let depth = Math.max(0.2, -position.z);
    if (boardPose.markerSpacingDepth !== null) depth = boardPose.markerSpacingDepth;
    position.z = -depth;

    if (assist) {
      const silhouette = this._assistPosition(assist, width);
      position.x = THREE.MathUtils.lerp(position.x, silhouette.x, 0.45);
      position.y = THREE.MathUtils.lerp(position.y, silhouette.y, 0.45);
    }

    this._latestRawPose = { position, quaternion: boardPose.quaternion.clone() };

    // First solid pose while waiting: adopt the current hold as neutral, so
    // the paddle is usable immediately; a click recalibrates deliberately.
    if (!this._neutral) {
      this._neutral = boardPose.quaternion.clone().invert();
      this._neutralPosition = position.clone();
    }
    if (this.state !== TRACKER_STATE.TRACKING) this._setState(TRACKER_STATE.TRACKING);

    // Sanity gate against teleports. When the board slides half out of frame
    // the surviving markers solve to somewhere wild for a frame or two, and
    // that frame used to fling the paddle across the room. A real swing is
    // fast but continuous; a solve error is a discontinuity. So a large jump
    // is only believed once a second frame lands near the same new spot.
    if (this._lastAccepted && position.distanceTo(this._lastAccepted) > 0.45) {
      this._jumpFrames += 1;
      if (this._jumpFrames < 2) return;
    }
    this._jumpFrames = 0;
    this._lastAccepted = position.clone();

    // A board grazing the frame edge, or held by a single marker, solves
    // noisily. Its position is still worth a heavily damped nudge, but its
    // orientation is not worth anything — hold the last good angle.
    const soft = boardPose.nearEdge || boardPose.markers.length < 2;

    const relative = boardPose.quaternion.clone().premultiply(this._neutral);
    const displacement = position.clone().sub(this._neutralPosition);
    this._applyPose(displacement, soft ? null : relative, now, soft);
  }

  _applyPose(position, quaternion, now, soft = false) {
    if (soft) {
      // Damped nudge only: the measurement is suspect, so creep toward it
      // rather than feeding it through the responsive filters.
      this.position.lerp(position, 0.15);
    } else {
      this.position.set(
        this._filterX.filter(position.x, now),
        this._filterY.filter(position.y, now),
        this._filterZ.filter(position.z, now)
      );
    }
    if (quaternion) {
      if (!this._smoothedQuat) this._smoothedQuat = quaternion.clone();
      else this._smoothedQuat.slerp(quaternion, 0.35);
      this.quaternion.copy(this._smoothedQuat);
    }
  }

  _assistPosition(bounds, frameWidth) {
    const paddleDiameter = 0.17; // regulation racket head, metres
    const focal = frameWidth; // ~53° horizontal FOV assumption
    const depth = THREE.MathUtils.clamp((focal * paddleDiameter) / bounds.diameter, 0.2, 3);
    return new THREE.Vector3(
      -((bounds.centerX - frameWidth / 2) / focal) * depth,
      ((this.frame.height / 2 - bounds.centerY) / focal) * depth,
      -depth
    );
  }

  // --- Detection ------------------------------------------------------------

  // The library's cheap 5×5 pass first; if it cannot recover two markers,
  // retry across the OpenCV-style window range for uneven light and motion
  // blur softening the borders.
  _detect(imageData) {
    const detector = this._detector;
    CV.grayscale(imageData, detector.grey);
    detector.contours = [];

    const first = this._thresholdCandidates(imageData, 2);
    detector.candidates = this._prepareCandidates(first);
    const markers = detector.findMarkers(detector.grey, detector.candidates, 49);
    if (markers.length >= 2) return markers;

    const all = [...first];
    for (const radius of FALLBACK_BLUR_RADII) {
      all.push(...this._thresholdCandidates(imageData, radius));
    }
    detector.candidates = this._prepareCandidates(all);
    return detector.findMarkers(detector.grey, detector.candidates, 49);
  }

  _thresholdCandidates(imageData, blurRadius) {
    const detector = this._detector;
    CV.adaptiveThreshold(detector.grey, detector.thres, blurRadius, 7);
    const contours = CV.findContours(detector.thres, detector.binary);
    detector.contours.push(...contours);
    return detector.findCandidates(contours, imageData.width * 0.01, 0.05, 10);
  }

  _prepareCandidates(candidates) {
    const detector = this._detector;
    return detector.notTooNear(detector.clockwiseCorners(candidates), 10);
  }

  // --- Optical flow recovery --------------------------------------------

  // A marker lost to motion blur is held for up to three frames by tracking
  // its corners between grey frames with a small pyramidal template search.
  _recoverWithOpticalFlow(decoded, currentGrey) {
    const prev = this._previousGrey;
    if (!prev || prev.width !== currentGrey.width || prev.height !== currentGrey.height) {
      return decoded;
    }
    const decodedIds = new Set(decoded.map((m) => m.id));
    const recoverable = this._previousMarkers.filter(
      (m) => !decodedIds.has(m.id) && (m.flowAge || 0) < 3
    );
    if (!recoverable.length) return decoded;

    const prevPyramid = buildGreyPyramid(prev);
    const currentPyramid = buildGreyPyramid(currentGrey);
    const recovered = [];
    for (const marker of recoverable) {
      const corners = marker.corners.map((c) => trackCornerPyramid(prevPyramid, currentPyramid, c));
      if (corners.some((c) => !c)) continue;
      recovered.push(
        Object.assign(new AR.Marker(marker.id, corners, marker.hammingDistance), {
          flowAge: (marker.flowAge || 0) + 1,
        })
      );
    }
    return [...decoded, ...recovered];
  }

  _rememberFrame(grey, markers) {
    this._previousGrey = {
      width: grey.width,
      height: grey.height,
      data: new Uint8Array(grey.data),
    };
    this._previousMarkers = markers.map((m) =>
      Object.assign(
        new AR.Marker(m.id, m.corners.map((c) => ({ ...c })), m.hammingDistance),
        { flowAge: m.flowAge || 0 }
      )
    );
  }

  // --- Colour assist ------------------------------------------------------

  // Deliberately marker-anchored. A blob that does not contain (or sit near)
  // the decoded markers is punished into irrelevance, so a face or a red
  // jumper cannot outvote the board.
  _findPaddleByColour(imageData, colour, markerHints) {
    const sample = 4;
    const width = Math.floor(imageData.width / sample);
    const height = Math.floor(imageData.height / sample);
    const mask = new Uint8Array(width * height);
    const { data } = imageData;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const src = (y * sample * imageData.width + x * sample) * 4;
        const r = data[src];
        const g = data[src + 1];
        const b = data[src + 2];
        const isRed = r > 85 && r > g * 1.35 && r > b * 1.35 && r - g > 40;
        const isBlack = Math.max(r, g, b) < 80 && Math.max(r, g, b) - Math.min(r, g, b) < 35;
        if ((colour === 'red' && isRed) || (colour === 'black' && isBlack)) {
          mask[y * width + x] = 1;
        }
      }
    }

    let largest = null;
    const stack = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start]) continue;
      let count = 0;
      let top = 1;
      stack[0] = start;
      mask[start] = 0;
      let minX = width, maxX = 0, minY = height, maxY = 0;
      while (top) {
        const index = stack[--top];
        const x = index % width;
        const y = (index - x) / width;
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && mask[index - 1]) { mask[index - 1] = 0; stack[top++] = index - 1; }
        if (x < width - 1 && mask[index + 1]) { mask[index + 1] = 0; stack[top++] = index + 1; }
        if (y > 0 && mask[index - width]) { mask[index - width] = 0; stack[top++] = index - width; }
        if (y < height - 1 && mask[index + width]) { mask[index + width] = 0; stack[top++] = index + width; }
      }

      const centerX = ((minX + maxX + 1) * sample) / 2;
      const centerY = ((minY + maxY + 1) * sample) / 2;
      let score = count;
      if (markerHints.length) {
        const corners = markerHints.flatMap((m) => m.corners);
        const hintX = corners.reduce((s, c) => s + c.x, 0) / corners.length;
        const hintY = corners.reduce((s, c) => s + c.y, 0) / corners.length;
        const containsHint =
          hintX >= minX * sample && hintX <= (maxX + 1) * sample &&
          hintY >= minY * sample && hintY <= (maxY + 1) * sample;
        if (containsHint) score *= 12;
        else score /= 1 + Math.hypot(centerX - hintX, centerY - hintY) / Math.max(1, imageData.width * 0.1);
      }
      if (this._lastBounds && performance.now() - this._lastPoseAt < 1200) {
        const d2 = (centerX - this._lastBounds.centerX) ** 2 + (centerY - this._lastBounds.centerY) ** 2;
        const radius2 = Math.max(this._lastBounds.width, this._lastBounds.height) ** 2;
        score /= 1 + d2 / Math.max(1, radius2);
      }
      if (!largest || score > largest.score) largest = { count, score, minX, maxX, minY, maxY };
    }

    if (!largest || largest.count < width * height * 0.015) return null;
    const padding = sample * 3;
    const left = Math.max(0, largest.minX * sample - padding);
    const topPx = Math.max(0, largest.minY * sample - padding);
    const right = Math.min(imageData.width, (largest.maxX + 1) * sample + padding);
    const bottom = Math.min(imageData.height, (largest.maxY + 1) * sample + padding);
    const w = right - left;
    const h = bottom - topPx;
    // Without a marker anchor, an implausible silhouette is worth nothing.
    if (!markerHints.length) {
      const aspect = w / h;
      const frameFraction = (w * h) / (imageData.width * imageData.height);
      if (aspect < 0.3 || aspect > 2.5 || frameFraction > 0.45) return null;
    }
    return {
      left, top: topPx, width: w, height: h,
      centerX: left + w / 2,
      centerY: topPx + h / 2,
      diameter: Math.max(w, h),
      colour,
    };
  }

  // --- Pose -----------------------------------------------------------------

  _estimateBoardPose(markers, frameWidth, frameHeight) {
    const front = markers.filter((m) => FRONT_IDS.has(m.id));
    const back = markers.filter((m) => BACK_IDS.has(m.id));
    const board = front.length >= back.length ? front : back;
    if (!board.length) return null;

    const poses = board
      .map((m) => estimateMarkerPose(m, frameWidth, frameHeight))
      .filter((p) => p && p.reprojectionError <= Math.max(2.5, Math.sqrt(markerImageArea(p.marker)) * 0.08));
    if (!poses.length) return null;

    const inliers = rejectPoseOutliers(poses);
    let position = inliers
      .reduce((sum, p) => sum.add(p.position), new THREE.Vector3())
      .multiplyScalar(1 / inliers.length);

    const rotationInliers = rejectRotationOutliers(inliers);
    const reference = rotationInliers[0].quaternion;
    const sum = rotationInliers.reduce((acc, item) => {
      const q = item.quaternion.clone();
      if (reference.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      // Larger decoded markers give POSIT less noisy corners; weight them up.
      const weight = Math.sqrt(markerImageArea(item.marker)) / (1 + (item.marker.hammingDistance || 0));
      acc.x += q.x * weight;
      acc.y += q.y * weight;
      acc.z += q.z * weight;
      acc.w += q.w * weight;
      return acc;
    }, new THREE.Vector4());
    let quaternion = new THREE.Quaternion(sum.x, sum.y, sum.z, sum.w).normalize();

    const wholeBoard =
      estimateAllCornerBoardPose(inliers.map((p) => p.marker), frameWidth, frameHeight) ||
      estimateOuterCornerBoardPose(inliers.map((p) => p.marker), frameWidth, frameHeight);
    if (wholeBoard) {
      position = wholeBoard.position;
      quaternion = wholeBoard.quaternion;
    }

    // A corner within a few percent of the frame border means the board is
    // sliding out of view — the caller treats the pose as suspect.
    const marginX = frameWidth * 0.04;
    const marginY = frameHeight * 0.04;
    const nearEdge = inliers.some((p) =>
      p.marker.corners.some(
        (c) =>
          c.x < marginX || c.x > frameWidth - marginX ||
          c.y < marginY || c.y > frameHeight - marginY
      )
    );

    return {
      isFrontBoard: inliers[0].isFrontBoard,
      markers: inliers.map((p) => p.marker),
      position,
      quaternion,
      nearEdge,
      usesWholeBoardPose: Boolean(wholeBoard),
      markerSpacingDepth: estimateMarkerSpacingDepth(inliers.map((p) => p.marker), frameWidth),
    };
  }

  // --- Debug preview ----------------------------------------------------

  _drawDebug(imageData, markers, boardPose, assist) {
    const ctx = this.debugCtx;
    if (!ctx) return;
    const { width: w, height: h } = this.debugCanvas;
    ctx.save();
    ctx.scale(-1, 1); // mirrored, so moving right on screen matches you
    ctx.drawImage(this.video, -w, 0, w, h);
    ctx.restore();

    const sx = w / imageData.width;
    const sy = h / imageData.height;
    for (const marker of markers) {
      ctx.strokeStyle = marker.flowAge > 0 ? '#55e6ff' : FRONT_IDS.has(marker.id) ? '#3dff9b' : '#c895ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      marker.corners.forEach((c, i) => {
        const x = w - c.x * sx;
        const y = c.y * sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    if (!markers.length && assist) {
      ctx.strokeStyle = '#55e6ff';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(
        w - (assist.left + assist.width) * sx,
        assist.top * sy,
        assist.width * sx,
        assist.height * sy
      );
      ctx.setLineDash([]);
    }
  }
}

// --- Pure helpers (ported intact from the demo) -----------------------------

function estimateMarkerPose(marker, frameWidth, frameHeight) {
  const corners = marker.corners.map((c) => ({
    x: c.x - frameWidth / 2,
    y: frameHeight / 2 - c.y,
  }));
  const pose = new POS.Posit(MARKER_SIZE_MM, frameWidth).pose(corners);
  if (!Number.isFinite(pose.bestError) || pose.bestError < 0) return null;
  const r = pose.bestRotation;
  const t = pose.bestTranslation;
  // The preview and the position mirror X; reflect the rotation basis the
  // same way (M·R·M with M = diag(−1,1,1)) so the handle points correctly.
  const matrix = new THREE.Matrix4().set(
    r[0][0], -r[0][1], -r[0][2], 0,
    -r[1][0], r[1][1], r[1][2], 0,
    -r[2][0], r[2][1], r[2][2], 0,
    0, 0, 0, 1
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const position = new THREE.Vector3(-t[0] / 1000, t[1] / 1000, -t[2] / 1000);

  // POSIT returns the observed marker's centre; shift to the board centre so
  // every ID drives the same paddle location.
  const [cx, cy, cz] = MARKER_CENTRES_MM[marker.id];
  position.add(new THREE.Vector3(-cx / 1000, -cy / 1000, -cz / 1000).applyQuaternion(quaternion));

  const isFrontBoard = FRONT_IDS.has(marker.id);
  if (!isFrontBoard) {
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  }
  return { marker, isFrontBoard, position, quaternion, reprojectionError: pose.bestError };
}

function estimateOuterCornerBoardPose(markers, frameWidth, frameHeight) {
  const ids = FRONT_IDS.has(markers[0]?.id) ? [1, 2, 3, 4] : [5, 6, 7, 8];
  const byId = new Map(markers.map((m) => [m.id, m]));
  if (!ids.every((id) => byId.has(id))) return null;

  // The rigid 2×2 target's four outside corners form one large square with a
  // much longer baseline than any single marker: a far steadier plane normal.
  const rawCorners = [
    byId.get(ids[0]).corners[0],
    byId.get(ids[1]).corners[1],
    byId.get(ids[2]).corners[2],
    byId.get(ids[3]).corners[3],
  ];
  const corners = rawCorners.map((c) => ({ x: c.x - frameWidth / 2, y: frameHeight / 2 - c.y }));
  const boardSizeMm = 40 + MARKER_SIZE_MM;
  const pose = new POS.Posit(boardSizeMm, frameWidth).pose(corners);
  const averageSide = rawCorners.reduce((sum, c, i) => {
    const n = rawCorners[(i + 1) % rawCorners.length];
    return sum + Math.hypot(n.x - c.x, n.y - c.y);
  }, 0) / rawCorners.length;
  const maxError = Math.max(2.5, averageSide * 0.04);
  if (!Number.isFinite(pose.bestError) || pose.bestError < 0 || pose.bestError > maxError) return null;

  const r = pose.bestRotation;
  const matrix = new THREE.Matrix4().set(
    r[0][0], -r[0][1], -r[0][2], 0,
    -r[1][0], r[1][1], r[1][2], 0,
    -r[2][0], r[2][1], r[2][2], 0,
    0, 0, 0, 1
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  if (!FRONT_IDS.has(ids[0])) {
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  }
  return {
    position: new THREE.Vector3(
      -pose.bestTranslation[0] / 1000,
      pose.bestTranslation[1] / 1000,
      -pose.bestTranslation[2] / 1000
    ),
    quaternion,
    reprojectionError: pose.bestError,
  };
}

function estimateAllCornerBoardPose(markers, frameWidth, frameHeight) {
  if (markers.length < 2) return null;
  const halfMarker = MARKER_SIZE_MM / 2;
  const boardScaleMm = 40;
  const localCorners = [
    [-halfMarker, halfMarker],
    [halfMarker, halfMarker],
    [halfMarker, -halfMarker],
    [-halfMarker, -halfMarker],
  ];
  const correspondences = [];
  for (const marker of markers) {
    const centre = MARKER_CENTRES_MM[marker.id];
    if (!centre) continue;
    const decodeWeight = 1 / (1 + (marker.hammingDistance || 0));
    marker.corners.forEach((corner, index) => {
      correspondences.push({
        x: (centre[0] + localCorners[index][0]) / boardScaleMm,
        y: (centre[1] + localCorners[index][1]) / boardScaleMm,
        u: corner.x - frameWidth / 2,
        v: frameHeight / 2 - corner.y,
        weight: decodeWeight * (corner.quality || 0.5),
      });
    });
  }
  if (correspondences.length < 8) return null;

  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rhs = Array(8).fill(0);
  for (const point of correspondences) {
    const rows = [
      { c: [point.x, point.y, 1, 0, 0, 0, -point.u * point.x, -point.u * point.y], value: point.u },
      { c: [0, 0, 0, point.x, point.y, 1, -point.v * point.x, -point.v * point.y], value: point.v },
    ];
    for (const row of rows) {
      for (let col = 0; col < 8; col += 1) {
        rhs[col] += row.c[col] * row.value * point.weight;
        for (let other = 0; other < 8; other += 1) {
          normal[col][other] += row.c[col] * row.c[other] * point.weight;
        }
      }
    }
  }
  const h = solveLinearSystem(normal, rhs);
  if (!h) return null;

  const reprojectionError = Math.sqrt(
    correspondences.reduce((sum, point) => {
      const d = h[6] * point.x + h[7] * point.y + 1;
      const u = (h[0] * point.x + h[1] * point.y + h[2]) / d;
      const v = (h[3] * point.x + h[4] * point.y + h[5]) / d;
      return sum + (u - point.u) ** 2 + (v - point.v) ** 2;
    }, 0) / correspondences.length
  );
  if (!Number.isFinite(reprojectionError) || reprojectionError > 5) return null;

  const focal = frameWidth;
  const c1 = new THREE.Vector3(h[0] / focal, h[3] / focal, h[6]);
  const c2 = new THREE.Vector3(h[1] / focal, h[4] / focal, h[7]);
  const translation = new THREE.Vector3(h[2] / focal, h[5] / focal, 1);
  let scale = 2 / (c1.length() + c2.length());
  if (translation.z * scale < 0) scale *= -1;
  const r1 = c1.multiplyScalar(scale).normalize();
  const scaled2 = c2.multiplyScalar(scale);
  const r2 = scaled2.addScaledVector(r1, -r1.dot(scaled2)).normalize();
  const r3 = new THREE.Vector3().crossVectors(r1, r2).normalize();
  translation.multiplyScalar(scale * boardScaleMm);
  const matrix = new THREE.Matrix4().set(
    r1.x, -r2.x, -r3.x, 0,
    -r1.y, r2.y, r3.y, 0,
    -r1.z, r2.z, r3.z, 0,
    0, 0, 0, 1
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  if (!FRONT_IDS.has(markers[0].id)) {
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  }
  return {
    position: new THREE.Vector3(-translation.x / 1000, translation.y / 1000, -translation.z / 1000),
    quaternion,
    reprojectionError,
  };
}

function estimateMarkerSpacingDepth(markers, frameWidth) {
  if (markers.length < 2) return null;
  const estimates = [];
  for (let a = 0; a < markers.length - 1; a += 1) {
    for (let b = a + 1; b < markers.length; b += 1) {
      const [ax, ay] = MARKER_CENTRES_MM[markers[a].id];
      const [bx, by] = MARKER_CENTRES_MM[markers[b].id];
      const physical = Math.hypot(ax - bx, ay - by) / 1000;
      const image = markerCentre(markers[a]).distanceTo(markerCentre(markers[b]));
      if (physical > 0 && image > 2) estimates.push((frameWidth * physical) / image);
    }
  }
  if (!estimates.length) return null;
  estimates.sort((a, b) => a - b);
  return THREE.MathUtils.clamp(estimates[Math.floor(estimates.length / 2)], 0.2, 3);
}

function markerCentre(marker) {
  return marker.corners
    .reduce((c, corner) => c.add(new THREE.Vector2(corner.x, corner.y)), new THREE.Vector2())
    .multiplyScalar(1 / marker.corners.length);
}

function markerImageArea(marker) {
  let twiceArea = 0;
  for (let i = 0; i < marker.corners.length; i += 1) {
    const a = marker.corners[i];
    const b = marker.corners[(i + 1) % marker.corners.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return Math.max(1, Math.abs(twiceArea) / 2);
}

function rejectPoseOutliers(poses) {
  if (poses.length < 3) return poses;
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const centre = new THREE.Vector3(
    median(poses.map((p) => p.position.x)),
    median(poses.map((p) => p.position.y)),
    median(poses.map((p) => p.position.z))
  );
  const distances = poses.map((p) => p.position.distanceTo(centre));
  const threshold = Math.max(0.07, median(distances) * 2.5);
  const inliers = poses.filter((p) => p.position.distanceTo(centre) <= threshold);
  return inliers.length ? inliers : poses;
}

function rejectRotationOutliers(poses) {
  if (poses.length < 3) return poses;
  const reference = poses.reduce((best, candidate) => {
    const score = poses.reduce((sum, p) => sum + candidate.quaternion.angleTo(p.quaternion), 0);
    return !best || score < best.score ? { pose: candidate, score } : best;
  }, null).pose;
  const angles = poses.map((p) => reference.quaternion.angleTo(p.quaternion));
  const sorted = [...angles].sort((a, b) => a - b);
  const medianAngle = sorted[Math.floor(sorted.length / 2)];
  const threshold = THREE.MathUtils.clamp(
    medianAngle * 2.5,
    THREE.MathUtils.degToRad(5),
    THREE.MathUtils.degToRad(20)
  );
  const inliers = poses.filter((p, i) => angles[i] <= threshold);
  return inliers.length ? inliers : [reference];
}

function refineMarkerCorners(markers, grey) {
  return markers.map((marker) => {
    const averageSide = marker.corners.reduce((sum, corner, index) => {
      const next = marker.corners[(index + 1) % marker.corners.length];
      return sum + Math.hypot(next.x - corner.x, next.y - corner.y);
    }, 0) / marker.corners.length;
    const radius = THREE.MathUtils.clamp(Math.round(averageSide * 0.08), 2, 5);
    const corners = marker.corners.map((corner) => refineCorner(grey, corner, radius));
    return Object.assign(new AR.Marker(marker.id, corners, marker.hammingDistance), { flowAge: 0 });
  });
}

function refineCorner(grey, corner, radius) {
  const { width, height, data } = grey;
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  const cx = Math.round(corner.x);
  const cy = Math.round(corner.y);
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    if (y < 1 || y >= height - 1) continue;
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x < 1 || x >= width - 1) continue;
      const gx = data[y * width + x + 1] - data[y * width + x - 1];
      const gy = data[(y + 1) * width + x] - data[(y - 1) * width + x];
      a00 += gx * gx;
      a01 += gx * gy;
      a11 += gy * gy;
      b0 += gx * gx * x + gx * gy * y;
      b1 += gx * gy * x + gy * gy * y;
    }
  }
  const det = a00 * a11 - a01 * a01;
  if (Math.abs(det) < 1e-6) return { ...corner, quality: 0.1 };
  const rx = (a11 * b0 - a01 * b1) / det;
  const ry = (a00 * b1 - a01 * b0) / det;
  const trace = a00 + a11;
  const minEigen = (trace - Math.sqrt((a00 - a11) ** 2 + 4 * a01 ** 2)) / 2;
  const maxShift = 2.5;
  return {
    x: corner.x + THREE.MathUtils.clamp(rx - corner.x, -maxShift, maxShift),
    y: corner.y + THREE.MathUtils.clamp(ry - corner.y, -maxShift, maxShift),
    quality: THREE.MathUtils.clamp(minEigen / 20000, 0.1, 3),
  };
}

function buildGreyPyramid(grey) {
  const levels = [{ width: grey.width, height: grey.height, data: new Uint8Array(grey.data) }];
  for (let level = 1; level < 3; level += 1) {
    const source = levels[level - 1];
    const width = Math.floor(source.width / 2);
    const height = Math.floor(source.height / 2);
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sx = x * 2;
        const sy = y * 2;
        data[y * width + x] =
          (source.data[sy * source.width + sx] +
            source.data[sy * source.width + sx + 1] +
            source.data[(sy + 1) * source.width + sx] +
            source.data[(sy + 1) * source.width + sx + 1]) / 4;
      }
    }
    levels.push({ width, height, data });
  }
  return levels;
}

function trackCornerPyramid(prevPyramid, currentPyramid, corner) {
  const patchRadius = 2;
  let dxTotal = 0;
  let dyTotal = 0;
  let best = null;
  for (let level = prevPyramid.length - 1; level >= 0; level -= 1) {
    const prev = prevPyramid[level];
    const current = currentPyramid[level];
    const scale = 2 ** level;
    const sourceX = Math.round(corner.x / scale);
    const sourceY = Math.round(corner.y / scale);
    if (level < prevPyramid.length - 1) {
      dxTotal *= 2;
      dyTotal *= 2;
    }
    best = null;
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const targetX = sourceX + dxTotal + dx;
        const targetY = sourceY + dyTotal + dy;
        if (sourceX < patchRadius || sourceX >= prev.width - patchRadius) continue;
        if (sourceY < patchRadius || sourceY >= prev.height - patchRadius) continue;
        if (targetX < patchRadius || targetX >= current.width - patchRadius) continue;
        if (targetY < patchRadius || targetY >= current.height - patchRadius) continue;
        let error = 0;
        for (let py = -patchRadius; py <= patchRadius; py += 1) {
          for (let px = -patchRadius; px <= patchRadius; px += 1) {
            const a = prev.data[(sourceY + py) * prev.width + sourceX + px];
            const b = current.data[(targetY + py) * current.width + targetX + px];
            error += (a - b) ** 2;
          }
        }
        if (!best || error < best.error) best = { dx, dy, error };
      }
    }
    if (!best) return null;
    dxTotal += best.dx;
    dyTotal += best.dy;
  }
  if (!best || best.error / ((patchRadius * 2 + 1) ** 2) > 1800) return null;
  return refineCorner(currentPyramid[0], { x: corner.x + dxTotal, y: corner.y + dyTotal }, 3);
}

function boundsAroundMarkers(markers) {
  const corners = markers.flatMap((m) => m.corners);
  const left = Math.min(...corners.map((c) => c.x));
  const right = Math.max(...corners.map((c) => c.x));
  const top = Math.min(...corners.map((c) => c.y));
  const bottom = Math.max(...corners.map((c) => c.y));
  const padding = Math.max(right - left, bottom - top) * 0.35;
  return {
    left: left - padding,
    top: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, i) => [...row, values[i]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) bestRow = row;
    }
    if (Math.abs(augmented[bestRow][pivot]) < 1e-9) return null;
    [augmented[pivot], augmented[bestRow]] = [augmented[bestRow], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let col = pivot; col <= size; col += 1) augmented[pivot][col] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let col = pivot; col <= size; col += 1) augmented[row][col] -= factor * augmented[pivot][col];
    }
  }
  return augmented.map((row) => row[size]);
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
