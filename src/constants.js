// All units in meters (WebXR world scale), matching ITTF regulation sizes.

export const TABLE = {
  LENGTH: 2.74,
  WIDTH: 1.525,
  HEIGHT: 0.76, // floor to playing surface
  THICKNESS: 0.03,
};

export const NET = {
  HEIGHT: 0.1525,
  OVERHANG: 0.1525, // net extends past each side of the table
};

export const BALL = {
  RADIUS: 0.02,
  MASS: 0.0027, // kg
  RESTITUTION_TABLE: 0.87,
  RESTITUTION_PADDLE: 0.75,
};

export const PADDLE = {
  HEAD_RADIUS: 0.085,
  HEAD_THICKNESS: 0.015,
  HANDLE_LENGTH: 0.1,
  HANDLE_RADIUS: 0.016,
};

export const PHYSICS = {
  GRAVITY: -9.81,
  // Fixed timestep keeps ball physics stable regardless of headset framerate
  // (Quest 3S runs 72/90/120 Hz).
  FIXED_DT: 1 / 240,
  AIR_DRAG: 0.1, // simple linear drag coefficient
};

// Player stands at +Z end of the table; ball machine serves from -Z end.
export const PLAY_AREA = {
  PLAYER_Z: TABLE.LENGTH / 2 + 0.4,
  SERVER_Z: -(TABLE.LENGTH / 2 + 0.2),
};
