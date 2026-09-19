import * as THREE from 'three';

export const LANDSCAPE_BACKDROPS = {
  classic: 0x101018,
  sunset: 0x3b1f2b,
  neon: 0x071d2c,
  disco: 0x0b0716,
};

const groundGeo = new THREE.CircleGeometry(1, 32);
const gridGeo = new THREE.PlaneGeometry(1, 1, 60, 80);

function makeGridMesh(color, opacity = 0.12) {
  return new THREE.Mesh(
    gridGeo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide })
  );
}

function buildBackdrop(initialColor) {
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 12),
    new THREE.MeshBasicMaterial({ color: initialColor, depthWrite: false })
  );
  backdrop.name = 'backdrop';
  backdrop.renderOrder = 20;
  return backdrop;
}

function buildGround(initialColor) {
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial({ color: initialColor, depthWrite: false }));
  ground.name = 'ground';
  ground.renderOrder = 15;
  return ground;
}

function buildGear() {
  const gear = new THREE.Group();
  gear.renderOrder = 5;

  const ringMat = new THREE.MeshBasicMaterial({ color: 0xfc6bff, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const centerMat = new THREE.MeshBasicMaterial({ color: 0x32e0ff, transparent: true, opacity: 0.7 });

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.05, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.z = -10;
  gear.add(ring);

  const center = new THREE.Mesh(new THREE.CircleGeometry(0.85, 8), centerMat);
  center.rotation.x = -Math.PI / 2;
  center.position.z = -10;
  gear.add(center);

  for (const side of [-1, 1]) {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), new THREE.MeshBasicMaterial({ color: 0xffb74d }));
    spoke.position.set(side * 0.62, 0, -9.8);
    spoke.rotation.z = side * (Math.PI / 3);
    gear.add(spoke);
  }

  gear.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.05), new THREE.MeshBasicMaterial({ color: 0xffc94d })));
  return gear;
}

export function buildEnvironment(initialColor) {
  const group = new THREE.Group();
  group.renderOrder = 10;

  const backdrop = buildBackdrop(initialColor);
  backdrop.position.set(0, 3, -18);
  group.add(backdrop);

  const ground = buildGround(new THREE.Color(initialColor).offsetHSL(0, 0, -0.06));
  ground.position.set(0, -0.001, 0);
  group.add(ground);

  const grid1 = makeGridMesh(0xffffff, 0.04);
  group.add(grid1);

  const grid2 = makeGridMesh(0xee4f6b, 0);
  grid2.renderOrder = 14;
  group.add(grid2);

  const pillars = new THREE.Group();
  pillars.name = 'pillars';
  pillars.renderOrder = 12;
  group.add(pillars);

  const sun = new THREE.PointLight(0xfff0d6, 0, 12, 2);
  sun.name = 'sun';
  group.add(sun);

  return { group, backdrop, ground, grid1, grid2, pillars, sun, gear: null };
}

export function setEnvironmentPalette(name, environment) {
  if (!environment) return;

  if (name === 'disco') {
    environment.backdrop.material.color.setHex(LANDSCAPE_BACKDROPS.disco);
    environment.ground.material.color.setHex(0x0c0c12);
    environment.grid1.material.color.setHex(0xffffff);
    environment.grid1.material.opacity = 0.18;
    environment.grid2.material.color.setHex(0xff4b6e);
    environment.grid2.material.opacity = 0.5;
    environment.sun.intensity = 0.22;
    environment.sun.color.setHex(0x7642f7);
    if (!environment.gear) environment.gear = buildGear();
    if (!environment.group.children.includes(environment.gear)) environment.group.add(environment.gear);
    return;
  }

  if (name === 'neon') {
    environment.backdrop.material.color.setHex(LANDSCAPE_BACKDROPS.neon);
    environment.ground.material.color.setHex(0x0a121f);
    environment.grid1.material.color.setHex(0xffffff);
    environment.grid1.material.opacity = 0.14;
    environment.grid2.material.color.setHex(0xf23661);
    environment.grid2.material.opacity = 0.35;
    environment.sun.intensity = 0.9;
    environment.sun.color.setHex(0xff4d7e);
    environment.sun.position.set(3, 5, -4);
    if (environment.gear && environment.group.children.includes(environment.gear)) environment.group.remove(environment.gear);
    return;
  }

  if (name === 'sunset') {
    environment.backdrop.material.color.setHex(LANDSCAPE_BACKDROPS.sunset);
    environment.ground.material.color.setHex(0x1a0b14);
    environment.grid1.material.color.setHex(0xffffff);
    environment.grid1.material.opacity = 0.08;
    environment.grid2.material.color.setHex(0xffb97c);
    environment.grid2.material.opacity = 0.35;
    environment.sun.intensity = 0;
    environment.sun.color.setHex(0xffd89a);
    environment.sun.position.set(0, 0, 0);
    if (environment.gear && environment.group.children.includes(environment.gear)) environment.group.remove(environment.gear);
    return;
  }

  environment.backdrop.material.color.setHex(LANDSCAPE_BACKDROPS.classic);
  environment.ground.material.color.setHex(0x0c0c12);
  environment.grid1.material.color.setHex(0xd7e1ef);
  environment.grid1.material.opacity = 0.12;
  environment.grid2.material.color.setHex(0xb1c8fa);
  environment.grid2.material.opacity = 0.15;
  environment.sun.intensity = 0.65;
  environment.sun.color.setHex(0xffe9c7);
  environment.sun.position.set(2, 5, -4);
  if (environment.gear && environment.group.children.includes(environment.gear)) environment.group.remove(environment.gear);
}
