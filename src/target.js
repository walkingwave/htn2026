import * as THREE from 'three';
import { TABLE, COLORS } from './constants.js';

// Target zone for target-practice mode: a pad on the far half that the player
// tries to hit with their return. It lives just above the playing surface and
// pulses so it stays readable from the far end of the table.

const RADIUS = 0.16;

export class TargetZone {
  constructor() {
    this.radius = RADIUS;
    this.center = new THREE.Vector3();
    this._pulse = 0;
    this._flash = 0;

    this.mesh = new THREE.Group();

    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS, 40),
      new THREE.MeshBasicMaterial({
        color: COLORS.ACCENT,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.disc.rotation.x = -Math.PI / 2;
    this.mesh.add(this.disc);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(RADIUS * 0.92, RADIUS, 40),
      new THREE.MeshBasicMaterial({
        color: COLORS.ACCENT,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.mesh.add(this.ring);

    this.bull = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS * 0.3, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.bull.rotation.x = -Math.PI / 2;
    this.mesh.add(this.bull);

    this.randomize();
  }

  // Drops the target somewhere on the far half, clear of the net and the
  // outer edges so a good shot is always physically returnable.
  randomize() {
    const x = (Math.random() * 2 - 1) * (TABLE.WIDTH / 2 - RADIUS - 0.08);
    const z = -(0.3 + Math.random() * (TABLE.LENGTH / 2 - 0.45));
    this.center.set(x, TABLE.HEIGHT, z);
    this.mesh.position.set(x, TABLE.HEIGHT + 0.004, z);
  }

  contains(x, z) {
    return Math.hypot(x - this.center.x, z - this.center.z) <= this.radius;
  }

  // Called when a return lands inside the zone.
  registerHit() {
    this._flash = 1;
    this.randomize();
  }

  update(dt) {
    this._pulse += dt * 2.2;
    const breathe = 0.75 + Math.sin(this._pulse) * 0.25;
    this.ring.material.opacity = breathe;
    this.disc.material.opacity = 0.16 + breathe * 0.1;

    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 2.5);
      const s = 1 + this._flash * 0.6;
      this.mesh.scale.set(s, 1, s);
      this.disc.material.color.setHex(0xffffff);
      this.ring.material.color.setHex(0xffffff);
    } else {
      this.mesh.scale.set(1, 1, 1);
      this.disc.material.color.setHex(COLORS.ACCENT);
      this.ring.material.color.setHex(COLORS.ACCENT);
    }
  }

  set visible(v) {
    this.mesh.visible = v;
  }
}
