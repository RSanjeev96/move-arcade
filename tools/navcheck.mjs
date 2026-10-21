// Headless check of hand-cursor menu navigation in demo mode: magnetic press, swipe-back, no false back.
// Usage: node tools/navcheck.mjs [outDir]   (needs `npx vite preview --port 4173` running)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'test-output/nav';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) fails++;
};

// Screen fraction -> right-wrist body coordinates (the inverse of the cursor mapping).
const rest = () => p.evaluate(() => (window.__sim.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } })));
const point = (fx, fy) =>
  p.evaluate(([fx, fy]) => (window.__sim.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: -0.6 + fx * 2.4, y: 1.2 - fy * 2.3 } })), [fx, fy]);
const move = (from, to, ms) =>
  p.evaluate(
    ([from, to, ms]) => {
      const t0 = performance.now();
      window.__sim.drive = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        const fx = from[0] + (to[0] - from[0]) * k;
        const fy = from[1] + (to[1] - from[1]) * k;
        return { lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: -0.6 + fx * 2.4, y: 1.2 - fy * 2.3 } };
      };
    },
    [from, to, ms],
  );
const frac = (sel, dx = 0, dy = 0) =>
  p.evaluate(
    ([sel, dx, dy]) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return [((r.left + r.right) / 2 + dx) / innerWidth, ((r.top + r.bottom) / 2 + dy) / innerHeight];
    },
    [sel, dx, dy],
  );
const has = (sel) => p.evaluate((sel) => !!document.querySelector(sel), sel);

await p.goto('http://localhost:4173/move-arcade/?demo=1');
await wait(2500);
check('home shown', await has('.screen.home'));

// 1. Point a little beside the Settings button: it should snap and press within ~1.5 s.
await point(...(await frac('[data-go="settings"]', 0, 45)));
await wait(500);
check('snaps onto Settings from 45px away', await p.evaluate(() => document.querySelector('.hc-hover')?.dataset.go === 'settings'));
await p.screenshot({ path: `${out}/1-snap.png` });
await wait(1200);
check('Settings opened by hovering', await has('.screen.settings'));

// 2. Hold on "Low" graphics.
await point(...(await frac('[data-seg="quality"][data-val="low"]', 0, 25)));
await wait(2600);
check('Low quality selected', await p.evaluate(() => document.querySelector('[data-seg="quality"][data-val="low"]').classList.contains('on')));

// 3. A slow reach to the left edge must not go back.
await move([0.7, 0.55], [0.0, 0.55], 1400);
await wait(1700);
check('slow move left does not go back', await has('.screen.settings'));

// 4. A quick flick off the left edge goes back.
await point(0.8, 0.5);
await wait(700);
await move([0.8, 0.5], [-0.25, 0.52], 300);
await wait(450);
await p.screenshot({ path: `${out}/2-swipe.png` });
await wait(2500);
check('swipe left goes back to home and holding at the edge presses nothing', await has('.screen.home'));
await rest();
await wait(400);

// 5. Into a game menu and back out with a swipe.
await point(...(await frac('[data-go="tennis"]')));
await wait(2200);
await rest();
await wait(1500);
check('tennis menu opened', await p.evaluate(() => !!document.querySelector('.game-host [data-act="back"]')));
await p.screenshot({ path: `${out}/3-game-menu.png` });
await point(0.8, 0.5);
await wait(700);
await move([0.8, 0.5], [-0.25, 0.5], 300);
await wait(1500);
await rest();
check('swipe left leaves the game menu', await has('.screen.home'));

check('no page errors', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
process.exit(fails ? 1 : 0);
