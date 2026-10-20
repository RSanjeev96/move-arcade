/** Renderer, post-processing, camera rig and the render loop that the menu and the matches share. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Quality } from '../../core/settings';
import { Stadium } from './stadium';
import { stadiumEnvTexture } from './textures';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.32 },
    uSlow: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVignette, uSlow, uFlash, uAspect; uniform vec3 uFlashColor;
    varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5;
      // Slow motion: subtle chromatic split toward the edges.
      vec2 off = c * 0.006 * uSlow;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, mix(vec3(l), col, 0.55) * vec3(1.02, 1.0, 1.08), uSlow * 0.6);
      float r = length(c * vec2(uAspect, 1.0)) / length(vec2(uAspect, 1.0) * 0.5);
      float vig = 1.0 - (uVignette + uSlow * 0.35) * smoothstep(0.35, 1.05, r);
      col *= vig;
      col += uFlashColor * uFlash * 0.6;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export type Level = 'high' | 'medium' | 'low';

export class World {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 2000);
  stadium!: Stadium;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private level: Level;
  readonly software: boolean;
  private fpsAvg = 60;
  private started = performance.now();
  private checked = false;
  private raf = 0;
  private last = performance.now();
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** Horizontal field of view the camera should keep (degrees); vertical FOV follows the aspect. */
  hfov = 78;
  vignette = 0.32;
  slow = 0;
  flash = 0;
  flashColor = new THREE.Color(1, 1, 1);
  step: (dt: number, now: number) => void = () => {};
  /** Longest frame step (s). Demo mode allows more so headless tests keep real-time pace. */
  maxDt = 0.25;

  constructor(
    host: HTMLElement,
    private quality: Quality,
    readonly night: boolean,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl';
    host.prepend(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    // Software rasterizers (headless test browsers) get the light profile unless a quality was chosen.
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.software = /swiftshader|llvmpipe|software/i.test(name);
    this.level = quality === 'auto' ? (this.software ? 'low' : 'high') : quality;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = night ? 1.0 : 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.fog = new THREE.FogExp2(night ? 0x0c1220 : 0xa9bfd6, night ? 0.0024 : 0.0016);
    window.addEventListener('resize', this.resize);
  }

  get currentLevel(): Level {
    return this.level;
  }

  get msaa(): boolean {
    return this.level !== 'low';
  }

  /** Detail factor for geometry/crowd density. */
  get detail(): number {
    if (this.software && this.quality === 'auto') return 0.15;
    return this.level === 'high' ? 1 : this.level === 'medium' ? 0.7 : 0.4;
  }

  /** Running on a software rasterizer with automatic quality: keep the scene light. */
  get light(): boolean {
    return this.software && this.quality === 'auto';
  }

  setStadium(s: Stadium): void {
    this.stadium = s;
    this.scene.add(s.group);
    // Image-based lighting from a painted stand-in of the stadium (floodlight ring, stands, sky, pitch).
    // Prefiltering an image avoids rendering the scene, which would compile every shader synchronously.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const eq = stadiumEnvTexture(this.night);
    this.envRT = pmrem.fromEquirectangular(eq);
    eq.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.night ? 0.55 : 0.7;
    pmrem.dispose();
    this.apply(this.level);
  }

  apply(level: Level): void {
    this.level = level;
    const dpr = window.devicePixelRatio || 1;
    const pr = level === 'high' ? Math.min(dpr, 1.5) : level === 'medium' ? Math.min(dpr, 1) : this.light ? 0.6 : 0.8;
    this.renderer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = level !== 'low';
    if (this.stadium) this.stadium.keyLight.castShadow = level !== 'low';
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.grade = null;
    if (level !== 'low') {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: level === 'high' ? 4 : 2 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 288), this.night ? 0.38 : 0.2, 0.35, this.night ? 1.05 : 1.2);
      this.composer.addPass(this.bloom);
      this.grade = new ShaderPass(GradeShader);
      this.composer.addPass(this.grade);
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.bloom?.setSize(Math.round(w / 2), Math.round(h / 2));
    this.camera.aspect = w / h;
    this.updateFov();
    if (this.grade) this.grade.uniforms.uAspect.value = w / h;
  };

  updateFov(): void {
    const a = this.camera.aspect || 16 / 9;
    const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.hfov) / 2) / a);
    this.camera.fov = Math.min(75, THREE.MathUtils.radToDeg(v));
    this.camera.updateProjectionMatrix();
  }

  /** Compile every shader the scene needs without blocking the page (KHR_parallel_shader_compile). */
  async compile(): Promise<void> {
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* fall back to compiling on first render */
    }
  }

  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const f = (now: number) => {
      this.raf = requestAnimationFrame(f);
      // Generous cap so slow devices (and headless tests) keep real-time pace; physics sub-steps.
      const dt = Math.min(this.maxDt, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      if (dt > 0) this.fpsAvg += 0.05 * (1 / Math.max(dt, 1e-3) - this.fpsAvg);
      this.autoQuality(now);
      this.step(dt, now);
      this.render();
    };
    this.raf = requestAnimationFrame(f);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get fps(): number {
    return this.fpsAvg;
  }

  private autoQuality(now: number): void {
    if (this.quality !== 'auto' || this.checked || now - this.started < 6000) return;
    this.checked = true;
    if (this.fpsAvg < 38) this.apply('low');
    else if (this.fpsAvg < 50) this.apply('medium');
  }

  render(): void {
    if (this.grade) {
      const u = this.grade.uniforms;
      u.uVignette.value = this.vignette;
      u.uSlow.value = this.slow;
      u.uFlash.value = this.flash;
      u.uFlashColor.value.copy(this.flashColor);
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** JPEG snapshot of the current frame (for the results background). */
  snapshot(): string {
    try {
      this.render();
      return this.canvas.toDataURL('image/jpeg', 0.82);
    } catch {
      return '';
    }
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resize);
    this.composer?.dispose();
    this.envRT?.dispose();
    this.stadium?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const x of mats) {
        for (const v of Object.values(x)) if (v instanceof THREE.Texture) v.dispose();
        x.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
