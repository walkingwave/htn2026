// All units in meters / seconds / radians (WebXR world scale).
// Table, net and ball figures follow ITTF regulation sizes.

export const TABLE = {
  LENGTH: 2.74,
  WIDTH: 1.525,
  HEIGHT: 0.76, // floor to playing surface
  THICKNESS: 0.022, // top panel
  APRON: 0.05, // depth of the rail under the top edge
  LINE_WIDTH: 0.02,
};

export const NET = {
  HEIGHT: 0.1525,
  OVERHANG: 0.1525, // net extends past each side of the table
  POST_RADIUS: 0.009,
  SAG: 0.012, // how far the middle of the net droops below the tape
};

export const BALL = {
  RADIUS: 0.02, // 40mm regulation ball -> 20mm radius
  MASS: 0.0027, // kg
  RESTITUTION_TABLE: 0.87,
  RESTITUTION_PADDLE: 0.78,
  RESTITUTION_FLOOR: 0.5,
  // Coulomb friction at contact. Table rubber grips enough to convert a good
  // chunk of spin into speed (and vice versa) — this is what makes topspin
  // kick forward and backspin check.
  FRICTION_TABLE: 0.25,
  FRICTION_PADDLE: 0.8, // inverted rubber is grippy; this is what creates spin
  SPIN_DECAY: 0.985, // per-second retention of angular velocity in flight
  MAX_SPIN: 700, // rad/s clamp (~6700 rpm), roughly a hard pro loop
};

export const PADDLE = {
  // Regulation blade ~150mm wide x 170mm tall. The collision disc uses the
  // blade half-width (~78mm) so the hit area matches the rendered blade, and
  // the width:ball-diameter ratio lands at the real ~3.75:1.
  HEAD_RADIUS: 0.08,
  HEAD_THICKNESS: 0.015,
  HANDLE_LENGTH: 0.1,
  HANDLE_RADIUS: 0.016,
};

export const PHYSICS = {
  GRAVITY: -9.81,
  // Fixed timestep keeps ball physics stable regardless of headset framerate
  // (Quest 3S runs 72/90/120 Hz).
  FIXED_DT: 1 / 240,

  // Quadratic drag: a = -DRAG * |v| * v. Derived from ½ρ·Cd·A/m for a 40 mm
  // ball (ρ=1.2, Cd≈0.4, m=2.7 g), which lands near 0.11 1/m.
  DRAG: 0.112,

  // Magnus: a = MAGNUS * (ω × v). Tuned by feel rather than derived — the
  // textbook coefficient overstates the curve badly at trainer speeds.
  MAGNUS: 0.0062,

  // Below this impact speed a contact is treated as resting rather than a
  // bounce. Without it the bounce test re-triggers every step once vertical
  // velocity decays, firing thousands of spurious contacts per ball.
  REST_SPEED: 0.35,
};

// Player stands at +Z end of the table; ball machine serves from -Z end.
export const PLAY_AREA = {
  PLAYER_Z: TABLE.LENGTH / 2 + 0.4,
  SERVER_Z: -(TABLE.LENGTH / 2 + 0.35),
};

// Shared palette so the table, venue and HUD read as one design.
// Red, black and bone white. The table is charcoal rather than the usual
// tournament blue so the red reads as the single accent everywhere — lines,
// markers and UI all come from the same three inks.
export const COLORS = {
  TABLE_SURFACE: 0x16181c,
  TABLE_SURFACE_DARK: 0x0e1013,
  LINE: 0xf2efe6,
  FRAME: 0x121316,
  FLOOR: 0x0d0d0f,
  COURT: 0x24090a,
  ACCENT: 0xe2231a,
  BALL: 0xf6f2e7,
};
