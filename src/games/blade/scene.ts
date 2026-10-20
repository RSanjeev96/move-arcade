import * as THREE from 'three';

function dustTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export const PALETTE = {
  left: new THREE.Color('#ff2d6a'),
  right: new THREE.Color('#1fb8ff'),
  accentA: new THREE.Color('#8a3bff'),
  accentB: new THREE.Color('#00e5ff'),
  bg: new THREE.Color('#05020f'),
};

/** Neon stage: scrolling floor grid, light frames, sweeping lasers, sky and dust. Reacts to the music. */
export class Stage {
  readonly group = new THREE.Group();
  private floorMat: THREE.ShaderMaterial;
  private rings: THREE.Mesh[] = [];
  private ringMat: THREE.MeshBasicMaterial;
  private lasers: THREE.Mesh[] = [];
  private laserMats: THREE.MeshBasicMaterial[] = [];
  private dust: THREE.Points;
  private skyMat: THREE.ShaderMaterial;
  private stripMats: THREE.MeshBasicMaterial[] = [];
  private flash = 0;
  private hue = 0;

  constructor(private speed: number) {
    // Sky dome with a subtle nebula gradient and stars.
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 }, uTint: { value: PALETTE.accentA.clone() } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vDir; uniform float uTime; uniform float uPulse; uniform vec3 uTint;
        float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        void main(){
          float h = vDir.y*0.5+0.5;
          vec3 base = mix(vec3(0.02,0.0,0.06), vec3(0.0,0.0,0.01), h);
          float band = exp(-pow((vDir.y-0.05)*5.0,2.0));
          base += uTint * band * (0.1 + 0.12*uPulse);
          vec3 g = floor(vDir*180.0);
          float s = step(0.997, hash(g));
          float tw = 0.5+0.5*sin(uTime*2.0 + hash(g+1.0)*40.0);
          base += vec3(s*tw*0.55);
          gl_FragColor = vec4(base,1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), this.skyMat);
    this.group.add(sky);

    // Floor: scrolling neon grid with a glowing runway in the middle.
    this.floorMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uOffset: { value: 0 },
        uPulse: { value: 0 },
        uColA: { value: PALETTE.accentA.clone() },
        uColB: { value: PALETTE.accentB.clone() },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vPos; uniform float uOffset; uniform float uPulse; uniform vec3 uColA; uniform vec3 uColB;
        float line(float x, float w){ float d = abs(fract(x)-0.5); return smoothstep(0.5-w, 0.5, d); }
        void main(){
          float z = -vPos.y; // plane is rotated, local y runs along the track
          float x = vPos.x;
          float gz = line((z + uOffset)/2.0, 0.035);
          float gx = line(x/1.0 + 0.5, 0.025);
          float fade = exp(-max(z,0.0)*0.022);
          float runway = exp(-pow(x/1.05,8.0));
          vec3 col = mix(uColA, uColB, smoothstep(-4.0,4.0,x));
          vec3 c = col * (gz*1.2 + gx*0.8) * (0.8 + 0.7*uPulse);
          c += vec3(0.05,0.02,0.12) * runway * (1.0 + uPulse);
          float edge = exp(-pow((abs(x)-1.15)*14.0,2.0));
          c += col * edge * (0.8 + 1.5*uPulse);
          gl_FragColor = vec4(c * fade, (0.85) * fade + runway*0.1);
        }`,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 160, 1, 1), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -78);
    floor.renderOrder = -1;
    this.group.add(floor);

    // Side light strips along the track edges.
    for (const side of [-1, 1]) {
      const m = new THREE.MeshBasicMaterial({ color: side < 0 ? PALETTE.left : PALETTE.right, toneMapped: false, transparent: true, opacity: 0.7 });
      this.stripMats.push(m);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.012, 150), m);
      strip.position.set(side * 2.2, 0.01, -74);
      this.group.add(strip);
    }

    // Rectangular light frames the player flies through.
    const shape = new THREE.Shape();
    const W = 4.6;
    const H = 4.2;
    const t = 0.07;
    shape.moveTo(-W, -0.02);
    shape.lineTo(W, -0.02);
    shape.lineTo(W, H);
    shape.lineTo(-W, H);
    shape.lineTo(-W, -0.02);
    const hole = new THREE.Path();
    hole.moveTo(-W + t, -0.02 + t);
    hole.lineTo(-W + t, H - t);
    hole.lineTo(W - t, H - t);
    hole.lineTo(W - t, -0.02 + t);
    hole.lineTo(-W + t, -0.02 + t);
    shape.holes.push(hole);
    const ringGeo = new THREE.ShapeGeometry(shape);
    this.ringMat = new THREE.MeshBasicMaterial({ color: PALETTE.accentA, transparent: true, opacity: 0.75, toneMapped: false });
    for (let i = 0; i < 16; i++) {
      const ring = new THREE.Mesh(ringGeo, this.ringMat);
      ring.position.z = -8 - i * 6;
      this.rings.push(ring);
      this.group.add(ring);
    }

    // Lasers sweeping from the horizon.
    for (let i = 0; i < 8; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: i % 2 ? PALETTE.accentB : PALETTE.left,
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 60), m);
      beam.geometry.translate(0, 30, 0);
      beam.position.set((i - 3.5) * 3.2, 0, -70);
      beam.rotation.z = (i - 3.5) * 0.12;
      this.laserMats.push(m);
      this.lasers.push(beam);
      this.group.add(beam);
    }

    // Floating dust.
    const n = 220;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 16;
      pos[i * 3 + 1] = Math.random() * 7;
      pos[i * 3 + 2] = -Math.random() * 80;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(
      dg,
      new THREE.PointsMaterial({ color: 0x9a8cff, size: 0.05, map: dustTexture(), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.group.add(this.dust);
  }

  /** Strong musical accent: flash the lasers. */
  accent(strength: number): void {
    this.flash = Math.max(this.flash, strength);
  }

  update(dt: number, time: number, songTime: number, beatPulse: number, energy: number): void {
    this.flash = Math.max(0, this.flash - dt * 3);
    this.hue = (this.hue + dt * 0.01 * (0.5 + energy)) % 1;
    const pulse = Math.min(1, beatPulse * (0.5 + energy));
    this.floorMat.uniforms.uOffset.value = songTime * this.speed;
    this.floorMat.uniforms.uPulse.value = pulse;
    this.skyMat.uniforms.uTime.value = time;
    this.skyMat.uniforms.uPulse.value = pulse;

    const ringColor = new THREE.Color().setHSL(0.75 + 0.25 * Math.sin(this.hue * Math.PI * 2), 1, 0.55);
    this.ringMat.color.copy(ringColor).multiplyScalar(0.35 + 0.7 * pulse);
    for (const r of this.rings) {
      r.position.z += dt * this.speed * 0.15;
      if (r.position.z > -4) r.position.z -= 6 * this.rings.length;
      const s = 1 + 0.03 * pulse;
      r.scale.set(s, s, 1);
    }
    this.lasers.forEach((l, i) => {
      l.rotation.z = Math.sin(time * 0.6 + i) * 0.5;
      this.laserMats[i].opacity = 0.02 + 0.55 * this.flash * (i % 2 ? 1 : 0.8) + 0.04 * energy;
    });
    this.stripMats.forEach((m, i) => m.color.copy(i === 0 ? PALETTE.left : PALETTE.right).multiplyScalar(0.45 + 0.6 * pulse));
    const p = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let z = p.getZ(i) + dt * this.speed * 0.25;
      if (z > 3) z -= 83;
      p.setZ(i, z);
    }
    p.needsUpdate = true;
  }
}
