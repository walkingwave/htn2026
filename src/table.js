import * as THREE from 'three';
import { TABLE, NET } from './constants.js';

// Builds the table group: playing surface, white lines, net, legs, floor.
// Origin of the group is at floor level, centered under the table.
export function createTable() {
  const group = new THREE.Group();

  // Playing surface
  const surface = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.WIDTH, TABLE.THICKNESS, TABLE.LENGTH),
    new THREE.MeshStandardMaterial({ color: 0x1a4f8a, roughness: 0.6 })
  );
  surface.position.y = TABLE.HEIGHT - TABLE.THICKNESS / 2;
  surface.receiveShadow = true;
  group.add(surface);

  // White boundary + center lines
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const lineY = TABLE.HEIGHT + 0.001;
  const lineW = 0.02;

  const addLine = (w, l, x, z) => {
    const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.002, l), lineMat);
    line.position.set(x, lineY, z);
    group.add(line);
  };
  // Side lines
  addLine(lineW, TABLE.LENGTH, -TABLE.WIDTH / 2 + lineW / 2, 0);
  addLine(lineW, TABLE.LENGTH, TABLE.WIDTH / 2 - lineW / 2, 0);
  // End lines
  addLine(TABLE.WIDTH, lineW, 0, -TABLE.LENGTH / 2 + lineW / 2);
  addLine(TABLE.WIDTH, lineW, 0, TABLE.LENGTH / 2 - lineW / 2);
  // Center line (for doubles; also a good aiming reference)
  addLine(lineW / 2, TABLE.LENGTH, 0, 0);

  // Net
  const net = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.WIDTH + NET.OVERHANG * 2, NET.HEIGHT, 0.002),
    new THREE.MeshStandardMaterial({
      color: 0x222222,
      transparent: true,
      opacity: 0.65,
    })
  );
  net.position.set(0, TABLE.HEIGHT + NET.HEIGHT / 2, 0);
  group.add(net);

  const netTape = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.WIDTH + NET.OVERHANG * 2, 0.012, 0.004),
    lineMat
  );
  netTape.position.set(0, TABLE.HEIGHT + NET.HEIGHT, 0);
  group.add(netTape);

  // Legs
  const legMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const legGeo = new THREE.BoxGeometry(0.05, TABLE.HEIGHT - TABLE.THICKNESS, 0.05);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(
        sx * (TABLE.WIDTH / 2 - 0.1),
        (TABLE.HEIGHT - TABLE.THICKNESS) / 2,
        sz * (TABLE.LENGTH / 2 - 0.2)
      );
      group.add(leg);
    }
  }

  // Floor — VR-only environment; hidden in AR where the real floor shows
  // through passthrough (name lets main.js toggle it per mode).
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.9 })
  );
  floor.name = 'vr-environment';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  return group;
}
