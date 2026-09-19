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
  RADIUS: 0.02,
  MASS: 0.0027, // kg

  // Restitution falls as impact speed rises: both the ball and the rubber
  // deform further and lose proportionally more energy in a hard contact.
  // Real measurements bear this out — the ITTF's own COR figure is quoted
  // for a gentle 30 cm drop and does not hold for a drive.
  //
  // It also matters enormously for feel. With a single fixed COR the paddle
  // returns (1 + e) times its own speed no matter how hard you swing, so the
  // ball behaves like a super-ball and any real swing launches it off the
  // end of the table. The falloff gives the ball weight: soft touches stay
  // lively, hard hits stop running away.
  //
  //   e(impact) = min + (base − min) / (1 + (impact / ref)²)
  RESTITUTION_TABLE: 0.90,
  RESTITUTION_TABLE_MIN: 0.55,
  RESTITUTION_TABLE_REF: 26, // m/s — a gentle falloff; the table is rigid

  RESTITUTION_PADDLE: 0.80,
  RESTITUTION_PADDLE_MIN: 0.25,
  RESTITUTION_PADDLE_REF: 9, // m/s — rubber absorbs far more at speed

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
  // Contact disc. Kept between the blade's two semi-axes (75 x 79 mm) so it
  // neither overhangs the rim — which produces hits off thin air — nor sits
  // so far inside that the edge of the visible bat passes through the ball.
  HEAD_RADIUS: 0.077,
  HEAD_THICKNESS: 0.015,
  HANDLE_LENGTH: 0.105,
  HANDLE_RADIUS: 0.016,

  // Ceiling on the swing speed the physics will believe. Hand tracking drops
  // and recovers, and a single dropped frame reads as an enormous velocity
  // spike that would fire the ball across the room. Well above a real
  // stroke, so it only ever rejects glitches.
  MAX_SWING_SPEED: 9, // m/s
  MAX_SWING_SPIN: 40, // rad/s
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
