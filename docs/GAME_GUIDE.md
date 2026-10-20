# Building a Move Arcade game

Move Arcade is a set of camera-tracked motion games that run in Chrome on a **Samsung Galaxy Tab S7+**
(Snapdragon 865+, Adreno 650 GPU, 6 GB RAM). The tablet sits in landscape **below a TV**, mirrored to it over
HDMI, front camera facing the room. The player stands (or sits, where noted) **2–3 m away**. There are no
controllers: the body is the only input. Players are adults who want games that feel **polished and
console-quality** (think Wii Sports / Nintendo Switch Sports / Kinect Adventures level of finish), not a demo.

## Architecture (read these files first)

| File | What it gives you |
|---|---|
| `src/games/types.ts` | `GameEnv` (pose, body tracker, audio, settings, demo flag, url params, cursor) and `OpenGame` |
| `src/games/registry.ts` | Game list (do not edit — the lead flips `ready`) |
| `src/core/body.ts` | `BodyTracker.measure(frame)` → `Body` in **body space**: origin = shoulder centre, 1 unit = shoulder width, +x = player's right (already mirrored), +y = up. `lean` (sideways shift, shoulder widths), `duck` (shoulder drop, fraction of torso), `rise` (hip rise, fraction of torso) need calibration, which the app does before any game. Wrist depth `lWristZ/rWristZ` is rough. |
| `src/core/gestures.ts` | `wheel()` steering, `torsoTilt()`, `bodyLean()`, `handsUp()`, `JumpDetector`, `SwingDetector`, `PunchDetector`, `StepDetector`, `Hold` |
| `src/core/pose.ts` | `CameraPose` (real) and `SimPose` (demo). `pose.since(t)` returns frames captured after t (each has a capture timestamp `t`, ms, performance.now clock). In demo mode `env.pose instanceof SimPose`; set `sim.drive = (tMs) => SimParams` to animate a fake player (hands, lean, duck, rise, tilt, knee lifts, wrist depth). |
| `src/core/render.ts` | `Renderer3D` (three.js renderer with tone mapping, optional bloom, shadows, auto quality, resize) and `loop()` |
| `src/core/audio.ts` | `AudioEngine.get()`: `load(url)`, `playSong(buf, leadIn)`, `songTime()`, `stopSong()`, synthesized SFX (`slice`, `beep`, `select`, `bomb`, …). Add your own Web Audio sounds through `audio.ctx` / `audio.sfx` (gain node). |
| `src/ui/kit.ts` | `html`, `mount`, `topbar` (Back button = `data-act="back"`), `choiceRow` + `bindChoices`, `loading`, `bests` (best scores), `showResults` (results card → action), `HandsUpPause` + `pauseMenu`, `CamPreview`, `CenterText`, `fmtClock` |
| `src/styles.css` | Design tokens and shared classes: `.screen`, `.btn` (`.primary`, `.big`, `.sm`, `.on`), `.glass`, `.topbar`, `.game-menu` (`.menu-body`, `.how`, `.side`), `.game-root` + `canvas.gl`, `.ghud` (corner slots `.tl .tr .tc .bl .br .bc`, `.panel`, `.stat`), `.center-msg`, `.hud-cam`, `.pause-menu` |
| `src/games/blade/` | A complete reference game (menus, 3D, HUD, bot, results). Copy its patterns. |

## Rules

1. **Work only inside `src/games/<id>/` and `public/assets/<id>/`.** Do not edit shared files (`src/core`, `src/ui`, `src/app.ts`, `src/styles.css`, `src/icons.ts`, `src/games/registry.ts`, other games). Put game CSS in `src/games/<id>/style.css` and import it from your `index.ts`; scope every selector under a class unique to your game (e.g. `.racer …`). If you truly need a shared change, describe it in your final report instead.
2. Your module's default export is `open(env)`. It shows your menu, runs play sessions, shows results and **resolves when the player chooses Back/Home**. Clean up everything (rAF loops, listeners, WebGL, audio) before resolving.
3. **Hand cursor:** every clickable thing gets `data-hc` so it can be pressed by pointing. Call `env.cursor(true)` on menus/results/pause and `env.cursor(false)` during play. Touch must also work.
4. **Pause:** use `HandsUpPause` (both hands above head for 1.3 s) + a visible pause button + `pauseMenu`. Pause must freeze the simulation and audio.
5. **Autoplay/demo:** when `env.params.get('autoplay') === '1'`, skip menus and start a session with sensible defaults (respect params like `mode`, `difficulty`, `track` if you add them). When `env.demo` is true, drive `env.pose` (a `SimPose`) with a **bot** that plays reasonably well, so the game can be tested headless. Expose live stats on `window.__gameDebug` (plain object, updated every frame or event) for tests.
6. **No camera required to test:** everything must run in demo mode with the bot.
7. **Do not git commit or push.** The lead integrates.
8. TypeScript strict, `noUnusedLocals`. `npx tsc --noEmit -p .` must pass for your files. Add unit tests for your pure logic in `tests/<id>.test.ts` (vitest).

