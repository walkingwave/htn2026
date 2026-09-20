// These byte pairs are IDs 1–4 in the existing custom MATLAB 4x4
// dictionary used by markerWorker.js. Keeping the exact dictionary entries is
// what makes the phone screen compatible with the existing CV pipeline.
const MARKER_BYTES = {
  1: [181, 50],
  2: [15, 154],
  3: [51, 45],
  4: [153, 70],
};

function markerBits(id) {
  return MARKER_BYTES[id].flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1)
  );
}

export function markerSvg(id) {
  const bits = markerBits(id);
  const cells = bits.map((bit, index) => {
    if (!bit) return '';
    const x = (index % 4) + 1;
    const y = Math.floor(index / 4) + 1;
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="white"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 6" role="img" aria-label="CV marker ${id}"><rect width="6" height="6" fill="white"/><rect width="6" height="6" fill="black"/>${cells}</svg>`;
}

export function markerBoardMarkup() {
  return [1, 2, 3, 4]
    .map((id) => `<div class="phone-marker">${markerSvg(id)}</div>`)
    .join('');
}
