import * as THREE from 'three';
import { BALL } from './constants.js';

export class Ball {
  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.RADIUS, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xfff4d6, roughness: 0.4 })
    );
    this.mesh.castShadow = true;
    this.velocity = new THREE.Vector3();
    this.active = false; // inactive balls are hidden and skip physics
    this.mesh.visible = false;
  }

  serve(position, velocity) {
    this.mesh.position.copy(position);
    this.velocity.copy(velocity);
    this.active = true;
    this.mesh.visible = true;
  }

  deactivate() {
    this.active = false;
    this.mesh.visible = false;
  }
}
