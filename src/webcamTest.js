import * as THREE from 'three';
import { AR } from 'js-aruco2';
import * as CVModule from 'js-aruco2/src/cv.js';
import { POS } from 'js-aruco2/src/posit1.js';

const { CV } = CVModule.default;

// OpenCV / MATLAB DICT_4X4_250 entries 0–8. The MATLAB documentation's
// example uses this dictionary, and the first 250 entries of DICT_4X4_1000
// are the same family. We only need 0–8 for this paddle.
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
const HORIZONTAL_GAIN = 3.25;
const VERTICAL_GAIN = 1.75;
// Amplify small changes in the measured spacing between marker centres so
// short toward/away movements remain visible in the virtual paddle.
const DEPTH_GAIN = 10;
const VIRTUAL_DEPTH_ANCHOR = 10;
// Marker centres in millimetres relative to the paddle centre. This matches a
// 2×2 board of 3 cm markers with roughly 1 cm gaps, seen face-on.
const MARKER_CENTRES_MM = {
  1: [-20, 20, 0], 2: [20, 20, 0], 3: [20, -20, 0], 4: [-20, -20, 0],
  5: [-20, 20, 0], 6: [20, 20, 0], 7: [20, -20, 0], 8: [-20, -20, 0],
};

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
    this.derivative += this.alpha(this.derivativeCutoff, dt) * (rawDerivative - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += this.alpha(cutoff, dt) * (nextValue - this.value);
    this.rawValue = nextValue;
    this.lastTime = time;
    return this.value;
  }

  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

class VectorOneEuroFilter {
  constructor(options, zOptions = options) {
    this.x = new OneEuroFilter(options);
    this.y = new OneEuroFilter(options);
    // Depth needs to react more quickly because its input changes are much
    // smaller than the paddle's lateral movement.
    this.z = new OneEuroFilter(zOptions);
  }

  reset() {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }

  filter(vector, time) {
    return new THREE.Vector3(
      this.x.filter(vector.x, time),
      this.y.filter(vector.y, time),
      this.z.filter(vector.z, time)
    );
  }
}

class PredictivePositionFilter {
  constructor({ alpha = 0.52, beta = 0.11, predictionLead = 0.035 } = {}) {
    this.alpha = alpha;
    this.beta = beta;
    this.predictionLead = predictionLead;
    this.reset();
  }

  reset() {
    this.position = null;
    this.velocity = new THREE.Vector3();
    this.lastTime = null;
  }

  filter(measurement, time) {
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
    return this.position.clone().addScaledVector(this.velocity, this.predictionLead);
  }
}
const video = document.querySelector('#video');
const overlay = document.querySelector('#video-overlay');
const overlayContext = overlay.getContext('2d');
const startButton = document.querySelector('#start-camera');
const calibrateButton = document.querySelector('#calibrate');
const autoCalibrateButton = document.querySelector('#auto-calibrate');
const cameraSelect = document.querySelector('#camera-select');
const dictionarySelect = document.querySelector('#dictionary');
const markerSizeInput = document.querySelector('#marker-size');
const focalScaleInput = document.querySelector('#focal-scale');
const lensK1Input = document.querySelector('#lens-k1');
const status = document.querySelector('#status');
const confidence = document.querySelector('#confidence');
const frame = document.createElement('canvas');
const frameContext = frame.getContext('2d', { willReadFrequently: true });

let detector = makeDetector();
let active = false;
let activeStream = null;
let lastPoseAt = 0;
let activePaddleFace = 'red';
let calibration = null;
let latestPoseForCalibration = null;
let smoothedQuaternion = null;
let lastQuaternionAt = null;
let lastSmoothedPoseAt = 0;
const positionHistory = [];
let previousGreyFrame = null;
let previousPaddleMarkers = [];
let stableTrackingMode = 'lost';
let pendingTrackingMode = 'lost';
let pendingTrackingFrames = 0;
let lastPaddleBounds = null;
let collectingCameraCalibration = false;
let cameraCalibrationFrame = 0;
const cameraCalibrationSamples = [];
const positionSmoother = new VectorOneEuroFilter(
  { minCutoff: 0.9, beta: 0.8 },
  { minCutoff: 1.1, beta: 0.9 }
);
const predictivePositionFilter = new PredictivePositionFilter();
const { paddle } = makeVirtualPaddleView();

function makeDetector() {
  const nextDetector = new AR.Detector({ dictionaryName: dictionarySelect.value });
  nextDetector.detect = detectWithAdaptiveThresholdFallback;
  return nextDetector;
}

function thresholdCandidates(detectorInstance, image, blurRadius) {
  // js-aruco2 expresses the adaptive window as a blur radius, so radii
  // 1, 6, and 11 correspond to OpenCV-style windows 3, 13, and 23.
  CV.adaptiveThreshold(detectorInstance.grey, detectorInstance.thres, blurRadius, 7);
  const contours = CV.findContours(detectorInstance.thres, detectorInstance.binary);
  detectorInstance.contours.push(...contours);
  return detectorInstance.findCandidates(contours, image.width * 0.01, 0.05, 10);
}

function prepareCandidates(detectorInstance, candidates) {
  return detectorInstance.notTooNear(detectorInstance.clockwiseCorners(candidates), 10);
}

function detectWithAdaptiveThresholdFallback(image) {
  CV.grayscale(image, this.grey);
  this.contours = [];

  // Preserve the library's inexpensive 5x5 pass for clear frames. If it
  // cannot recover at least two markers, retry the wider OpenCV-style range
  // to handle uneven lighting and borders softened by motion blur.
  const defaultCandidates = thresholdCandidates(this, image, 2);
  this.candidates = prepareCandidates(this, defaultCandidates);
  const defaultMarkers = this.findMarkers(this.grey, this.candidates, 49);
  if (defaultMarkers.length >= 2) return defaultMarkers;

  const fallbackCandidates = [...defaultCandidates];
  for (const blurRadius of [1, 6, 11]) {
    fallbackCandidates.push(...thresholdCandidates(this, image, blurRadius));
  }
  this.candidates = prepareCandidates(this, fallbackCandidates);
  return this.findMarkers(this.grey, this.candidates, 49);
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = kind;
}

function setConfidence(message, kind) {
  confidence.textContent = `Confidence: ${message}`;
  confidence.className = kind;
}

function updateTrackingMode(nextMode) {
  if (nextMode === stableTrackingMode) {
    pendingTrackingMode = nextMode;
    pendingTrackingFrames = 0;
    return stableTrackingMode;
  }
  if (nextMode !== pendingTrackingMode) {
    pendingTrackingMode = nextMode;
    pendingTrackingFrames = 1;
  } else {
    pendingTrackingFrames += 1;
  }
  const requiredFrames = stableTrackingMode === 'lost' ? 2 : nextMode === 'lost' ? 6 : 3;
  if (pendingTrackingFrames >= requiredFrames) {
    stableTrackingMode = nextMode;
    pendingTrackingFrames = 0;
  }
  return stableTrackingMode;
}

dictionarySelect.addEventListener('change', () => {
  detector = makeDetector();
  setStatus(`Using ${dictionarySelect.value}; show a marker`);
});

for (const input of [focalScaleInput, lensK1Input]) {
  input.addEventListener('change', () => {
    calibration = null;
    positionHistory.length = 0;
    positionSmoother.reset();
    predictivePositionFilter.reset();
    smoothedQuaternion = null;
    setStatus('Camera model updated — recalibrate the neutral pose');
  });
}

