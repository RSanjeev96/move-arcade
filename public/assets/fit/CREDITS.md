# Dance Fit assets

| File | Source | Author | License |
|---|---|---|---|
| `coach-mia.glb` | "Ultimate Modular Women" pack, `Individual Characters/glTF/Casual.gltf` — https://quaternius.com/packs/ultimatemodularwomen.html | Quaternius | CC0 1.0 (public domain) |
| `coach-leo.glb` | "Ultimate Modular Characters" (men) pack, `Individual Characters/glTF/Casual_2.gltf` — https://quaternius.com/packs/ultimatemodularcharacters.html | Quaternius | CC0 1.0 (public domain) |

Changes made for this game: animations and unused data removed, flat-shaded normals welded and replaced with smooth
vertex normals, converted to binary glTF. Clothing colours, the stripe trim and the rim light are applied at runtime.
All poses are generated procedurally from the move definitions in `src/games/fit/moves.ts` (no animation clips).

Music: the bundled tracks in `public/music/` (Move Arcade originals, CC0) and songs the player adds on the tablet.
Pictograms, stage, particles and sounds are generated in code.
