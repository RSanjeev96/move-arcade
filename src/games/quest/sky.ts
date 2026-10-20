/** Sky dome, sun, cloud billboards and the sea of clouds below the islands. */
import * as THREE from 'three';
import type { ThemeId } from './levels';

export interface Theme {
  id: ThemeId;
  skyTop: string;
  skyMid: string;
  horizon: string;
  below: string;
  sun: string;
  /** Sun direction: azimuth (radians from straight ahead, + = right) and elevation. */
  sunAz: number;
  sunEl: number;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  fog: string;
  fogNear: number;
  fogFar: number;
  cloud: string;
  cloudShade: string;
  sea: string;
  seaShade: string;
  rockTop: string;
  rockMid: string;
  rockLow: string;
  exposure: number;
  water: boolean;
}

export const THEMES: Record<ThemeId, Theme> = {
  meadow: {
    id: 'meadow',
    skyTop: '#2f7df0',
    skyMid: '#6db7ff',
    horizon: '#d4f0ff',
    below: '#eaf7ff',
    sun: '#fff1d0',
    sunAz: Math.PI * 0.6,
    sunEl: 0.62,
    sunI: 2.1,
    hemiSky: '#cfe6ff',
    hemiGround: '#6a5e48',
    hemiI: 1.05,
    fog: '#c6e6ff',
    fogNear: 60,
    fogFar: 250,
    cloud: '#ffffff',
    cloudShade: '#c7dcf5',
    sea: '#ffffff',
    seaShade: '#b9d3f0',
    rockTop: '#b06f42',
    rockMid: '#8d5536',
    rockLow: '#6b4a42',
    exposure: 1.0,
    water: false,
  },
  falls: {
    id: 'falls',
    skyTop: '#2a6fd6',
    skyMid: '#5fb8f0',
    horizon: '#d8f6f2',
    below: '#e6faf6',
    sun: '#fff0c8',
    sunAz: -Math.PI * 0.62,
    sunEl: 0.58,
    sunI: 2.1,
    hemiSky: '#cdeeff',
    hemiGround: '#55634a',
    hemiI: 1.05,
    fog: '#c4ecec',
    fogNear: 55,
    fogFar: 240,
    cloud: '#ffffff',
    cloudShade: '#bfdcec',
    sea: '#f7fffd',
    seaShade: '#a9d4dc',
    rockTop: '#a2704c',
    rockMid: '#7c5a44',
    rockLow: '#56535e',
    exposure: 1.0,
    water: true,
  },
  sunset: {
    id: 'sunset',
    skyTop: '#2c3a8c',
    skyMid: '#b55e9e',
    horizon: '#ffb070',
    below: '#ffcf9c',
    sun: '#ffc27a',
    sunAz: -Math.PI * 0.3,
    sunEl: 0.2,
    sunI: 2.4,
    hemiSky: '#ffc9b0',
    hemiGround: '#5a4560',
    hemiI: 1.2,
    fog: '#f0a790',
    fogNear: 45,
    fogFar: 230,
    cloud: '#ffd9c0',
    cloudShade: '#b06b8c',
    sea: '#ffd0b0',
    seaShade: '#a8608a',
    rockTop: '#9d6a5a',
    rockMid: '#74505a',
    rockLow: '#4f3e5c',
    exposure: 1.05,
    water: false,
  },
};

export function sunDirection(t: Theme): THREE.Vector3 {
  // Path runs along -z; azimuth 0 = straight ahead (-z), +x = right.
  const ce = Math.cos(t.sunEl);
  return new THREE.Vector3(Math.sin(t.sunAz) * ce, Math.sin(t.sunEl), -Math.cos(t.sunAz) * ce).normalize();
}

export class Sky {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(theme: Theme) {
    this.mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(theme.skyTop) },
        uMid: { value: new THREE.Color(theme.skyMid) },
        uHor: { value: new THREE.Color(theme.horizon) },
        uBelow: { value: new THREE.Color(theme.below) },
        uSun: { value: new THREE.Color(theme.sun) },
        uSunDir: { value: sunDirection(theme) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uMid, uHor, uBelow, uSun, uSunDir;
        uniform float uTime;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.28, h));
          col = mix(col, uTop, smoothstep(0.28, 0.95, h));
          col = mix(col, uBelow, smoothstep(0.0, -0.25, h));
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSun * (pow(sd, 900.0) * 4.0 + pow(sd, 60.0) * 0.45 + pow(sd, 6.0) * 0.18);
          // A soft glowing band just above the horizon.
          col += uHor * 0.12 * exp(-pow((h - 0.03) * 9.0, 2.0));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 20), this.mat);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  follow(cam: THREE.Camera): void {
    this.mesh.position.copy(cam.position);
  }
}

// ---- clouds -------------------------------------------------------------------------------------------