startButton.addEventListener('click', startCamera);
cameraSelect.addEventListener('change', startCamera);
calibrateButton.addEventListener('click', () => {
  if (!latestPoseForCalibration) return;
  calibration = {
    position: latestPoseForCalibration.position.clone(),
    quaternion: latestPoseForCalibration.quaternion.clone(),
    // Normalising a pose to identity would always render the same blade face.
    // Keep the face that was actually visible at calibration as the neutral
    // render orientation instead.
    neutralRenderQuaternion: latestPoseForCalibration.isFrontBoard
      ? new THREE.Quaternion()
      : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
  };
  positionSmoother.reset();
  predictivePositionFilter.reset();
  positionHistory.length = 0;
  smoothedQuaternion = null;
  setStatus('Neutral pose calibrated — move the paddle naturally from this position', 'tracking');
});

autoCalibrateButton.addEventListener('click', () => {
  collectingCameraCalibration = true;
  cameraCalibrationFrame = 0;
  cameraCalibrationSamples.length = 0;
  setStatus('Camera calibration: slowly tilt the full marker board in several directions', 'tracking');
});

async function startCamera() {
  try {
    activeStream?.getTracks().forEach((track) => track.stop());
    previousGreyFrame = null;
    previousPaddleMarkers = [];
    const selectedDevice = cameraSelect.value;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(selectedDevice ? { deviceId: { exact: selectedDevice } } : { facingMode: 'user' }),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    activeStream = stream;
    await optimizeCameraForTracking(stream.getVideoTracks()[0]);
    video.srcObject = stream;
    await video.play();
    resizeOverlay();
    active = true;
    startButton.textContent = 'Webcam running';
    startButton.disabled = true;
    autoCalibrateButton.disabled = false;
    await populateCameras();
    setStatus('Looking for IDs 1–8…');
    requestAnimationFrame(trackFrame);
  } catch (error) {
    console.error(error);
    setStatus(`Could not start webcam: ${error.message}`, 'error');
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
  } catch (error) {
    console.info('Camera does not support all tracking constraints', error);
  }
}

