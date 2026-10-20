/**
 * The dance stage: animated gradient backdrop, glowing halo rings behind the coach, sweeping light beams, LED
 * equaliser columns, a reflective floor with beat ripples, floating dust and particle bursts. Everything pulses with
 * the analysed beat.
 */
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BACKDROP_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uTime; uniform float uPulse; uniform float uHype;
  uniform vec3 uA; uniform vec3 uB; uniform vec3 uDeep;
  void main(){
    // Baked masks: r = glow behind the coach, g = ray fan, b = LED dots, a = vertical gradient.
    vec4 m = texture2D(uMap, vUv);
    vec3 col = uDeep * (0.45 + 0.7 * m.a);
    col += mix(uA, uB, 0.5 + 0.5 * sin(uTime * 0.2)) * m.r * (0.1 + 0.1 * uPulse);
    col += uB * m.g * (0.05 + 0.08 * uHype + 0.08 * uPulse);
    float tw = 0.5 + 0.5 * sin(uTime * 2.3 + vUv.x * 57.0 + vUv.y * 31.0);
    col += mix(uA, uB, vUv.x) * m.b * tw * (0.08 + 0.14 * uPulse);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

let backdropCache: THREE.Texture | null = null;

/** Bake the backdrop's static patterns into one small texture (cheap to draw every frame). */
function backdropTexture(): THREE.Texture {
  if (backdropCache) return backdropCache;
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const d = img.data;
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const dots = new Uint8Array(90 * 50);
  for (let i = 0; i < dots.length; i++) dots[i] = rnd() > 0.62 ? 1 : 0;
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const px = (u - 0.5) * 1.9;
      const py = v - 0.42;
      const r = Math.hypot(px, py);
      const glow = Math.exp(-r * r * 2.2) + 0.35 * Math.exp(-Math.pow((v - 0.3) * 9, 2)) + 0.5 * Math.exp(-Math.pow((v - 0.97) * 4, 2));
      const a = Math.atan2(py, px);
      const rays = Math.pow(0.5 + 0.5 * Math.sin(a * 14), 6) * Math.min(1, Math.max(0, (r - 0.15) / 0.45)) * Math.exp(-r * 1.4);
      const gx = u * 90;
      const gy = v * 50;
      const cell = Math.floor(gy) * 90 + Math.floor(gx);
      const dd = Math.hypot((gx % 1) - 0.5, (gy % 1) - 0.5);
      const led = dots[cell] * Math.max(0, Math.min(1, (0.32 - dd) / 0.2)) * Math.max(0, Math.min(1, (v - 0.25) / 0.35)) * Math.max(0, Math.min(1, (r - 0.12) / 0.33));
      const vig = 1 - Math.max(0, Math.min(1, (Math.hypot((u - 0.5) * 1.4, v - 0.5) - 0.6) / 0.65));
      const grad = (0.1 + 0.9 * Math.max(0, Math.min(1, (v - 0.1) / 0.9))) * vig;
      const i = (y * W + x) * 4;
      d[i] = Math.min(255, glow * vig * 200);
      d[i + 1] = Math.min(255, rays * vig * 255 * 2.2);
      d[i + 2] = Math.min(255, led * vig * 255);
      d[i + 3] = Math.min(255, grad * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.premultiplyAlpha = false;
  backdropCache = t;
  return t;
}

const FLOOR_FRAG = /* glsl */ `
  uniform vec3 color; uniform sampler2D tDiffuse; varying vec4 vUv; varying vec2 vXZ;
  uniform float uTime; uniform float uBeat; uniform float uPulse; uniform vec3 uA; uniform vec3 uB; uniform float uRefl;
  #include <logdepthbuf_pars_fragment>
  void main(){
    #include <logdepthbuf_fragment>
    vec2 uv = vUv.xy / vUv.w;
    vec3 refl = vec3(0.0);
    float o = 0.004;
    refl += texture2D(tDiffuse, uv).rgb * 0.36;
    refl += texture2D(tDiffuse, uv + vec2(o, 0.0)).rgb * 0.16;
    refl += texture2D(tDiffuse, uv - vec2(o, 0.0)).rgb * 0.16;
    refl += texture2D(tDiffuse, uv + vec2(0.0, o * 1.6)).rgb * 0.16;
    refl += texture2D(tDiffuse, uv - vec2(0.0, o * 1.6)).rgb * 0.16;
    float r = length(vXZ);
    vec3 base = mix(vec3(0.05, 0.02, 0.10), vec3(0.015, 0.008, 0.035), smoothstep(0.0, 7.0, r));
    // Stage circle under the coach.
    float ring = exp(-pow((r - 1.55) * 16.0, 2.0));
    float inner = exp(-pow((r - 1.1) * 30.0, 2.0)) * 0.5;
    vec3 rc = mix(uA, uB, 0.5 + 0.5 * sin(atan(vXZ.y, vXZ.x) * 2.0 + uTime));
    base += rc * (ring * (0.7 + 1.4 * uPulse) + inner * (0.3 + uPulse));
    // Beat ripples travelling outward.
    float wave = fract(uBeat);
    float rip = exp(-pow((r - 1.6 - wave * 5.0) * 7.0, 2.0)) * (1.0 - wave);
    base += uB * rip * 0.35;
    // Floor tiles.
    vec2 g = abs(fract(vXZ * 0.9) - 0.5);
    float line = smoothstep(0.485, 0.5, max(g.x, g.y));
    base += uA * line * 0.06 * smoothstep(7.0, 2.0, r);
    vec3 col = base + refl * uRefl * smoothstep(8.0, 1.0, r);
    float alpha = 1.0 - smoothstep(6.0, 8.0, r);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const FLOOR_VERT = /* glsl */ `
  uniform mat4 textureMatrix; varying vec4 vUv; varying vec2 vXZ;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main(){
    vUv = textureMatrix * vec4(position, 1.0);
    vXZ = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const BEAM_FRAG = /* glsl */ `
  varying vec2 vUv; uniform vec3 uColor; uniform float uK;
  void main(){
    float a = pow(1.0 - vUv.y, 1.6) * (1.0 - pow(abs(vUv.x - 0.5) * 2.0, 2.0));
    gl_FragColor = vec4(uColor * a * uK, 1.0);
  }`;

const UV_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  max: number;
  c: THREE.Color;
  size: number;
}

export class Stage {
  readonly group = new THREE.Group();
  private colA = new THREE.Color('#ff2d6a');
  private colB = new THREE.Color('#8a3bff');
  private tA = new THREE.Color('#ff2d6a');
  private tB = new THREE.Color('#8a3bff');
  private backMat: THREE.ShaderMaterial;
  private floor: THREE.Mesh;
  private floorUniforms: Record<string, THREE.IUniform>;
  private rings: THREE.Mesh[] = [];
  private ringMats: THREE.MeshBasicMaterial[] = [];
  private beams: THREE.Mesh[] = [];
  private beamMats: THREE.ShaderMaterial[] = [];
  private bars: THREE.InstancedMesh;
  private barLevels: number[] = [];
  private barMat: THREE.MeshBasicMaterial;
  private dust: THREE.Points;
  private burstPts: THREE.Points;
  private particles: Particle[] = [];
  private flashK = 0;
  private rimL: THREE.PointLight;
  private rimR: THREE.PointLight;
  readonly key: THREE.SpotLight;
  private reflector: Reflector | null = null;
  private dummy = new THREE.Object3D();
  private time = 0;

  constructor(
    private scene: THREE.Scene,
    quality: 'high' | 'medium' | 'low',
  ) {
    scene.background = new THREE.Color('#0a0418');
    scene.fog = new THREE.Fog('#0c0524', 16, 36);

    // Backdrop.
    this.backMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: backdropTexture() },
        uTime: { value: 0 },
        uPulse: { value: 0 },
        uHype: { value: 0 },
        uA: { value: this.colA },
        uB: { value: this.colB },
        uDeep: { value: new THREE.Color('#0f0730') },
      },
      vertexShader: UV_VERT,
      fragmentShader: BACKDROP_FRAG,
      depthWrite: false,
      fog: false,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(44, 22), this.backMat);
    back.position.set(0, 4.5, -9);
    back.renderOrder = -2;
    this.group.add(back);

    // Floor: blurred mirror reflection with glowing stage rings.
    const floorGeo = new THREE.CircleGeometry(8, 64);
    const shader = {
      name: 'FitFloor',
      uniforms: {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
        uTime: { value: 0 },
        uBeat: { value: 0 },
        uPulse: { value: 0 },
        uA: { value: this.colA },
        uB: { value: this.colB },
        uRefl: { value: 0.9 },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
    };
    if (quality !== 'low') {
      const w = quality === 'high' ? 768 : 512;
      this.reflector = new Reflector(floorGeo, { textureWidth: w, textureHeight: Math.round(w * 0.56), shader, multisample: 0, clipBias: 0.003 });
      this.floor = this.reflector;
      this.floorUniforms = (this.reflector.material as THREE.ShaderMaterial).uniforms;
    } else {
      const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      blank.needsUpdate = true;
      const mat = new THREE.ShaderMaterial({ ...shader, uniforms: THREE.UniformsUtils.clone(shader.uniforms) });
      mat.uniforms.tDiffuse.value = blank;
      mat.uniforms.textureMatrix.value = new THREE.Matrix4();
      mat.uniforms.uRefl.value = 0;
      this.floor = new THREE.Mesh(floorGeo, mat);
      this.floorUniforms = mat.uniforms;
    }
    this.floorUniforms.uA.value = this.colA;
    this.floorUniforms.uB.value = this.colB;
    (this.floor.material as THREE.ShaderMaterial).transparent = true;
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = false;
    this.group.add(this.floor);

    // Shadow catcher on top of the floor.
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.ShadowMaterial({ opacity: 0.45 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    shadow.receiveShadow = true;
    this.group.add(shadow);

    // Halo rings behind the coach.
    const ringSpecs = [
      { r: 1.55, t: 0.03, z: -1.4, y: 1.08 },
      { r: 1.85, t: 0.012, z: -1.6, y: 1.08 },
      { r: 2.3, t: 0.008, z: -1.9, y: 1.08 },
    ];
    for (const s of ringSpecs) {
      const m = new THREE.MeshBasicMaterial({ color: this.colA.clone(), toneMapped: false, transparent: true, opacity: 0.95, fog: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(s.r, s.t, 8, 120), m);
      ring.position.set(0, s.y, s.z);
      this.rings.push(ring);
      this.ringMats.push(m);
      this.group.add(ring);
    }

    // Light beams from the rig above.
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.9, 7, 16, 1, true);
    beamGeo.translate(0, -3.5, 0);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(i % 2 ? '#ffffff' : '#ff9ad5') }, uK: { value: 0.1 } },
        vertexShader: UV_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
        fog: false,
      });
      const beam = new THREE.Mesh(beamGeo, m);
      const x = (i - 1.5) * 2.3;
      beam.position.set(x, 6.4, -2.6 + Math.abs(i - 1.5) * 0.25);
      this.beams.push(beam);
      this.beamMats.push(m);
      this.group.add(beam);
    }

    // LED equaliser columns either side.
    const barGeo = new THREE.BoxGeometry(0.16, 1, 0.08);
    barGeo.translate(0, 0.5, 0);
    this.barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false });
    const n = 24;
    this.bars = new THREE.InstancedMesh(barGeo, this.barMat, n);
    for (let i = 0; i < n; i++) {
      this.barLevels.push(0.3);
      this.bars.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    this.group.add(this.bars);

    // Lights.
    this.group.add(new THREE.HemisphereLight(0xd8d0ff, 0x2a1440, 1.2));
    this.key = new THREE.SpotLight(0xfff3f8, 55, 22, 0.45, 0.6, 1.4);
    this.key.position.set(1.6, 6.5, 6.5);
    this.key.target.position.set(0, 0.9, 0);
    this.key.castShadow = quality !== 'low';
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0005;
    this.key.shadow.radius = 4;
    this.group.add(this.key, this.key.target);
    const fill = new THREE.DirectionalLight(0xb0c4ff, 1.0);
    fill.position.set(-4, 3, 5);
    this.group.add(fill);
    this.rimL = new THREE.PointLight(this.colA, 18, 9, 1.6);
    this.rimL.position.set(-2.4, 2.6, -1.6);
    this.rimR = new THREE.PointLight(this.colB, 18, 9, 1.6);
    this.rimR.position.set(2.4, 2.6, -1.6);
    this.group.add(this.rimL, this.rimR);

    // Dust.
    const dn = quality === 'low' ? 60 : 120;
    const dpos = new Float32Array(dn * 3);
    for (let i = 0; i < dn; i++) {
      dpos[i * 3] = (Math.random() - 0.5) * 14;
      dpos[i * 3 + 1] = Math.random() * 6;
      dpos[i * 3 + 2] = -1.6 - Math.random() * 7;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    this.dust = new THREE.Points(
      dg,
      new THREE.PointsMaterial({ color: 0xffc8f0, size: 0.045, map: dotTexture(), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.group.add(this.dust);

    // Particle bursts.
    const max = 420;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    bg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    bg.setDrawRange(0, 0);
    this.burstPts = new THREE.Points(
      bg,
      new THREE.PointsMaterial({ size: 0.09, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    this.burstPts.frustumCulled = false;
    this.group.add(this.burstPts);

    // Only these show up in the floor reflection (layer 1), which keeps the mirror pass cheap.
    for (const o of [...this.rings, this.bars, this.burstPts]) o.layers.enable(1);
    scene.add(this.group);
    this.layoutBars();
  }

  /** Limit the floor reflection to objects on layer 1 (the coach, rings, bars and sparks). */
  setCamera(camera: THREE.Camera): void {
    if (!this.reflector) return;
    this.reflector.getReflectionCamera(camera).layers.set(1);
  }

  private layoutBars(): void {
    const n = this.bars.count;
    const half = n / 2;
    for (let i = 0; i < n; i++) {
      const side = i < half ? -1 : 1;
      const k = i % half;
      const x = side * (3.0 + k * 0.26);
      this.dummy.position.set(x, 0, -2.4 - k * 0.12);
      this.dummy.scale.set(1, this.barLevels[i] * 3, 1);
      this.dummy.updateMatrix();
      this.bars.setMatrixAt(i, this.dummy.matrix);
    }
    this.bars.instanceMatrix.needsUpdate = true;
  }

  setPalette(a: string, b: string): void {
    this.tA.set(a);
    this.tB.set(b);
  }

  /** Big flash (perfect streaks, move changes). */
  flash(k: number): void {
    this.flashK = Math.max(this.flashK, k);
  }

  /** Spray particles from a point (perfect moves, reps). */
  burst(at: THREE.Vector3, color: THREE.Color, n = 40, speed = 2.6, up = 1.2): void {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= 420) this.particles.shift();
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      const s = speed * (0.4 + Math.random() * 0.8);
      const c = color.clone().lerp(new THREE.Color(1, 1, 1), Math.random() * 0.5);
      this.particles.push({ p: at.clone(), v: dir.multiplyScalar(s).add(new THREE.Vector3(0, up, 0)), life: 0, max: 0.45 + Math.random() * 0.5, c, size: 1 });
    }
  }

  /** Confetti shower for the finale. */
  confetti(): void {
    const cols = [this.colA, this.colB, new THREE.Color('#ffd04d'), new THREE.Color('#3bffb4'), new THREE.Color('#ffffff')];
    for (let i = 0; i < 260; i++) {
      if (this.particles.length >= 420) this.particles.shift();
      const p = new THREE.Vector3((Math.random() - 0.5) * 7, 3.6 + Math.random() * 2, (Math.random() - 0.5) * 3);
      this.particles.push({
        p,
        v: new THREE.Vector3((Math.random() - 0.5) * 0.8, -0.6 - Math.random() * 0.8, (Math.random() - 0.5) * 0.4),
        life: 0,
        max: 3 + Math.random() * 2,
        c: cols[i % cols.length].clone(),
        size: 1,
      });
    }
  }

  /**
   * @param beat fractional beat index (for ripples)
   * @param pulse 0..1 decaying beat pulse
   * @param energy song loudness 0..1
   * @param hype player streak / intensity 0..1
   */
  update(dt: number, beat: number, pulse: number, energy: number, hype: number): void {
    this.time += dt;
    const t = this.time;
    const k = 1 - Math.exp(-dt * 1.5);
    this.colA.lerp(this.tA, k);
    this.colB.lerp(this.tB, k);
    this.flashK = Math.max(0, this.flashK - dt * 2.2);
    const pz = Math.min(1, pulse * (0.55 + 0.6 * energy));

    const u = this.backMat.uniforms;
    u.uTime.value = t;
    u.uPulse.value = pz + this.flashK * 0.6;
    u.uHype.value = hype;
    const f = this.floorUniforms;
    f.uTime.value = t;
    f.uBeat.value = beat;
    f.uPulse.value = pz + this.flashK * 0.5;

    this.rings.forEach((r, i) => {
      const s = 1 + pz * (0.04 - i * 0.008) + this.flashK * 0.05;
      r.scale.set(s, s, 1);
      r.rotation.z = t * (i % 2 ? -0.15 : 0.1);
      const c = i === 1 ? this.colB : this.colA;
      this.ringMats[i].color.copy(c).multiplyScalar(0.55 + 1.1 * pz + 1.2 * this.flashK - i * 0.15);
    });

    this.beams.forEach((b, i) => {
      const sw = Math.sin(t * (0.5 + i * 0.07) + i * 1.3) * 0.38;
      b.rotation.z = sw + (i - 1.5) * 0.08;
      b.rotation.x = 0.18 + Math.sin(t * 0.4 + i) * 0.08;
      const m = this.beamMats[i];
      (m.uniforms.uColor.value as THREE.Color).copy(i % 2 ? this.colB : this.colA).lerp(new THREE.Color(1, 1, 1), 0.35);
      m.uniforms.uK.value = 0.025 + 0.09 * pz * (i % 2 ? 1 : 0.7) + 0.16 * this.flashK + 0.03 * hype;
    });

    // Equaliser: random targets that jump on the beat.
    const n = this.bars.count;
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const kk = i % (n / 2);
      const target = 0.12 + energy * 0.5 * (0.5 + 0.5 * Math.sin(t * 3 + i * 1.7)) + pz * (0.5 - kk * 0.03) * (0.6 + 0.4 * Math.sin(i * 7.3 + Math.floor(beat) * 2.1));
      this.barLevels[i] += (target - this.barLevels[i]) * Math.min(1, dt * (target > this.barLevels[i] ? 18 : 4));
      col.copy(this.colA).lerp(this.colB, kk / (n / 2)).multiplyScalar(0.12 + this.barLevels[i] * 0.55);
      this.bars.setColorAt(i, col);
    }
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
    this.layoutBars();

    this.rimL.color.copy(this.colA);
    this.rimR.color.copy(this.colB);
    this.rimL.intensity = 14 + 22 * pz + 26 * this.flashK;
    this.rimR.intensity = 14 + 22 * pz + 26 * this.flashK;
    this.key.intensity = 48 + 10 * pz;

    const dp = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < dp.count; i++) {
      let y = dp.getY(i) + dt * (0.08 + (i % 5) * 0.02);
      if (y > 6) y -= 6;
      dp.setY(i, y);
    }
    dp.needsUpdate = true;

    // Bursts.
    const pos = this.burstPts.geometry.attributes.position as THREE.BufferAttribute;
    const cc = this.burstPts.geometry.attributes.color as THREE.BufferAttribute;
    let w = 0;
    const live: Particle[] = [];
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.v.y -= dt * (p.max > 2 ? 0.2 : 2.2);
      p.v.multiplyScalar(1 - dt * (p.max > 2 ? 0.3 : 1.4));
      p.p.addScaledVector(p.v, dt);
      if (p.max > 2) p.p.x += Math.sin(t * 3 + p.max * 10) * dt * 0.3;
      const fade = 1 - p.life / p.max;
      pos.setXYZ(w, p.p.x, p.p.y, p.p.z);
      cc.setXYZ(w, p.c.r * fade * 1.6, p.c.g * fade * 1.6, p.c.b * fade * 1.6);
      w++;
      live.push(p);
    }
    this.particles = live;
    pos.needsUpdate = true;
    cc.needsUpdate = true;
    this.burstPts.geometry.setDrawRange(0, w);
  }

  /** Drop the mirror reflection and shadows (auto quality stepped down). */
  lowQuality(): void {
    if (this.reflector) {
      this.reflector.onBeforeRender = () => {};
      this.floorUniforms.uRefl.value = 0;
    }
    this.key.castShadow = false;
  }

  get palette(): [THREE.Color, THREE.Color] {
    return [this.colA, this.colB];
  }

  dispose(): void {
    this.reflector?.dispose();
    this.scene.remove(this.group);
  }
}