## Quality bar

- Real 3D with good lighting (hemisphere + directional with soft shadows where it matters, environment map/HDRI), materials, fog/atmosphere, particles, camera motion. Stylized-but-polished is the target; avoid flat untextured primitives as final art.
- Juice: anticipation and impact (slow-mo moments, screen shake, flashes, particles, crowd/engine/impact sounds), clear feedback for every player action, satisfying results screen.
- Onboarding: the menu has a short "How to play" with the 2–4 key moves, and the first seconds of play teach the controls (prompts on screen).
- Readable from 3 m on a TV: big HUD text, high contrast.
- Difficulty or mode choices, best scores (`bests`), restart.
- **Performance:** target 60 fps on the S7+ at 1080p while MediaPipe also uses the GPU. Keep draw calls low (instancing / merged geometry), shadow map ≤ 2048, textures ≤ 2K and compressed sizes small. Total assets for your game ≤ 10 MB. Lazy-load your assets when your game opens.

## Designing for camera tracking

- Tracking runs ~20–30 Hz with ~80–120 ms latency and some jitter. Make timing windows forgiving (≥ 150 ms), judge actions by **capture time** (`frame.t`), smooth inputs, and never require pixel-precise positions.
- Depth is unreliable; prefer movements in the camera plane (left/right, up/down). Lean, duck, jump, raise hands, swing across the body all work well.
- Legs (knees/ankles) are only reliable when the full body is in view; offer a fallback (e.g. auto-run) when `!body.full`.
- Map hands **relative to the body** (body space), not to the camera image, so distance from the camera does not matter.
- Mirroring is already done: the player's right hand is on the right of the screen.

## Assets

- Allowed licenses: **CC0** (preferred: Kenney.nl, Quaternius, Poly Haven, ambientCG) or **CC-BY** with credit. No ripped/commercial assets, no logos or real team/brand names.
- Network access is available (curl). Store files in `public/assets/<id>/` and list every file's source + license in `public/assets/<id>/CREDITS.md`.
- Prefer glTF/GLB (`three/addons/loaders/GLTFLoader.js`). Optimise: strip unused meshes, keep textures small (JPG/WebP for colour, ≤ 1–2K).
- Load with `import.meta.env.BASE_URL + 'assets/<id>/…'`.

## Build and test (use your own output folder and port to avoid clashing with other builders)

```
npx tsc --noEmit -p .
npx vitest run tests/<id>.test.ts
npx vite build --outDir dist-<id>                          # do NOT use the default dist/
npx vite preview --outDir dist-<id> --port <port> --strictPort   # run in the background
node tools/shoot-game.mjs <id> <screenshot dir> --port <port> --shots 4,10,20 [--params "mode=x"] [--quality high]
```

`shoot-game.mjs` opens `?demo=play&game=<id>` (demo + autoplay), saves screenshots at the given seconds,
prints console errors and the final `window.__gameDebug`, and also captures your menu screen
(`?demo=1` → home → your tile is disabled until integration, so it opens the menu via `?demo=menu&game=<id>`).
Headless Chromium uses software WebGL (~3–8 fps), so judge visuals and logic, not speed; keep your game
logic frame-rate independent (use dt and timestamps).

Look at your screenshots critically and iterate until it looks like a finished console game.

## Final report

Reply with: what you built (modes, features), controls, how you tested (commands + screenshot paths),
asset list/licenses, known limitations, and any shared-code changes you need.
