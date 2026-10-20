# Sky Quest — asset credits

All third-party assets are CC0 (public domain). Everything else is original.

| File | Source | License |
|---|---|---|
| `models/kit.glb` | 40 models from **Platformer Kit 4.1** by Kenney (www.kenney.nl) — grass/snow blocks, platform, moving block, brick, trees, grass, flowers, rocks, stones, mushrooms, plant, hedge, fences, poles, sign, arrow, barrel, chest, coin, jewel, heart, star, spike traps, spike block, saw, spring, crates, flag. Packed into one GLB (geometry only) by `src/games/quest/tools/build-assets.mjs`. | CC0 1.0 |
| `models/colormap.png` | Platformer Kit 4.1 shared colour palette (Kenney). Recoloured at runtime per level theme. | CC0 1.0 |
| `models/PinkBlob.glb`, `GreenBlob.glb`, `GreenSpikyBlob.glb`, `Armabee.glb`, `Glub.glb` | **Ultimate Monsters** pack by Quaternius (quaternius.com), converted from glTF to GLB with only the used animations (Walk/Idle/Death/HitRecieve/Jump, Flying_Idle/Fast_Flying/Death/HitReact) by `build-assets.mjs`. | CC0 1.0 |
| `music/meadow.mp3`, `music/falls.mp3`, `music/sunset.mp3`, `music/fanfare.mp3` | Original compositions for Move Arcade, rendered by `src/games/quest/tools/make-music.py` (numpy synth). | CC0 1.0 |

Procedural (code, original): sky dome, clouds and cloud sea, rocky island undersides, castle towers, waterfalls,
star (mystery) blocks, gloves, checkpoint flags, goal gate, duck logs, particles, all sound effects (Web Audio).

Rebuild assets:

```
npm i @gltf-transform/core@4 @gltf-transform/functions@4      # in a scratch folder, not the repo
node src/games/quest/tools/build-assets.mjs "<Kenney Platformer Kit>/Models/GLB format" "<Quaternius Ultimate Monsters>/Blob+Flying glTF" public/assets/quest/models
python3 src/games/quest/tools/make-music.py public/assets/quest/music
```
