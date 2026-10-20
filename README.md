# Move Arcade

Motion games for an Android tablet and a TV. The tablet's front camera tracks your whole body — no controllers.

**Play:** https://rsanjeev96.github.io/move-arcade/ (open in Chrome on the tablet)

## Games

| Game | Status |
|---|---|
| **Blade Beat** — slice blocks to the music with two light blades, dodge walls, avoid bombs | Playable |
| Grand Prix (F1 steering → MotoGP lean) | Next |
| Goalkeeper, Big Hitter (cricket/baseball), Centre Court (tennis) | Planned |
| Dance Fit (workouts + weekly plan), Sky Quest (first-person adventure) | Planned |

## Setup

1. Prop the tablet in landscape **below the TV**, front camera facing the room.
2. Connect it to the TV with a USB-C to HDMI cable and choose *Screen mirroring* (or use Smart View wirelessly).
3. Open the link in Chrome → ⋮ → *Add to Home screen* so it opens full screen.
4. Stand 2–3 m back with light in front of you. Tap **Start** and allow the camera.
5. Point with a raised hand; hold still on a button for a second to press it. Raise both hands to pause a song.

Your camera image is processed on the tablet and never uploaded. Songs you add from the tablet stay on the tablet.

## Develop

```
npm install
npm run dev        # local server
npm test           # unit tests (beat detection, map generator, cut judging)
npm run build
node tools/shoot.mjs out   # headless demo playthrough + screenshots (needs `npm run preview` running)
```

Add `?demo=play` to the URL to watch a bot play without a camera.

Built-in music: original tracks rendered by `tools/make_music.py` (CC0).
Body tracking: MediaPipe Pose Landmarker. 3D: three.js.