async function populateCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const selectedDevice = activeStream?.getVideoTracks()[0]?.getSettings().deviceId || cameraSelect.value;
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  cameraSelect.replaceChildren();
  for (const [index, camera] of cameras.entries()) {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${index + 1}`;
    option.selected = camera.deviceId === selectedDevice;
    cameraSelect.appendChild(option);
  }
}

function markerSizeMm() {
  return Math.max(1, Number(markerSizeInput.value) || 3) * 10;
}

function focalLengthPixels(frameWidth) {
  return frameWidth * THREE.MathUtils.clamp(Number(focalScaleInput.value) || 1, 0.5, 2);
}

function undistortCorner(corner, frameWidth, frameHeight) {
  const focalLength = focalLengthPixels(frameWidth);
  const distortedX = (corner.x - frameWidth / 2) / focalLength;
  const distortedY = (frameHeight / 2 - corner.y) / focalLength;
  const radialScale = 1 + (Number(lensK1Input.value) || 0) * (distortedX ** 2 + distortedY ** 2);
  return {
    x: (distortedX / radialScale) * focalLength,
    y: (distortedY / radialScale) * focalLength,
  };
}

function collectCameraCalibrationSample(markers, frameWidth, frameHeight) {
  if (!collectingCameraCalibration) return;
  cameraCalibrationFrame += 1;
  if (cameraCalibrationFrame % 5 !== 0) return;
  const frontMarkers = markers.filter((marker) => FRONT_IDS.has(marker.id));
  const backMarkers = markers.filter((marker) => BACK_IDS.has(marker.id));
  const boardMarkers = frontMarkers.length >= 4 ? frontMarkers : backMarkers.length >= 4 ? backMarkers : null;
  if (!boardMarkers) return;
  const estimate = estimateFocalScaleFromBoard(boardMarkers, frameWidth, frameHeight, 0);
  if (!estimate) return;
  cameraCalibrationSamples.push({
    markers: boardMarkers.map((marker) => new AR.Marker(marker.id, marker.corners.map((corner) => ({ ...corner })), marker.hammingDistance)),
    frameWidth,
    frameHeight,
  });
  autoCalibrateButton.textContent = `Calibrating ${cameraCalibrationSamples.length}/24`;
  if (cameraCalibrationSamples.length < 24) return;

  let bestLensK1 = 0;
  let bestLensError = Infinity;
  for (let lensK1 = -0.5; lensK1 <= 0.5001; lensK1 += 0.025) {
    const error = cameraCalibrationSamples.reduce((sum, sample) => sum + calibrationHomographyError(sample, lensK1), 0);
    if (error < bestLensError) {
      bestLensError = error;
      bestLensK1 = lensK1;
    }
  }
  const focalEstimates = cameraCalibrationSamples
    .map((sample) => estimateFocalScaleFromBoard(sample.markers, sample.frameWidth, sample.frameHeight, bestLensK1))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const focalScale = focalEstimates[Math.floor(focalEstimates.length / 2)] || 1;
  focalScaleInput.value = focalScale.toFixed(3);
  lensK1Input.value = bestLensK1.toFixed(3);
  collectingCameraCalibration = false;
  autoCalibrateButton.textContent = 'Auto-calibrate camera';
  calibration = null;
  positionHistory.length = 0;
  positionSmoother.reset();
  predictivePositionFilter.reset();
  smoothedQuaternion = null;
  setStatus(`Camera calibrated: focal ${focalScale.toFixed(3)}, k1 ${bestLensK1.toFixed(3)} — now recalibrate neutral pose`, 'tracking');
}

function estimateFocalScaleFromBoard(markers, frameWidth, frameHeight, lensK1) {
  const halfMarker = markerSizeMm() / 2;
  const localCorners = [[-halfMarker, halfMarker], [halfMarker, halfMarker], [halfMarker, -halfMarker], [-halfMarker, -halfMarker]];
  const points = [];
  for (const marker of markers) {
    const centre = MARKER_CENTRES_MM[marker.id];
    marker.corners.forEach((corner, index) => {
      const distortedX = (corner.x - frameWidth / 2) / frameWidth;
      const distortedY = (frameHeight / 2 - corner.y) / frameWidth;
      const radialScale = 1 + lensK1 * (distortedX ** 2 + distortedY ** 2);
      points.push({
        x: (centre[0] + localCorners[index][0]) / 40,
        y: (centre[1] + localCorners[index][1]) / 40,
        u: (distortedX / radialScale) * frameWidth,
        v: (distortedY / radialScale) * frameWidth,
      });
    });
  }
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rightHandSide = Array(8).fill(0);
  for (const point of points) {
    const rows = [
      { coefficients: [point.x, point.y, 1, 0, 0, 0, -point.u * point.x, -point.u * point.y], value: point.u },
      { coefficients: [0, 0, 0, point.x, point.y, 1, -point.v * point.x, -point.v * point.y], value: point.v },
    ];
    for (const row of rows) {
      for (let column = 0; column < 8; column += 1) {
        rightHandSide[column] += row.coefficients[column] * row.value;
        for (let other = 0; other < 8; other += 1) normal[column][other] += row.coefficients[column] * row.coefficients[other];
      }
    }
  }
  const h = solveLinearSystem(normal, rightHandSide);
  if (!h) return null;
  const estimatesSquared = [];
  const orthogonalDenominator = h[6] * h[7];
  if (Math.abs(orthogonalDenominator) > 1e-8) estimatesSquared.push(-(h[0] * h[1] + h[3] * h[4]) / orthogonalDenominator);
  const equalNormDenominator = h[6] ** 2 - h[7] ** 2;
  if (Math.abs(equalNormDenominator) > 1e-8) estimatesSquared.push(-(h[0] ** 2 + h[3] ** 2 - h[1] ** 2 - h[4] ** 2) / equalNormDenominator);
  const estimates = estimatesSquared
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.sqrt(value) / frameWidth)
    .filter((value) => value >= 0.5 && value <= 2);
  if (!estimates.length) return null;
  return estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
}

function calibrationHomographyError(sample, lensK1) {
  const halfMarker = markerSizeMm() / 2;
  const localCorners = [[-halfMarker, halfMarker], [halfMarker, halfMarker], [halfMarker, -halfMarker], [-halfMarker, -halfMarker]];
  const points = [];
  for (const marker of sample.markers) {
    const centre = MARKER_CENTRES_MM[marker.id];
    marker.corners.forEach((corner, index) => {
      const distortedX = (corner.x - sample.frameWidth / 2) / sample.frameWidth;
      const distortedY = (sample.frameHeight / 2 - corner.y) / sample.frameWidth;
      const radialScale = 1 + lensK1 * (distortedX ** 2 + distortedY ** 2);
      points.push({
        x: (centre[0] + localCorners[index][0]) / 40,
        y: (centre[1] + localCorners[index][1]) / 40,
        u: (distortedX / radialScale) * sample.frameWidth,
        v: (distortedY / radialScale) * sample.frameWidth,
      });
    });
  }
  const h = fitCalibrationHomography(points);
  if (!h) return 1e6;
  return Math.sqrt(points.reduce((sum, point) => {
    const denominator = h[6] * point.x + h[7] * point.y + 1;
    const u = (h[0] * point.x + h[1] * point.y + h[2]) / denominator;
    const v = (h[3] * point.x + h[4] * point.y + h[5]) / denominator;
    return sum + (u - point.u) ** 2 + (v - point.v) ** 2;
  }, 0) / points.length);
}

function fitCalibrationHomography(points) {
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rightHandSide = Array(8).fill(0);
  for (const point of points) {
    const rows = [
      { coefficients: [point.x, point.y, 1, 0, 0, 0, -point.u * point.x, -point.u * point.y], value: point.u },
      { coefficients: [0, 0, 0, point.x, point.y, 1, -point.v * point.x, -point.v * point.y], value: point.v },
    ];
    for (const row of rows) {
      for (let column = 0; column < 8; column += 1) {
        rightHandSide[column] += row.coefficients[column] * row.value;
        for (let other = 0; other < 8; other += 1) normal[column][other] += row.coefficients[column] * row.coefficients[other];
      }
    }
  }
  return solveLinearSystem(normal, rightHandSide);
}

function resizeOverlay() {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
}

function trackFrame() {
  if (!active) return;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) resizeOverlay();
    detectAndRender();
  }
  requestAnimationFrame(trackFrame);
}

function detectAndRender() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  frameContext.drawImage(video, 0, 0, width, height);
  const imageData = frameContext.getImageData(0, 0, width, height);
  const colourPaddleCandidate = findPaddleByColour(imageData, activePaddleFace);
  const markers = refineMarkerCorners(detector.detect(imageData), detector.grey);
  const detectedPaddleAssist = colourPaddleCandidate?.colour === 'black'
    ? validateBlackPaddleCandidate(colourPaddleCandidate, imageData, detector.candidates)
    : colourPaddleCandidate;
  const decodedPaddleMarkers = markers.filter((marker) => FRONT_IDS.has(marker.id) || BACK_IDS.has(marker.id));
  collectCameraCalibrationSample(decodedPaddleMarkers, width, height);
  const paddleMarkers = recoverMarkersWithOpticalFlow(decodedPaddleMarkers, detector.grey);
  rememberTrackingFrame(detector.grey, paddleMarkers);
  const boardPose = estimateBoardPose(paddleMarkers, width, height);

  overlayContext.clearRect(0, 0, width, height);
  detector.candidates.forEach(drawCandidateBox);
  paddleMarkers.forEach(drawMarker);

  if (!boardPose) {
    // Permit only a short marker-free fallback. Unlike a generic dark object,
    // a black candidate has already been required to contain the target's
    // white square surrounds and at least one ArUco-like square candidate.
    const recentlyConfirmed = performance.now() - lastPoseAt < 750;
    const fallbackAssist = recentlyConfirmed ? detectedPaddleAssist : null;
    if (fallbackAssist) {
      updateTrackingMode('colour');
      lastPaddleBounds = { ...fallbackAssist };
      drawPaddleAssist(fallbackAssist);
      applyColourPaddlePosition(fallbackAssist, width, height);
      setStatus(`${fallbackAssist.colour} paddle fallback — position is live; hold a marker toward the camera for angle tracking`, 'tracking');
      setConfidence('low — colour fallback', 'low');
      return;
    }
    updateTrackingMode('lost');
    if (performance.now() - lastPoseAt > 300) {
      const candidateCount = detector.candidates.length;
      setStatus(
        candidateCount > 0
          ? `${candidateCount} square${candidateCount === 1 ? '' : 's'} seen, but no IDs decoded — choose the printed marker dictionary`
          : 'No square candidates — move closer, brighten the marker, and keep it fully in frame'
      );
    }
    setConfidence('low — no tracked paddle', 'low');
    return;
  }

  const isFrontBoard = boardPose.isFrontBoard;
  activePaddleFace = isFrontBoard ? 'red' : 'black';
  // The assist may have been measured using the previous face on this one
  // transition frame. Use it only when it matches the decoded marker face.
  const matchingAssist = detectedPaddleAssist?.colour === activePaddleFace ? detectedPaddleAssist : null;
  const assistConsistent = !matchingAssist || markersFitPaddleAssist(boardPose.markers, matchingAssist);
  const acceptedAssist = assistConsistent ? matchingAssist : null;
  const currentTrackingMode = boardPose.flowMarkerCount ? 'flow' : 'markers';
  updateTrackingMode(currentTrackingMode);
  if (acceptedAssist) drawPaddleAssist(acceptedAssist);
  lastPaddleBounds = acceptedAssist ? { ...acceptedAssist } : boundsAroundMarkers(boardPose.markers);
  applyBoardPose(boardPose, acceptedAssist, width, height);
  lastPoseAt = performance.now();
  const side = isFrontBoard ? 'front / red' : 'back / black';
  calibrateButton.disabled = false;
  const markerCount = boardPose.markers.length;
  const decodedMarkerCount = markerCount - boardPose.flowMarkerCount;
  const confidenceKind = !assistConsistent ? 'low' : boardPose.usesWholeBoardPose ? 'high' : 'medium';
  const confidenceLabel = !assistConsistent
    ? 'low — marker/silhouette mismatch'
    : `${confidenceKind} — ${boardPose.usesWholeBoardPose ? 'whole-board' : 'marker'} pose, ${boardPose.reprojectionError.toFixed(1)} px error, ${stableTrackingMode}`;
  setConfidence(confidenceLabel, confidenceKind);
  const rejectedNote = boardPose.rejectedMarkerCount ? `; ignored ${boardPose.rejectedMarkerCount} outlier` : '';
  const flowNote = boardPose.flowMarkerCount ? `; ${boardPose.flowMarkerCount} held by optical flow` : '';
  setStatus(`Tracking ${side} board with ${decodedMarkerCount}/${boardPose.detectedMarkerCount} decoded marker${boardPose.detectedMarkerCount === 1 ? '' : 's'}${flowNote}${rejectedNote}`, 'tracking');
}

function boundsAroundMarkers(markers) {
  const corners = markers.flatMap((marker) => marker.corners);
  const left = Math.min(...corners.map((corner) => corner.x));
  const right = Math.max(...corners.map((corner) => corner.x));
  const top = Math.min(...corners.map((corner) => corner.y));
  const bottom = Math.max(...corners.map((corner) => corner.y));
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

function refineMarkerCorners(markers, greyImage) {
  return markers.map((marker) => {
    const averageSide = marker.corners.reduce((sum, corner, index) => {
      const next = marker.corners[(index + 1) % marker.corners.length];
      return sum + Math.hypot(next.x - corner.x, next.y - corner.y);
    }, 0) / marker.corners.length;
    const radius = THREE.MathUtils.clamp(Math.round(averageSide * 0.08), 2, 5);
    const corners = marker.corners.map((corner) => refineCorner(greyImage, corner, radius));
    return Object.assign(new AR.Marker(marker.id, corners, marker.hammingDistance), { flowAge: 0 });
  });
}

function refineCorner(greyImage, corner, radius) {
  const { width, height, data } = greyImage;
  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b0 = 0;
  let b1 = 0;
  const centreX = Math.round(corner.x);
  const centreY = Math.round(corner.y);
  for (let y = centreY - radius; y <= centreY + radius; y += 1) {
    if (y < 1 || y >= height - 1) continue;
    for (let x = centreX - radius; x <= centreX + radius; x += 1) {
      if (x < 1 || x >= width - 1) continue;
      const gx = data[y * width + x + 1] - data[y * width + x - 1];
      const gy = data[(y + 1) * width + x] - data[(y - 1) * width + x];
      const xx = gx * gx;
      const xy = gx * gy;
      const yy = gy * gy;
      a00 += xx;
      a01 += xy;
      a11 += yy;
      b0 += xx * x + xy * y;
      b1 += xy * x + yy * y;
    }
  }
  const determinant = a00 * a11 - a01 * a01;
  if (Math.abs(determinant) < 1e-6) return { ...corner, quality: 0.1 };
  const refinedX = (a11 * b0 - a01 * b1) / determinant;
  const refinedY = (a00 * b1 - a01 * b0) / determinant;
  const trace = a00 + a11;
  const minimumEigenvalue = (trace - Math.sqrt((a00 - a11) ** 2 + 4 * a01 ** 2)) / 2;
  const maxShift = 2.5;
  return {
    x: corner.x + THREE.MathUtils.clamp(refinedX - corner.x, -maxShift, maxShift),
    y: corner.y + THREE.MathUtils.clamp(refinedY - corner.y, -maxShift, maxShift),
    quality: THREE.MathUtils.clamp(minimumEigenvalue / 20000, 0.1, 3),
  };
}

function recoverMarkersWithOpticalFlow(decodedMarkers, currentGrey) {
  if (!previousGreyFrame || previousGreyFrame.width !== currentGrey.width || previousGreyFrame.height !== currentGrey.height) {
    return decodedMarkers;
  }
  const decodedIds = new Set(decodedMarkers.map((marker) => marker.id));
  const recoverableMarkers = previousPaddleMarkers.filter(
    (marker) => !decodedIds.has(marker.id) && (marker.flowAge || 0) < 3
  );
  if (!recoverableMarkers.length) return decodedMarkers;
  const previousPyramid = buildGreyPyramid(previousGreyFrame);
  const currentPyramid = buildGreyPyramid(currentGrey);
  const recovered = [];
  for (const marker of recoverableMarkers) {
    const corners = marker.corners.map((corner) => trackCornerPyramid(previousPyramid, currentPyramid, corner));
    if (corners.some((corner) => !corner)) continue;
    recovered.push(Object.assign(
      new AR.Marker(marker.id, corners, marker.hammingDistance),
      { flowAge: (marker.flowAge || 0) + 1 }
    ));
  }
  return [...decodedMarkers, ...recovered];
}

function buildGreyPyramid(greyImage) {
  const levels = [{ width: greyImage.width, height: greyImage.height, data: new Uint8Array(greyImage.data) }];
  for (let level = 1; level < 3; level += 1) {
    const source = levels[level - 1];
    const width = Math.floor(source.width / 2);
    const height = Math.floor(source.height / 2);
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = x * 2;
        const sourceY = y * 2;
        data[y * width + x] = (
          source.data[sourceY * source.width + sourceX]
          + source.data[sourceY * source.width + sourceX + 1]
          + source.data[(sourceY + 1) * source.width + sourceX]
          + source.data[(sourceY + 1) * source.width + sourceX + 1]
        ) / 4;
      }
    }
    levels.push({ width, height, data });
  }
  return levels;
}

function trackCornerPyramid(previousPyramid, currentPyramid, corner) {
  const patchRadius = 2;
  let displacementX = 0;
  let displacementY = 0;
  let best = null;
  for (let level = previousPyramid.length - 1; level >= 0; level -= 1) {
    const previousGrey = previousPyramid[level];
    const currentGrey = currentPyramid[level];
    const scale = 2 ** level;
    const sourceX = Math.round(corner.x / scale);
    const sourceY = Math.round(corner.y / scale);
    if (level < previousPyramid.length - 1) {
      displacementX *= 2;
      displacementY *= 2;
    }
    best = null;
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const targetX = sourceX + displacementX + dx;
        const targetY = sourceY + displacementY + dy;
        if (sourceX < patchRadius || sourceX >= previousGrey.width - patchRadius || sourceY < patchRadius || sourceY >= previousGrey.height - patchRadius) continue;
        if (targetX < patchRadius || targetX >= currentGrey.width - patchRadius || targetY < patchRadius || targetY >= currentGrey.height - patchRadius) continue;
        let squaredError = 0;
        for (let py = -patchRadius; py <= patchRadius; py += 1) {
          for (let px = -patchRadius; px <= patchRadius; px += 1) {
            const previousValue = previousGrey.data[(sourceY + py) * previousGrey.width + sourceX + px];
            const currentValue = currentGrey.data[(targetY + py) * currentGrey.width + targetX + px];
            squaredError += (previousValue - currentValue) ** 2;
          }
        }
        if (!best || squaredError < best.error) best = { dx, dy, error: squaredError };
      }
    }
    if (!best) return null;
    displacementX += best.dx;
    displacementY += best.dy;
  }
  if (!best || best.error / ((patchRadius * 2 + 1) ** 2) > 1800) return null;
  return refineCorner(currentPyramid[0], {
    x: corner.x + displacementX,
    y: corner.y + displacementY,
  }, 3);
}

function rememberTrackingFrame(greyImage, markers) {
  previousGreyFrame = {
    width: greyImage.width,
    height: greyImage.height,
    data: new Uint8Array(greyImage.data),
  };
  previousPaddleMarkers = markers.map((marker) => Object.assign(
    new AR.Marker(marker.id, marker.corners.map((corner) => ({ ...corner })), marker.hammingDistance),
    { flowAge: marker.flowAge || 0 }
  ));
}

function drawMarker(marker) {
  const color = marker.flowAge > 0 ? '#55e6ff' : FRONT_IDS.has(marker.id) ? '#3dff9b' : '#c895ff';
  const corners = marker.corners;
  overlayContext.save();
  overlayContext.strokeStyle = color;
  overlayContext.fillStyle = color;
  overlayContext.lineWidth = Math.max(2, overlay.width / 400);
  overlayContext.beginPath();
  overlayContext.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i += 1) overlayContext.lineTo(corners[i].x, corners[i].y);
  overlayContext.closePath();
  overlayContext.stroke();
  overlayContext.font = `bold ${Math.max(16, overlay.width / 32)}px system-ui`;
  overlayContext.fillText(`${marker.flowAge > 0 ? 'FLOW ' : ''}ID ${marker.id}`, corners[0].x + 6, corners[0].y - 7);
  overlayContext.restore();
}

// Candidate boxes are deliberately per-square. They are a visual diagnostic
// only; unlike the coloured marker outline, an amber box has not decoded an ID.
function drawCandidateBox(corners) {
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;

  overlayContext.save();
  overlayContext.strokeStyle = '#ffb84d';
  overlayContext.lineWidth = Math.max(2, overlay.width / 500);
  overlayContext.setLineDash([7, 4]);
  overlayContext.strokeRect(left, top, width, height);
  overlayContext.restore();
}

function drawPaddleAssist(bounds) {
  overlayContext.save();
  overlayContext.strokeStyle = '#55e6ff';
  overlayContext.fillStyle = '#55e6ff';
  overlayContext.lineWidth = Math.max(2, overlay.width / 450);
  overlayContext.setLineDash([10, 5]);
  overlayContext.strokeRect(bounds.left, bounds.top, bounds.width, bounds.height);
  overlayContext.setLineDash([]);
  overlayContext.font = `bold ${Math.max(14, overlay.width / 48)}px system-ui`;
  const structureNote = bounds.colour === 'black' ? ` · ${bounds.whiteSquareCount} white squares` : '';
  overlayContext.fillText(`${bounds.colour.toUpperCase()} PADDLE ASSIST${structureNote}`, bounds.left + 6, Math.max(20, bounds.top - 7));
  overlayContext.restore();
}

// A deliberately lightweight colour segmentation pass. The latest decoded ID
// selects red (IDs 1–4) or black (IDs 5–8); marker IDs still provide 3D pose.
function findPaddleByColour(imageData, colour) {
  const sample = 4;
  const width = Math.floor(imageData.width / sample);
  const height = Math.floor(imageData.height / sample);
  const mask = new Uint8Array(width * height);
  const { data } = imageData;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((y * sample * imageData.width) + x * sample) * 4;
      const red = data[source];
      const green = data[source + 1];
      const blue = data[source + 2];
      const isRed = red > 85 && red > green * 1.35 && red > blue * 1.35 && red - green > 40;
      // Require low brightness and low colour spread for the black side. This
      // rejects saturated dark colours better than a simple luminance cutoff.
      const isBlack = Math.max(red, green, blue) < 80 && Math.max(red, green, blue) - Math.min(red, green, blue) < 35;
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
    let stackSize = 1;
    stack[0] = start;
    mask[start] = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (stackSize) {
      const index = stack[--stackSize];
      const x = index % width;
      const y = (index - x) / width;
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (x > 0 && mask[index - 1]) {
        mask[index - 1] = 0;
        stack[stackSize++] = index - 1;
      }
      if (x < width - 1 && mask[index + 1]) {
        mask[index + 1] = 0;
        stack[stackSize++] = index + 1;
      }
      if (y > 0 && mask[index - width]) {
        mask[index - width] = 0;
        stack[stackSize++] = index - width;
      }
      if (y < height - 1 && mask[index + width]) {
        mask[index + width] = 0;
        stack[stackSize++] = index + width;
      }
    }
    const centerX = ((minX + maxX + 1) * sample) / 2;
    const centerY = ((minY + maxY + 1) * sample) / 2;
    let score = count;
    if (lastPaddleBounds && performance.now() - lastPoseAt < 1200) {
      const distanceSquared = (centerX - lastPaddleBounds.centerX) ** 2 + (centerY - lastPaddleBounds.centerY) ** 2;
      const trackingRadiusSquared = Math.max(lastPaddleBounds.width, lastPaddleBounds.height) ** 2;
      score /= 1 + distanceSquared / Math.max(1, trackingRadiusSquared);
    }
    if (!largest || score > largest.score) largest = { count, score, minX, maxX, minY, maxY };
  }

  if (!largest || largest.count < width * height * 0.015) return null;
  const padding = sample * 3;
  const left = Math.max(0, largest.minX * sample - padding);
  const top = Math.max(0, largest.minY * sample - padding);
  const right = Math.min(imageData.width, (largest.maxX + 1) * sample + padding);
  const bottom = Math.min(imageData.height, (largest.maxY + 1) * sample + padding);
  const boxWidth = right - left;
  const boxHeight = bottom - top;
  return {
    left,
    top,
    width: boxWidth,
    height: boxHeight,
    centerX: left + boxWidth / 2,
    centerY: top + boxHeight / 2,
    // A tilted round paddle still preserves its long ellipse axis, so it is a
    // more stable distance estimate than the short axis.
    diameter: Math.max(boxWidth, boxHeight),
    colour,
  };
}

function validateBlackPaddleCandidate(bounds, imageData, squareCandidates) {
  const whiteSquareCount = countWhiteSquaresInside(bounds, imageData);
  const arucoCandidateCount = squareCandidates.filter((corners) => {
    const centerX = corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length;
    const centerY = corners.reduce((sum, corner) => sum + corner.y, 0) / corners.length;
    return centerX >= bounds.left && centerX <= bounds.left + bounds.width
      && centerY >= bounds.top && centerY <= bounds.top + bounds.height;
  }).length;

  if (whiteSquareCount < 2 || arucoCandidateCount < 1) return null;
  return { ...bounds, whiteSquareCount, arucoCandidateCount };
}

function countWhiteSquaresInside(bounds, imageData) {
  const sample = 3;
  const width = Math.max(1, Math.floor(bounds.width / sample));
  const height = Math.max(1, Math.floor(bounds.height / sample));
  const mask = new Uint8Array(width * height);
  const { data } = imageData;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const imageX = Math.min(imageData.width - 1, Math.floor(bounds.left + (x + 0.5) * sample));
      const imageY = Math.min(imageData.height - 1, Math.floor(bounds.top + (y + 0.5) * sample));
      const source = (imageY * imageData.width + imageX) * 4;
      const red = data[source];
      const green = data[source + 1];
      const blue = data[source + 2];
      const brightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      if (darkest > 155 && brightest - darkest < 55) mask[y * width + x] = 1;
    }
  }

  let squareCount = 0;
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start]) continue;
    let stackSize = 1;
    let count = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    stack[0] = start;
    mask[start] = 0;
    while (stackSize) {
      const index = stack[--stackSize];
      const x = index % width;
      const y = (index - x) / width;
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const neighbour of [index - 1, index + 1, index - width, index + width]) {
        if (neighbour < 0 || neighbour >= mask.length || !mask[neighbour]) continue;
        const neighbourX = neighbour % width;
        if (Math.abs(neighbourX - x) > 1) continue;
        mask[neighbour] = 0;
        stack[stackSize++] = neighbour;
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const aspect = componentWidth / componentHeight;
    const boxFraction = (componentWidth * componentHeight) / (width * height);
    const fill = count / (componentWidth * componentHeight);
    const touchesCropEdge = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    if (!touchesCropEdge && aspect >= 0.6 && aspect <= 1.65 && boxFraction >= 0.006 && boxFraction <= 0.22 && fill >= 0.18) {
      squareCount += 1;
    }
  }
  return squareCount;
}

function colourPaddlePosition(bounds, frameWidth, frameHeight) {
  const paddleDiameter = 0.17; // regulation racket head, in metres
  const focalLength = frameWidth;
  const rawDepth = (focalLength * paddleDiameter) / bounds.diameter;
  const cameraDepth = THREE.MathUtils.clamp(rawDepth, 0.2, 3);
  return new THREE.Vector3(
    -((bounds.centerX - frameWidth / 2) / focalLength) * cameraDepth * HORIZONTAL_GAIN,
    ((frameHeight / 2 - bounds.centerY) / focalLength) * cameraDepth * VERTICAL_GAIN,
    playerViewDepth(cameraDepth)
  );
}

function playerViewDepth(cameraDepth) {
  // The physical webcam faces the player. Moving the paddle toward that
  // webcam means it moves away from the player, so invert camera depth for
  // the player's virtual point of view.
  const cameraDistance = THREE.MathUtils.clamp(cameraDepth * DEPTH_GAIN, 0.25, VIRTUAL_DEPTH_ANCHOR - 0.4);
  return -(VIRTUAL_DEPTH_ANCHOR - cameraDistance);
}

function markerCentre(marker) {
  return marker.corners.reduce((centre, corner) => centre.add(new THREE.Vector2(corner.x, corner.y)), new THREE.Vector2()).multiplyScalar(1 / marker.corners.length);
}

function estimateMarkerSpacingDepth(markers, frameWidth) {
  // The marker centres have a known fixed separation on the paddle. Their
  // projected separation shrinks as the paddle moves away, giving a board-
  // level depth estimate that is steadier than a single marker's apparent size.
  if (markers.length < 2) return null;
  const estimates = [];
  for (let first = 0; first < markers.length - 1; first += 1) {
    for (let second = first + 1; second < markers.length; second += 1) {
      const [ax, ay] = MARKER_CENTRES_MM[markers[first].id];
      const [bx, by] = MARKER_CENTRES_MM[markers[second].id];
      const physicalSeparation = Math.hypot(ax - bx, ay - by) / 1000;
      const imageSeparation = markerCentre(markers[first]).distanceTo(markerCentre(markers[second]));
      if (physicalSeparation > 0 && imageSeparation > 2) {
        estimates.push((frameWidth * physicalSeparation) / imageSeparation);
      }
    }
  }
  if (!estimates.length) return null;
  estimates.sort((a, b) => a - b);
  return THREE.MathUtils.clamp(estimates[Math.floor(estimates.length / 2)], 0.2, 3);
}

function applyColourPaddlePosition(bounds, frameWidth, frameHeight) {
  applySmoothedPose(colourPaddlePosition(bounds, frameWidth, frameHeight), paddle.quaternion);
}

function estimateMarkerPose(marker, frameWidth, frameHeight) {
  // POSIT uses coordinates centred on the optical axis, with +Y pointing up.
  const corners = marker.corners.map((corner) => undistortCorner(corner, frameWidth, frameHeight));
  const pose = new POS.Posit(markerSizeMm(), focalLengthPixels(frameWidth)).pose(corners);
  if (!Number.isFinite(pose.bestError) || pose.bestError < 0) return null;
  const r = pose.bestRotation;
  const t = pose.bestTranslation;
  // The displayed webcam and position coordinates mirror X. Apply the same
  // reflection to the rotation basis (M * R * M, M = diag(-1, 1, 1)) so the
  // paddle handle does not point the opposite way after the position fix.
  const matrix = new THREE.Matrix4().set(
    r[0][0], -r[0][1], -r[0][2], 0,
    -r[1][0], r[1][1], r[1][2], 0,
    -r[2][0], r[2][1], r[2][2], 0,
    0, 0, 0, 1
  );
  const boardQuaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const targetPosition = new THREE.Vector3(
    -t[0] / 1000,
    t[1] / 1000,
    playerViewDepth(t[2] / 1000)
  );

  // POSIT returns the observed marker centre. Shift it to the known board /
  // paddle centre so every ID drives the same virtual paddle location.
  const [x, y, z] = MARKER_CENTRES_MM[marker.id];
  const centreOffset = new THREE.Vector3(-x / 1000, -y / 1000, -z / 1000);
  targetPosition.add(centreOffset.applyQuaternion(boardQuaternion));
  targetPosition.y *= VERTICAL_GAIN;

  const targetQuaternion = boardQuaternion.clone();

  // IDs 5–8 are attached to the opposite physical face of the same paddle.
  const isFrontBoard = FRONT_IDS.has(marker.id);
  if (!isFrontBoard) targetQuaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  return {
    marker,
    isFrontBoard,
    position: targetPosition,
    quaternion: targetQuaternion,
    reprojectionError: pose.bestError,
  };
}

function estimateBoardPose(markers, frameWidth, frameHeight) {
  const frontMarkers = markers.filter((marker) => FRONT_IDS.has(marker.id));
  const backMarkers = markers.filter((marker) => BACK_IDS.has(marker.id));
  const boardMarkers = frontMarkers.length >= backMarkers.length ? frontMarkers : backMarkers;
  if (!boardMarkers.length) return null;

  const measuredMarkerCount = boardMarkers.length;
  const markerPoses = boardMarkers
    .map((marker) => estimateMarkerPose(marker, frameWidth, frameHeight))
    .filter((item) => item && item.reprojectionError <= Math.max(2.5, Math.sqrt(markerImageArea(item.marker)) * 0.08));
  if (!markerPoses.length) return null;
  const inliers = rejectPoseOutliers(markerPoses);
  let position = inliers.reduce((sum, item) => sum.add(item.position), new THREE.Vector3()).multiplyScalar(1 / inliers.length);
  const rotationInliers = rejectRotationOutliers(inliers);
  const reference = rotationInliers[0].quaternion;
  const quaternionSum = rotationInliers.reduce((sum, item) => {
    const quaternion = item.quaternion.clone();
    if (reference.dot(quaternion) < 0) {
      quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
    }
    // Larger decoded markers contain more pixels and give POSIT a much less
    // noisy corner measurement, so let them contribute more to orientation.
    const decodeConfidence = 1 / (1 + (item.marker.hammingDistance || 0));
    const weight = Math.sqrt(markerImageArea(item.marker)) * decodeConfidence;
    sum.x += quaternion.x * weight;
    sum.y += quaternion.y * weight;
    sum.z += quaternion.z * weight;
    sum.w += quaternion.w * weight;
    return sum;
  }, new THREE.Vector4());
  let quaternion = new THREE.Quaternion(quaternionSum.x, quaternionSum.y, quaternionSum.z, quaternionSum.w).normalize();
  const wholeBoardPose = estimateAllCornerBoardPose(inliers.map((item) => item.marker), frameWidth, frameHeight)
    || estimateWholeBoardPose(inliers.map((item) => item.marker), frameWidth, frameHeight);
  if (wholeBoardPose) {
    position = wholeBoardPose.position;
    quaternion = wholeBoardPose.quaternion;
  }
  return {
    isFrontBoard: inliers[0].isFrontBoard,
    markers: inliers.map((item) => item.marker),
    detectedMarkerCount: measuredMarkerCount,
    rejectedMarkerCount: measuredMarkerCount - inliers.length,
    flowMarkerCount: inliers.filter((item) => item.marker.flowAge > 0).length,
    position,
    quaternion,
    reprojectionError: wholeBoardPose?.reprojectionError
      ?? inliers.reduce((sum, item) => sum + item.reprojectionError, 0) / inliers.length,
    usesWholeBoardPose: Boolean(wholeBoardPose),
    markerSpacingDepth: estimateMarkerSpacingDepth(inliers.map((item) => item.marker), frameWidth),
  };
}

function estimateWholeBoardPose(markers, frameWidth, frameHeight) {
  const ids = FRONT_IDS.has(markers[0]?.id) ? [1, 2, 3, 4] : [5, 6, 7, 8];
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  if (!ids.every((id) => byId.has(id))) return null;

  // Use the four outside corners of the rigid 2x2 target as one large square.
  // This has a much longer baseline than any individual marker and therefore
  // produces a substantially steadier plane normal and paddle angle.
  const rawCorners = [
    byId.get(ids[0]).corners[0],
    byId.get(ids[1]).corners[1],
    byId.get(ids[2]).corners[2],
    byId.get(ids[3]).corners[3],
  ];
  const imageCorners = rawCorners.map((corner) => undistortCorner(corner, frameWidth, frameHeight));
  const boardSizeMm = 40 + markerSizeMm();
  const pose = new POS.Posit(boardSizeMm, focalLengthPixels(frameWidth)).pose(imageCorners);
  const averageImageSide = rawCorners.reduce((sum, corner, index) => {
    const next = rawCorners[(index + 1) % rawCorners.length];
    return sum + Math.hypot(next.x - corner.x, next.y - corner.y);
  }, 0) / rawCorners.length;
  const maximumError = Math.max(2.5, averageImageSide * 0.04);
  if (!Number.isFinite(pose.bestError) || pose.bestError < 0 || pose.bestError > maximumError) return null;

  const r = pose.bestRotation;
  const matrix = new THREE.Matrix4().set(
    r[0][0], -r[0][1], -r[0][2], 0,
    -r[1][0], r[1][1], r[1][2], 0,
    -r[2][0], r[2][1], r[2][2], 0,
    0, 0, 0, 1
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const isFrontBoard = FRONT_IDS.has(ids[0]);
  if (!isFrontBoard) quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
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
  const halfMarker = markerSizeMm() / 2;
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
      const image = undistortCorner(corner, frameWidth, frameHeight);
      correspondences.push({
        x: (centre[0] + localCorners[index][0]) / boardScaleMm,
        y: (centre[1] + localCorners[index][1]) / boardScaleMm,
        u: image.x,
        v: image.y,
        weight: decodeWeight * (corner.quality || 0.5),
      });
    });
  }
  if (correspondences.length < 8) return null;

  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rightHandSide = Array(8).fill(0);
  for (const point of correspondences) {
    const rows = [
      { coefficients: [point.x, point.y, 1, 0, 0, 0, -point.u * point.x, -point.u * point.y], value: point.u },
      { coefficients: [0, 0, 0, point.x, point.y, 1, -point.v * point.x, -point.v * point.y], value: point.v },
    ];
    for (const row of rows) {
      for (let column = 0; column < 8; column += 1) {
        rightHandSide[column] += row.coefficients[column] * row.value * point.weight;
        for (let other = 0; other < 8; other += 1) {
          normal[column][other] += row.coefficients[column] * row.coefficients[other] * point.weight;
        }
      }
    }
  }
  const homography = solveLinearSystem(normal, rightHandSide);
  if (!homography) return null;

  const reprojectionError = Math.sqrt(correspondences.reduce((sum, point) => {
    const denominator = homography[6] * point.x + homography[7] * point.y + 1;
    const projectedU = (homography[0] * point.x + homography[1] * point.y + homography[2]) / denominator;
    const projectedV = (homography[3] * point.x + homography[4] * point.y + homography[5]) / denominator;
    return sum + (projectedU - point.u) ** 2 + (projectedV - point.v) ** 2;
  }, 0) / correspondences.length);
  if (!Number.isFinite(reprojectionError) || reprojectionError > 5) return null;

  const focalLength = focalLengthPixels(frameWidth);
  const firstColumn = new THREE.Vector3(homography[0] / focalLength, homography[3] / focalLength, homography[6]);
  const secondColumn = new THREE.Vector3(homography[1] / focalLength, homography[4] / focalLength, homography[7]);
  const translation = new THREE.Vector3(homography[2] / focalLength, homography[5] / focalLength, 1);
  let scale = 2 / (firstColumn.length() + secondColumn.length());
  if (translation.z * scale < 0) scale *= -1;
  const r1 = firstColumn.multiplyScalar(scale).normalize();
  const scaledSecondColumn = secondColumn.multiplyScalar(scale);
  const r2 = scaledSecondColumn.addScaledVector(r1, -r1.dot(scaledSecondColumn)).normalize();
  const r3 = new THREE.Vector3().crossVectors(r1, r2).normalize();
  translation.multiplyScalar(scale * boardScaleMm);
  const matrix = new THREE.Matrix4().set(
    r1.x, -r2.x, -r3.x, 0,
    -r1.y, r2.y, r3.y, 0,
    -r1.z, r2.z, r3.z, 0,
    0, 0, 0, 1
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const isFrontBoard = FRONT_IDS.has(markers[0].id);
  if (!isFrontBoard) quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  return {
    position: new THREE.Vector3(-translation.x / 1000, translation.y / 1000, -translation.z / 1000),
    quaternion,
    reprojectionError,
  };
}

function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) bestRow = row;
    }
    if (Math.abs(augmented[bestRow][pivot]) < 1e-9) return null;
    [augmented[pivot], augmented[bestRow]] = [augmented[bestRow], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) augmented[row][column] -= factor * augmented[pivot][column];
    }
  }
  return augmented.map((row) => row[size]);
}

function markerImageArea(marker) {
  let twiceArea = 0;
  for (let index = 0; index < marker.corners.length; index += 1) {
    const current = marker.corners[index];
    const next = marker.corners[(index + 1) % marker.corners.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.max(1, Math.abs(twiceArea) / 2);
}

function rejectRotationOutliers(markerPoses) {
  if (markerPoses.length < 3) return markerPoses;

  // Pick the measured orientation with the smallest total disagreement as a
  // robust reference, then discard markers whose pose solution flips away.
  const reference = markerPoses.reduce((best, candidate) => {
    const score = markerPoses.reduce((sum, item) => sum + candidate.quaternion.angleTo(item.quaternion), 0);
    return !best || score < best.score ? { pose: candidate, score } : best;
  }, null).pose;
  const angles = markerPoses.map((item) => reference.quaternion.angleTo(item.quaternion));
  const sortedAngles = [...angles].sort((a, b) => a - b);
  const medianAngle = sortedAngles[Math.floor(sortedAngles.length / 2)];
  const threshold = THREE.MathUtils.clamp(
    medianAngle * 2.5,
    THREE.MathUtils.degToRad(5),
    THREE.MathUtils.degToRad(20)
  );
  const inliers = markerPoses.filter((item, index) => angles[index] <= threshold);
  return inliers.length ? inliers : [reference];
}

function rejectPoseOutliers(markerPoses) {
  // With three or four IDs, a blurred or partially occluded marker can create
  // a wildly different single-marker pose. Keep only poses near the median
  // board centre; with one or two markers, retain the available measurements.
  if (markerPoses.length < 3) return markerPoses;
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const centre = new THREE.Vector3(
    median(markerPoses.map((item) => item.position.x)),
    median(markerPoses.map((item) => item.position.y)),
    median(markerPoses.map((item) => item.position.z))
  );
  const distances = markerPoses.map((item) => item.position.distanceTo(centre));
  const threshold = Math.max(0.07, median(distances) * 2.5);
  const inliers = markerPoses.filter((item) => item.position.distanceTo(centre) <= threshold);
  return inliers.length ? inliers : markerPoses;
}

function markersFitPaddleAssist(markers, bounds) {
  const marginX = bounds.width * 0.12;
  const marginY = bounds.height * 0.12;
  return markers.every((marker) => {
    const centerX = marker.corners.reduce((sum, corner) => sum + corner.x, 0) / marker.corners.length;
    const centerY = marker.corners.reduce((sum, corner) => sum + corner.y, 0) / marker.corners.length;
    return centerX >= bounds.left - marginX && centerX <= bounds.left + bounds.width + marginX && centerY >= bounds.top - marginY && centerY <= bounds.top + bounds.height + marginY;
  });
}

function applyBoardPose(boardPose, paddleAssist, frameWidth, frameHeight) {
  const targetPosition = boardPose.position.clone();
  const targetQuaternion = boardPose.quaternion.clone();

  // Apply the same movement amplification to marker-only tracking as the
  // colour-assisted path, so every axis remains responsive when the paddle
  // silhouette is unavailable.
  targetPosition.x *= HORIZONTAL_GAIN;
  targetPosition.y *= VERTICAL_GAIN;
  targetPosition.z = playerViewDepth(Math.max(0.2, -targetPosition.z));

  // Prefer the physical spacing between two or more decoded marker centres
  // for depth. This measures the whole board rather than one marker or the
  // colour silhouette alone.
  if (boardPose.markerSpacingDepth !== null) {
    targetPosition.z = playerViewDepth(boardPose.markerSpacingDepth);
  }

  // The colour silhouette improves screen position. It has only a light depth
  // influence when board spacing is available, and remains the fallback for a
  // single decoded marker.
  if (paddleAssist) {
    const silhouettePosition = colourPaddlePosition(paddleAssist, frameWidth, frameHeight);
    targetPosition.x = THREE.MathUtils.lerp(targetPosition.x, silhouettePosition.x, 0.45);
    targetPosition.y = THREE.MathUtils.lerp(targetPosition.y, silhouettePosition.y, 0.45);
    targetPosition.z = THREE.MathUtils.lerp(
      targetPosition.z,
      silhouettePosition.z,
      boardPose.markerSpacingDepth === null ? 0.5 : 0.05
    );
  }

  latestPoseForCalibration = {
    position: targetPosition.clone(),
    quaternion: targetQuaternion.clone(),
    isFrontBoard: boardPose.isFrontBoard,
  };
  if (calibration) {
    targetPosition.sub(calibration.position).add(new THREE.Vector3(0, 0, -1.1));
    const relativeRotation = calibration.quaternion.clone().invert().multiply(targetQuaternion);
    targetQuaternion.copy(calibration.neutralRenderQuaternion).multiply(relativeRotation);
  }
  applySmoothedPose(targetPosition, targetQuaternion);
}

function applySmoothedPose(position, quaternion) {
  const now = performance.now();
  if (now - lastSmoothedPoseAt > 300) {
    positionHistory.length = 0;
    positionSmoother.reset();
    predictivePositionFilter.reset();
    smoothedQuaternion = null;
  }
  lastSmoothedPoseAt = now;
  positionHistory.push(position.clone());
  if (positionHistory.length > 3) positionHistory.shift();
  const median = (axis) => {
    const values = positionHistory.map((sample) => sample[axis]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const medianPosition = new THREE.Vector3(median('x'), median('y'), median('z'));
  // A rolling median is excellent at removing one-frame pose failures but
  // delays every real movement. Use the live sample normally and substitute
  // the median only when the newest measurement is an implausible jump.
  const spikeThreshold = stableTrackingMode === 'flow' || stableTrackingMode === 'colour' ? 0.12 : 0.2;
  const stablePosition = position.distanceTo(medianPosition) > spikeThreshold
    ? medianPosition
    : position;
  const predictedPosition = predictivePositionFilter.filter(stablePosition, now);
  paddle.position.copy(positionSmoother.filter(predictedPosition, now));
  if (!smoothedQuaternion) {
    smoothedQuaternion = quaternion.clone();
  } else {
    const dt = Math.max(1 / 240, (now - lastQuaternionAt) / 1000);
    const angle = smoothedQuaternion.angleTo(quaternion);
    const deadZone = THREE.MathUtils.degToRad(0.4);
    if (angle > deadZone) {
      // Remove sub-degree corner noise while preserving the remainder of a
      // real rotation, then respond progressively faster to larger motions.
      const stableTarget = smoothedQuaternion.clone().slerp(quaternion, (angle - deadZone) / angle);
      const alpha = THREE.MathUtils.clamp(0.06 + angle * 0.32 + dt * 1.2, 0.06, 0.35);
      smoothedQuaternion.slerp(stableTarget, alpha);
    }
  }
  lastQuaternionAt = now;
  paddle.quaternion.copy(smoothedQuaternion);
}

function makeVirtualPaddleView() {
  const container = document.querySelector('#virtual-view');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080d19);
  // Match the camera-space convention used by the tracker: the virtual lens
  // sits at the webcam origin and looks down -Z. POSIT uses focalLength =
  // video width, which corresponds to this vertical field of view.
  const camera = new THREE.PerspectiveCamera(27, 1, 0.01, 20);
  camera.position.set(0, 0, 0.2);
  camera.lookAt(0, 0, -1);
  scene.add(new THREE.HemisphereLight(0xbfd2ff, 0x1b2634, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(1, 2, 2);
  scene.add(light);

  const paddle = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.085, 0.014, 40),
    [
      new THREE.MeshStandardMaterial({ color: 0x6b4225, roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ color: 0xd32929, roughness: 0.65 }),
    ]
  );
  head.rotation.x = Math.PI / 2;
  paddle.add(head);
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.018, 0.105, 12),
    new THREE.MeshStandardMaterial({ color: 0xbf8955, roughness: 0.85 })
  );
  handle.position.y = -0.125;
  paddle.add(handle);
  const axes = new THREE.AxesHelper(0.13);
  axes.position.z = 0.014;
  paddle.add(axes);
  paddle.position.set(0, 0, -1.1);
  scene.add(paddle);

  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  return { paddle };
}
