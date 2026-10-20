/** Menu showroom: the selected vehicle on a slowly turning stage with studio reflections. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LIVERIES, makeF1, makeMoto, type VehicleView } from './cars';

export class Showroom {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
  private view: VehicleView | null = null;
  private kind: 'f1' | 'moto' | null = null;
  private raf = 0;
  private last = performance.now();
  private angle = 0.7;
  private env: THREE.WebGLRenderTarget;
  private floorMat: THREE.MeshStandardMaterial;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.env = pm.fromScene(new RoomEnvironment(), 0.04);
    pm.dispose();
    this.scene.environment = this.env.texture;
    this.scene.environmentIntensity = 0.9;
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -4;
    sc.right = sc.top = 4;
    const rim = new THREE.DirectionalLight(0xff8a50, 1.4);
    rim.position.set(-4, 2, -5);
    this.scene.add(key, rim, new THREE.HemisphereLight(0xb0c4ff, 0x201010, 0.5));
    // Glossy turntable.
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0x15151c, roughness: 0.25, metalness: 0.6 });
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 0.08, 64), this.floorMat);
    floor.position.y = -0.04;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.03, 8, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.4, 0.15).multiplyScalar(2) }));
    ring.rotation.x = Math.PI / 2;
    this.scene.add(ring);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  set(kind: 'f1' | 'moto'): void {
    if (kind === this.kind) return;
    this.kind = kind;
    if (this.view) {
      this.scene.remove(this.view.root);
      this.view.dispose();
    }
    this.view = kind === 'f1' ? makeF1(LIVERIES[0]) : makeMoto(LIVERIES[0]);
    this.view.root.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    this.scene.add(this.view.root);
    const f1 = kind === 'f1';
    this.camera.position.set(0, f1 ? 1.9 : 1.35, f1 ? 8.2 : 5.6);
    this.camera.lookAt(0, f1 ? 0.25 : 0.68, 0);
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 400;
    const h = this.canvas.clientHeight || 225;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.canvas.clientWidth && Math.abs(this.canvas.clientWidth - this.renderer.domElement.width / this.renderer.getPixelRatio()) > 2) this.resize();
    this.angle += dt * 0.35;
    if (this.view) {
      this.view.root.rotation.y = this.angle;
      this.view.pose(Math.sin(this.angle * 0.7) * 0.25, this.kind === 'moto' ? Math.sin(this.angle * 0.5) * 0.35 : 0, -this.angle * 3, { brake: 0, drs: false, tuck: 0, hang: 0 });
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.view?.dispose();
    this.env.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.parent && !(this.view && this.view.root === m.parent)) m.geometry.dispose?.();
    });
    this.floorMat.dispose();
    this.renderer.dispose();
  }
}