/** A soft, puffy cartoon cloud drawn on a canvas (white top, tinted shaded belly). */
function cloudTexture(): THREE.Texture {
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blobs: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const x = 40 + rnd() * 176;
    const r = 22 + rnd() * 26 * (1 - Math.abs(x - 128) / 160);
    blobs.push([x, 82 - r * 0.55 - rnd() * 10, r]);
  }
  blobs.push([128, 60, 40], [90, 70, 30], [168, 70, 32]);
  // Belly shade (drawn first, slightly lower), then the bright tops.
  for (const pass of [0, 1]) {
    for (const [x, y, r] of blobs) {
      const gr = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
      if (pass === 0) {
        gr.addColorStop(0, 'rgba(150,150,150,1)');
        gr.addColorStop(0.85, 'rgba(150,150,150,0.9)');
        gr.addColorStop(1, 'rgba(150,150,150,0)');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(x, y + 6, r, 0, Math.PI * 2);
        g.fill();
      } else {
        gr.addColorStop(0, 'rgba(255,255,255,1)');
        gr.addColorStop(0.7, 'rgba(255,255,255,0.95)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(x, y, r * 0.92, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Many cloud billboards in one draw call (instanced quads that face the camera). */
export class Clouds {
  readonly mesh: THREE.Mesh;
  private offsets: Float32Array;
  constructor(theme: Theme, count: number, place: (i: number) => { x: number; y: number; z: number; w: number }) {
    const geo = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 0.5);
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this.offsets = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const p = place(i);
      this.offsets.set([p.x, p.y, p.z, p.w], i * 4);
    }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(this.offsets, 4));
    geo.instanceCount = count;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: {
        map: { value: cloudTexture() },
        uLight: { value: new THREE.Color(theme.cloud) },
        uShade: { value: new THREE.Color(theme.cloudShade) },
        ...THREE.UniformsLib.fog,
      },
      vertexShader: /* glsl */ `
        attribute vec4 aOff;
        varying vec2 vUv;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(aOff.xyz, 1.0);
          mv.xy += position.xy * aOff.w;
          gl_Position = projectionMatrix * mv;
          vec4 mvPosition = mv;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uLight, uShade;
        varying vec2 vUv;
        #include <fog_pars_fragment>
        void main() {
          vec4 t = texture2D(map, vUv);
          if (t.a < 0.02) discard;
          vec3 col = mix(uShade, uLight, smoothstep(0.55, 1.0, t.r));
          gl_FragColor = vec4(col, t.a * 0.96);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
  }

  /** Drift clouds slowly and wrap them around the player. */
  update(dt: number, playerZ: number): void {
    const o = this.offsets;
    for (let i = 0; i < o.length; i += 4) {
      o[i] += dt * 0.6;
      if (o[i + 2] > playerZ + 120) o[i + 2] -= 760;
      if (o[i] > 420) o[i] -= 840;
    }
    (this.mesh.geometry.attributes.aOff as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
}

/** Tileable soft value-noise texture for the cloud sea (cheap to sample, unlike per-pixel fbm). */
function seaTexture(): THREE.Texture {
  const N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const octave = (cells: number) => {
    const grid: number[] = [];
    for (let i = 0; i < cells * cells; i++) grid.push(rnd());
    const at = (x: number, y: number) => grid[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
    return (x: number, y: number) => {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const ux = fx - ix;
      const uy = fy - iy;
      const sx = ux * ux * (3 - 2 * ux);
      const sy = uy * uy * (3 - 2 * uy);
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const o = [octave(4), octave(8), octave(16)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = o[0](x, y) * 0.55 + o[1](x, y) * 0.3 + o[2](x, y) * 0.15;
      const k = Math.max(0, Math.min(1, (v - 0.35) / 0.4));
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = k * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Endless sea of clouds far below the islands. */
export class CloudSea {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(theme: Theme, y: number) {
    this.mat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: {
        map: { value: seaTexture() },
        uTime: { value: 0 },
        uLight: { value: new THREE.Color(theme.sea) },
        uShade: { value: new THREE.Color(theme.seaShade) },
        ...THREE.UniformsLib.fog,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv1; varying vec2 vUv2;
        uniform float uTime;
        #include <fog_pars_vertex>
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vUv1 = w.xz * 0.006 + vec2(uTime * 0.004, 0.0);
          vUv2 = w.xz * 0.017 + vec2(0.0, uTime * 0.006);
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uLight, uShade;
        varying vec2 vUv1; varying vec2 vUv2;
        #include <fog_pars_fragment>
        void main() {
          float n = texture2D(map, vUv1).r * 0.65 + texture2D(map, vUv2).r * 0.35;
          vec3 col = mix(uShade, uLight, smoothstep(0.2, 0.75, n));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400, 1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = y;
    this.mesh.renderOrder = -6;
  }

  update(time: number, cam: THREE.Camera): void {
    this.mat.uniforms.uTime.value = time;
    this.mesh.position.x = cam.position.x;
    this.mesh.position.z = cam.position.z;
  }
}
