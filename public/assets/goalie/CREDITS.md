# Goalkeeper — asset credits

All third-party assets are CC0 (public domain). Everything not listed here (ball pattern, goal net,
crowd sprites, LED advertising with fictional brand names, big screen, glare, kit colours and numbers,
all sounds) is generated procedurally at runtime by the game code.

| File | Source | License |
|---|---|---|
| `footballer.glb` | Built from Quaternius **Universal Base Characters** (Standard) — `Superhero_Male_FullBody` body, eyes and eyebrows, `Hair_SimpleParted` (rigged to the head bone); textures resized to 1024/256/128 px JPG. Animations retargeted by bone name from Quaternius **Universal Animation Library** (Idle_Loop, Jog_Fwd_Loop, Sprint_Loop, Walk_Loop, Jump_Start, Jump_Loop, Jump_Land, Hit_Chest, Dance_Loop, Crouch_Idle_Loop) and **Universal Animation Library 2** (Yes, Idle_No_Loop, Idle_FoldArms_Loop, Slide_Start, Slide_Loop, OverhandThrow, Idle_Rail_Call). Meshopt-compressed with glTF-Transform. https://quaternius.com/packs/universalbasecharacters.html · https://quaternius.com/packs/universalanimationlibrary.html · https://quaternius.com/packs/universalanimationlibrary2.html (downloads via https://quaternius.itch.io) | CC0 1.0 |
| `footballer_lod.glb` | Low-detail version of the same body and hair (meshoptimizer simplification, ~22 % of the triangles), no textures or animations (they are shared with `footballer.glb` at runtime). | CC0 1.0 |
| `grass.jpg` | ambientCG **Grass005** (1K JPG, colour map), used as a luminance detail texture under the procedural mowing stripes. https://ambientcg.com/view?id=Grass005 | CC0 1.0 |

Kits are painted in a shader from bind-pose body regions; team and sponsor names (Arcade United,
Real Valoria, Riverside Rovers, Dynamo Kastell, Voltara, Nordwind Air, Kairo Bank, Pixelforge, Aurelia,
Zephyr Sport, Octane Cola) are fictional.
