# Centre Court — asset credits

All third-party assets are CC0 1.0 (public domain). Everything else (court, stadium, crowd sprites,
racket, ball, textures, sounds) is generated procedurally in code.

| File | Source | Author | License | Changes |
|---|---|---|---|---|
| `male.glb` | "Universal Base Characters [Standard]" — `Superhero_Male_FullBody`, hair `Hair_SimpleParted`, `Hair_Buzzed`, `Hair_Beard` — https://quaternius.itch.io/universal-base-characters | Quaternius | CC0 1.0 | Hair meshes rebound to the body skeleton; animation clips added (below); textures resized to 1024/512 px JPEG; unused UV/colour sets removed. |
| `female.glb` | Same pack — `Superhero_Female_FullBody`, hair `Hair_Buns`, `Hair_Long` | Quaternius | CC0 1.0 | As above (no clips; it shares the male file's clips by bone name). |
| clips in `male.glb` (`Idle_Loop`, `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`, `Sitting_Idle_Loop`, `Crouch_Idle_Loop`, `Sword_Idle`) | "Universal Animation Library [Standard]" — https://quaternius.itch.io/universal-animation-library | Quaternius | CC0 1.0 | Rotation tracks retargeted by bone name, pelvis translation scaled, resampled. Tennis strokes and serves are procedural (IK), not clips. |
| `sky-dusk.jpg` | "Qwantani Dusk 2 (Pure Sky)" — https://polyhaven.com/a/qwantani_dusk_2_puresky | Greg Zaal, Jarod Guest (Poly Haven) | CC0 1.0 | 2K HDR tone-mapped to a 2048×1024 JPEG. |
| `sky-day.jpg` | "Kloppenheim 06 (Pure Sky)" — https://polyhaven.com/a/kloppenheim_06_puresky | Greg Zaal, Jarod Guest (Poly Haven) | CC0 1.0 | 2K HDR tone-mapped to a 2048×1024 JPEG. |

Total size ≈ 2.8 MB.
