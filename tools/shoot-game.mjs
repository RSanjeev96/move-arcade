// Headless test for one game in demo mode.
// Usage: node tools/shoot-game.mjs <gameId> <outDir> [--port 4173] [--shots 4,10,20] [--params "a=1&b=2"]
//        [--quality high|medium|low|auto] [--menu false] [--vw 1280 --vh 720] [--end 0]
// Requires `npx vite preview --outDir dist-<id> --port <port>` running.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [game, out = 'test-output', ...rest] = process.argv.slice(2);
const opt = { port: '4173', shots: '4,10,20', params: '', quality: '', menu: 'true', vw: '1280', vh: '720', end: '0' };
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
if (!game) {
  console.error('usage: node tools/shoot-game.mjs <gameId> <outDir> [options]');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const base = `http://localhost:${opt.port}/move-arcade/`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
async function page() {
  const ctx = await browser.newContext({ viewport: { width: Number(opt.vw), height: Number(opt.vh) }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  if (opt.quality) await p.addInitScript((q) => localStorage.setItem('ma.settings', JSON.stringify({ quality: q })), opt.quality);
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.stack ?? e}`));
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const extra = opt.params ? `&${opt.params}` : '';

if (opt.menu !== 'false') {
  const p = await page();
  await p.goto(`${base}?demo=menu&game=${game}${extra}`);
  await wait(2500);
  await p.screenshot({ path: `${out}/00-menu.png` });
  await p.close();
}

const p = await page();
const t0 = Date.now();
await p.goto(`${base}?demo=play&game=${game}${extra}`);
const shots = opt.shots.split(',').filter(Boolean).map(Number);
for (const s of shots) {
  await wait(Math.max(0, s * 1000 - (Date.now() - t0)));
  await p.screenshot({ path: `${out}/play-${String(s).padStart(3, '0')}s.png` });
}
if (Number(opt.end) > 0) {
  await wait(Math.max(0, Number(opt.end) * 1000 - (Date.now() - t0)));
  await p.screenshot({ path: `${out}/end.png` });
}
const dbg = await p.evaluate(() => window.__gameDebug ?? null).catch(() => null);
console.log('__gameDebug:', JSON.stringify(dbg));
await browser.close();
console.log('errors:', errors.length ? errors.slice(0, 20).join('\n') : 'none');
