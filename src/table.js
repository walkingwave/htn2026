import * as THREE from 'three';
import { TABLE, NET, COLORS } from './constants.js';
import { tableSurfaceTexture, netTexture, floorTexture } from './textures.js';

// Builds the playing environment. Origin is floor level, centred under the
// table, with the net spanning the X axis at z = 0.
//
// Everything that only makes sense in a fully virtual space (floor, barrier
// surrounds, backdrop) lives under a group named `vr-environment` so AR mode
// can hide it and let passthrough show the player's real room instead.

export function createTable() {
  const root = new THREE.Group();
  root.add(buildTable());
  root.add(buildNet());
  root.add(buildVenue());
  return root;
}

function buildTable() {
  const group = new THREE.Group();
  const topY = TABLE.HEIGHT - TABLE.THICKNESS / 2;

  // Playing surface. Lines are painted into the texture rather than added as
  // separate coplanar meshes, so there is nothing to z-fight.
  // Matte, with the environment probe dialled back. A real table is a low
  // sheen surface; letting it reflect the room turns it into pale plastic.
  const surfaceMat = new THREE.MeshStandardMaterial({
    map: tableSurfaceTexture(),
    roughness: 0.78,
    metalness: 0.0,
    envMapIntensity: 0.25,
  });
  const edgeMat = new THREE.MeshStandardMaterial({
    color: COLORS.LINE,
    roughness: 0.5,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: COLORS.FRAME,
    roughness: 0.65,
    metalness: 0.3,
  });

  // BoxGeometry material order is +X, -X, +Y, -Y, +Z, -Z — only the top face
  // gets the painted surface; the four rims get the white edge banding.
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.WIDTH, TABLE.THICKNESS, TABLE.LENGTH),
    [edgeMat, edgeMat, surfaceMat, frameMat, edgeMat, edgeMat]
  );
  top.position.y = topY;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  // Apron: the rail hanging under the top edge, what gives a real table its
  // visual weight instead of looking like a floating sheet.
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(
      TABLE.WIDTH - 0.012,
      TABLE.APRON,
      TABLE.LENGTH - 0.012
    ),
    frameMat
  );
  apron.position.y = topY - TABLE.THICKNESS / 2 - TABLE.APRON / 2;
  apron.castShadow = true;
  group.add(apron);

  // Undercarriage: two leg frames, each a pair of uprights joined by a rail.
  const legTop = apron.position.y - TABLE.APRON / 2;
  const legGeo = new THREE.CylinderGeometry(0.026, 0.03, legTop, 12);
  const wheelGeo = new THREE.CylinderGeometry(0.038, 0.038, 0.022, 14);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x111114,
    roughness: 0.85,
  });

  for (const sz of [-1, 1]) {
    const frame = new THREE.Group();
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, frameMat);
      leg.position.set(sx * (TABLE.WIDTH / 2 - 0.11), legTop / 2, 0);
      leg.castShadow = true;
      frame.add(leg);

      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(sx * (TABLE.WIDTH / 2 - 0.11), 0.038, 0);
      frame.add(wheel);
    }

    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.WIDTH - 0.22, 0.035, 0.035),
      frameMat
    );
    rail.position.y = legTop * 0.45;
    frame.add(rail);

    frame.position.z = sz * (TABLE.LENGTH / 2 - 0.3);
    group.add(frame);
  }

  return group;
}

function buildNet() {
  const group = new THREE.Group();
  const span = TABLE.WIDTH + NET.OVERHANG * 2;

  // Netting with a slight droop toward the middle, the detail that reads
  // most clearly as "a real net" rather than a rectangle.
  const geo = new THREE.PlaneGeometry(span, NET.HEIGHT, 24, 6);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Sag is strongest mid-span and only affects the lower edge; the tape
    // along the top stays taut.
    const across = Math.cos((x / (span / 2)) * (Math.PI / 2));
    const down = 0.5 - y / NET.HEIGHT; // 0 at the tape, 1 at the bottom
    pos.setY(i, y - across * down * NET.SAG);
  }
  geo.computeVertexNormals();

  const net = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      map: netTexture(Math.round(span * 55), Math.round(NET.HEIGHT * 55)),
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.9,
      color: 0x20242c,
    })
  );
  net.position.y = TABLE.HEIGHT + NET.HEIGHT / 2;
  group.add(net);

  // White tape along the top edge
  const tape = new THREE.Mesh(
    new THREE.BoxGeometry(span, 0.014, 0.006),
    new THREE.MeshStandardMaterial({ color: COLORS.LINE, roughness: 0.55 })
  );
  tape.position.y = TABLE.HEIGHT + NET.HEIGHT;
  tape.castShadow = true;
  group.add(tape);

  // Posts and clamps at both ends
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x1a1d23,
    roughness: 0.4,
    metalness: 0.5,
  });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(NET.POST_RADIUS, NET.POST_RADIUS, NET.HEIGHT + 0.02, 12),
      postMat
    );
    post.position.set(sx * span / 2, TABLE.HEIGHT + NET.HEIGHT / 2, 0);
    post.castShadow = true;
    group.add(post);

    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.07), postMat);
    clamp.position.set(sx * (span / 2), TABLE.HEIGHT - 0.03, 0);
    group.add(clamp);
  }

  return group;
}

// Fully virtual surroundings: one unbroken hall floor and a distant backdrop.
//
// The court is marked with a flat inlay rather than barrier boards. Anything
// with height ringing the table this closely reads as a pit you're standing
// in, which is exactly the wrong feeling — you want an open hall.
function buildVenue() {
  const group = new THREE.Group();
  group.name = 'vr-environment';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(28, 28),
    new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.8 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // Painted court area, flush with the boards. Gives depth cues for judging
  // ball distance without enclosing the player. The border is just a slightly
  // larger quad showing through underneath.
  const border = new THREE.Mesh(
    new THREE.PlaneGeometry(4.72, 8.12),
    new THREE.MeshStandardMaterial({
      color: COLORS.LINE,
      roughness: 0.9,
      transparent: true,
      opacity: 0.22,
    })
  );
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.0015;
  group.add(border);

  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 8.0),
    new THREE.MeshStandardMaterial({
      color: COLORS.SURROUND,
      roughness: 0.85,
      transparent: true,
      opacity: 0.5,
    })
  );
  court.rotation.x = -Math.PI / 2;
  court.position.y = 0.002;
  court.receiveShadow = true;
  group.add(court);

  // Distant backdrop so the horizon isn't an empty void. Wide enough that it
  // reads as the far wall of a hall, not a wall you could touch.
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(13, 13, 7, 32, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x11151d,
      side: THREE.BackSide,
      roughness: 1,
    })
  );
  shell.position.y = 3.5;
  group.add(shell);

  return group;
}
