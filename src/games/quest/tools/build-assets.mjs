// Asset pipeline for Sky Quest (not part of the app bundle).
// Packs the chosen Kenney Platformer Kit models into one GLB (geometry only; the shared colormap is loaded
// separately) and converts the chosen Quaternius monsters to GLB with only the animations the game uses.
// Usage: node build-assets.mjs <kenney "GLB format" dir> <quaternius glTF dir> <out dir>
// Needs @gltf-transform/core + @gltf-transform/functions (install them anywhere outside the repo).
import { NodeIO, Document } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [kenneyDir, monsterDir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const io = new NodeIO();

const KENNEY = [
  'block-grass-large', 'block-grass-large-tall', 'block-grass-low-large', 'block-grass', 'block-grass-low',
  'block-snow-large', 'platform', 'block-moving-large', 'brick',
  'tree', 'tree-pine', 'tree-pine-small', 'grass', 'flowers', 'flowers-tall', 'rocks', 'stones', 'mushrooms', 'plant',
  'hedge', 'fence-straight', 'fence-rope', 'poles', 'sign', 'arrow', 'barrel', 'chest',
  'coin-gold', 'jewel', 'heart', 'star',
  'trap-spikes', 'trap-spikes-large', 'spike-block', 'saw', 'spring', 'crate', 'crate-item', 'crate-strong', 'flag',
];

// ---- Kenney: one GLB, one top-level node per model, no textures ----------------------------
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('kit');
const mat = doc.createMaterial('colormap');
for (const name of KENNEY) {
  const src = await io.read(join(kenneyDir, `${name}.glb`));
  const srcRoot = src.getRoot().listScenes()[0].listChildren();
  const copyNode = (n, path) => {
    const node = doc.createNode(path).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
    const m = n.getMesh();
    if (m) {
      const mesh = doc.createMesh(path);
      for (const p of m.listPrimitives()) {
        const prim = doc.createPrimitive().setMaterial(mat);
        for (const sem of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
          const a = p.getAttribute(sem);
          if (!a) continue;
          prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(a.getArray().slice()).setBuffer(buffer));
        }
        const idx = p.getIndices();
        if (idx) prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx.getArray().slice()).setBuffer(buffer));
        mesh.addPrimitive(prim);
      }
      node.setMesh(mesh);
    }
    for (const c of n.listChildren()) node.addChild(copyNode(c, `${path}/${c.getName()}`));
    return node;
  };
  if (srcRoot.length !== 1) throw new Error(`${name}: expected one root node`);
  scene.addChild(copyNode(srcRoot[0], name));
}
await doc.transform(dedup(), prune({ keepAttributes: true }));
await io.write(join(out, 'kit.glb'), doc);
copyFileSync(join(kenneyDir, 'Textures', 'colormap.png'), join(out, 'colormap.png'));

// ---- Quaternius monsters ----------------------------------------------------------------------
const MONSTERS = {
  PinkBlob: ['Walk', 'Idle', 'Death', 'HitRecieve', 'Jump'],
  GreenBlob: ['Walk', 'Idle', 'Death', 'HitRecieve', 'Jump'],
  GreenSpikyBlob: ['Walk', 'Idle', 'Death', 'HitRecieve', 'Jump'],
  Armabee: ['Flying_Idle', 'Fast_Flying', 'Death', 'HitReact'],
  Glub: ['Flying_Idle', 'Fast_Flying', 'Death', 'HitReact'],
};
for (const [name, keep] of Object.entries(MONSTERS)) {
  const m = await io.read(join(monsterDir, `${name}.gltf`));
  for (const a of m.getRoot().listAnimations()) if (!keep.includes(a.getName())) a.dispose();
  await m.transform(prune(), dedup());
  await io.write(join(out, `${name}.glb`), m);
}
console.log('done');
