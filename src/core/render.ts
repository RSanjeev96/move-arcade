import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Quality } from './settings';

export interface RenderOptions {
  bloom?: { strength: number; radius: number; threshold: number };
  exposure?: number;
  shadows?: boolean;
}

/**
 * Shared WebGL setup: tone mapping, optional bloom, shadows, resize handling and automatic quality
 * (starts high, steps down after a few seconds if the tablet cannot keep up).
 */
export class Renderer3D {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private fpsAvg = 60;
  private started = performance.now();
  private checked = false;
  private level: 'high' | 'medium' | 'low';

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    private quality: Quality,
    private opts: RenderOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure ?? 1;
    this.renderer.shadowMap.enabled = !!opts.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.level = quality === 'auto' ? 'high' : quality;
    this.apply(this.level);
    window.addEventListener('resize', this.resize);
  }

  get currentLevel(): 'high' | 'medium' | 'low' {
    return this.level;
  }

  apply(level: 'high' | 'medium' | 'low'): void {
    this.level = level;
    const dpr = window.devicePixelRatio || 1;
    const pr = level === 'high' ? Math.min(dpr, 1.5) : level === 'medium' ? Math.min(dpr, 1) : 0.75;
    this.renderer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = !!this.opts.shadows && level !== 'low';
    if (this.opts.bloom && level !== 'low') {
      if (!this.composer) {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        const b = this.opts.bloom;
        this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 288), b.strength, b.radius, b.threshold);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
      }
      this.bloom!.strength = this.opts.bloom.strength * (level === 'high' ? 1 : 0.75);
      this.composer.setPixelRatio(pr);
    } else {
      this.composer?.dispose();
      this.composer = null;
      this.bloom = null;
    }
    this.resize();
  }

  resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.bloom?.setSize(Math.round(w / 2), Math.round(h / 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /** Call once per animation frame with the frame time in seconds. */
  render(dt: number): void {
    if (dt > 0) this.fpsAvg += 0.05 * (1 / Math.max(dt, 1e-3) - this.fpsAvg);
    if (this.quality === 'auto' && !this.checked && performance.now() - this.started > 5000) {
      this.checked = true;
      if (this.fpsAvg < 40) this.apply('low');
      else if (this.fpsAvg < 52) this.apply('medium');
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get fps(): number {
    return this.fpsAvg;
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.composer?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.renderer.dispose();
  }
}

/** Game loop helper: calls `step(dt, now)` every animation frame until stopped. */
export function loop(step: (dt: number, now: number) => void): () => void {
  let raf = 0;
  let last = performance.now();
  const f = (now: number) => {
    raf = requestAnimationFrame(f);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt, now);
  };
  raf = requestAnimationFrame(f);
  return () => cancelAnimationFrame(raf);
}
