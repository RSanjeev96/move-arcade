// Headless smoke test + screenshots. Usage: node tools/shoot.mjs <outDir> [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'test-output';
const base = process.argv[3] ?? 'http://localhost:4173/move-arcade/';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const errors = [];
async function page(w = 1280, h = 720) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  if (process.env.QUALITY) {
    await p.addInitScript((q) => localStorage.setItem('ma.settings', JSON.stringify({ quality: q })), process.env.QUALITY);
  }
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Start screen
let p = await page();
await p.goto(base);
await wait(1200);
await p.screenshot({ path: `${out}/01-start.png` });

// 2. Demo: home, song select
await p.click('#demo');
await wait(1500);
await p.screenshot({ path: `${out}/02-home.png` });
await p.click('[data-go=blade]');
await wait(1500);
await p.screenshot({ path: `${out}/03-songs.png` });
await p.close();

// 3. Autoplay gameplay
const mode = process.env.DIFF ?? 'normal';
p = await page();
await p.goto(`${base}?demo=play&difficulty=${mode}`);
const shots = (process.env.SHOTS ?? '6,14,22,30').split(',').map(Number);
let t0 = Date.now();
for (const [i, s] of shots.entries()) {
  await wait(Math.max(0, s * 1000 - (Date.now() - t0)));
  await p.screenshot({ path: `${out}/1${i}-play-${s}s.png` });
}
const fps = await p.evaluate(() => new Promise((r) => {
  let n = 0;
  const t = performance.now();
  const f = () => (++n < 60 ? requestAnimationFrame(f) : r((60000 / (performance.now() - t)).toFixed(1)));
  requestAnimationFrame(f);
}));
console.log('headless fps (software GL):', fps);
await p.close();

// 4. Results via seek near the end
p = await page();
await p.goto(`${base}?demo=play&difficulty=${mode}&seek=${process.env.SEEK ?? 118}`);
await p.waitForSelector('.results', { timeout: 60000 }).catch(() => {});
await wait(800);
await p.screenshot({ path: `${out}/20-results.png` });
const result = await p.evaluate(() => window.__lastResult);
console.log('result:', JSON.stringify(result));
await p.close();

await browser.close();
console.log('errors:', errors.length ? errors.slice(0, 15).join('\n') : 'none');
