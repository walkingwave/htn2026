// The tracker's state names, on their own.
//
// They used to live inside markerPaddleTracker.js, which means every caller
// that only wanted to compare `camTracker.state` — the render loop, above all
// — imported the tracker along with it: a 585 kB chunk and, transitively, the
// worker and its 11 MB WebAssembly build. Splitting the enum out lets a hot
// module ask "is it tracking?" without paying for the thing that answers.
//
// markerPaddleTracker.js re-exports this, so both import paths stay valid.
export const TRACKER_STATE = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CALIBRATING: 'calibrating',
  TRACKING: 'tracking',
  LOST: 'lost',
  ERROR: 'error',
};
