import * as THREE from 'three';
import { AR } from 'js-aruco2';
import { POS } from 'js-aruco2/src/posit1.js';

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
const HORIZONTAL_GAIN = 9.5;
const VERTICAL_GAIN = 5.75;
const DEPTH_GAIN = 7;
const VIRTUAL_DEPTH_ANCHOR = 10;
// Marker centres in millimetres relative to the paddle centre. This matches a
// 2×2 board of 3 cm markers with roughly 1 cm gaps, seen face-on.
const MARKER_CENTRES_MM = {
  1: [-20, 20, 0], 2: [20, 20, 0], 3: [20, -20, 0], 4: [-20, -20, 0],
  5: [-20, 20, 0], 6: [20, 20, 0], 7: [20, -20, 0], 8: [-20, -20, 0],
};
const video = document.querySelector('#video');
const overlay = document.querySelector('#video-overlay');
const overlayContext = overlay.getContext('2d');
const startButton = document.querySelector('#start-camera');
const dictionarySelect = document.querySelector('#dictionary');
const markerSizeInput = document.querySelector('#marker-size');
const status = document.querySelector('#status');
const frame = document.createElement('canvas');
const frameContext = frame.getContext('2d', { willReadFrequently: true });

let detector = makeDetector();
let active = false;
let lastPoseAt = 0;
let activePaddleFace = 'red';
const { paddle } = makeVirtualPaddleView();

function makeDetector() {
  return new AR.Detector({ dictionaryName: dictionarySelect.value });
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = kind;
}

dictionarySelect.addEventListener('change', () => {
  detector = makeDetector();
  setStatus(`Using ${dictionarySelect.value}; show a marker`);
});

startButton.addEventListener('click', startCamera);

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    resizeOverlay();
    active = true;
    startButton.textContent = 'Webcam running';
    startButton.disabled = true;
    setStatus('Looking for IDs 1–8…');
    requestAnimationFrame(trackFrame);
  } catch (error) {
    console.error(error);
    setStatus(`Could not start webcam: ${error.message}`, 'error');
  }
}

function markerSizeMm() {
  return Math.max(1, Number(markerSizeInput.value) || 3) * 10;
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
  const paddleAssist = findPaddleByColour(imageData, activePaddleFace);
  const markers = detector.detect(imageData);
  const paddleMarkers = markers.filter((marker) => FRONT_IDS.has(marker.id) || BACK_IDS.has(marker.id));

  overlayContext.clearRect(0, 0, width, height);
  if (paddleAssist) drawPaddleAssist(paddleAssist);
  detector.candidates.forEach(drawCandidateBox);
  paddleMarkers.forEach(drawMarker);

  const marker = paddleMarkers[0];
  if (!marker) {
    if (paddleAssist) {
      applyColourPaddlePosition(paddleAssist, width, height);
      setStatus(`${paddleAssist.colour} paddle fallback — position is live; hold a marker toward the camera for angle tracking`, 'tracking');
      return;
    }
    if (performance.now() - lastPoseAt > 300) {
      const candidateCount = detector.candidates.length;
      setStatus(
        candidateCount > 0
          ? `${candidateCount} square${candidateCount === 1 ? '' : 's'} seen, but no IDs decoded — choose the printed marker dictionary`
          : 'No square candidates — move closer, brighten the marker, and keep it fully in frame'
      );
    }
    return;
  }

  // POSIT uses coordinates centred on the optical axis, with +Y pointing up.
  const corners = marker.corners.map((corner) => ({
    x: corner.x - width / 2,
    y: height / 2 - corner.y,
  }));
  const pose = new POS.Posit(markerSizeMm(), width).pose(corners);
  const isFrontBoard = FRONT_IDS.has(marker.id);
  activePaddleFace = isFrontBoard ? 'red' : 'black';
  // The assist may have been measured using the previous face on this one
  // transition frame. Use it only when it matches the decoded marker face.
  const matchingAssist = paddleAssist?.colour === activePaddleFace ? paddleAssist : null;
  applyPose(pose, marker.id, isFrontBoard, matchingAssist, width, height);
  lastPoseAt = performance.now();
  const side = isFrontBoard ? 'front / red' : 'back / black';
  setStatus(`Tracking ID ${marker.id} (${side}); ${paddleMarkers.length} marker${paddleMarkers.length === 1 ? '' : 's'} visible`, 'tracking');
}

function drawMarker(marker) {
  const color = FRONT_IDS.has(marker.id) ? '#3dff9b' : '#c895ff';
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
  overlayContext.fillText(`ID ${marker.id}`, corners[0].x + 6, corners[0].y - 7);
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
  overlayContext.fillText(`${bounds.colour.toUpperCase()} PADDLE ASSIST`, bounds.left + 6, Math.max(20, bounds.top - 7));
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
    if (!largest || count > largest.count) largest = { count, minX, maxX, minY, maxY };
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
  // The webcam faces the player: moving the paddle toward the webcam moves it
  // away from the player. Invert camera depth for the player's virtual view.
  const cameraDistance = THREE.MathUtils.clamp(
    cameraDepth * DEPTH_GAIN,
    0.25,
    VIRTUAL_DEPTH_ANCHOR - 0.4
  );
  return -(VIRTUAL_DEPTH_ANCHOR - cameraDistance);
}

function applyColourPaddlePosition(bounds, frameWidth, frameHeight) {
  paddle.position.lerp(colourPaddlePosition(bounds, frameWidth, frameHeight), 0.28);
}

function applyPose(pose, markerId, isFrontBoard, paddleAssist, frameWidth, frameHeight) {
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
  const [x, y, z] = MARKER_CENTRES_MM[markerId];
  const centreOffset = new THREE.Vector3(-x / 1000, -y / 1000, -z / 1000);
  targetPosition.add(centreOffset.applyQuaternion(boardQuaternion));
  targetPosition.y *= VERTICAL_GAIN;

  const targetQuaternion = boardQuaternion.clone();

  // IDs 5–8 are attached to the opposite physical face of the same paddle.
  if (!isFrontBoard) targetQuaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));

  // The red silhouette is exceptionally stable for this paddle. Let it lead
  // screen position and provide a gentle depth correction; the marker remains
  // authoritative for blade orientation.
  if (paddleAssist) {
    const silhouettePosition = colourPaddlePosition(paddleAssist, frameWidth, frameHeight);
    targetPosition.x = THREE.MathUtils.lerp(targetPosition.x, silhouettePosition.x, 0.7);
    targetPosition.y = THREE.MathUtils.lerp(targetPosition.y, silhouettePosition.y, 0.7);
    // The silhouette's measured diameter is a strong near/far signal for this
    // round paddle. Give it meaningful influence without discarding the
    // marker's calibrated depth completely.
    targetPosition.z = THREE.MathUtils.lerp(targetPosition.z, silhouettePosition.z, 0.95);
  }
  paddle.position.lerp(targetPosition, 0.34);
  paddle.quaternion.slerp(targetQuaternion, 0.34);
}

function makeVirtualPaddleView() {
  const container = document.querySelector('#virtual-view');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080d19);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 20);
  camera.position.set(0, 0.15, 0.25);
  camera.lookAt(0, 0, -1.1);
  scene.add(new THREE.HemisphereLight(0xbfd2ff, 0x1b2634, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(1, 2, 2);
  scene.add(light);
  scene.add(new THREE.GridHelper(4, 16, 0x38506e, 0x1e2c41));

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
