import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const p = await ctx.newPage();
await p.addInitScript(() => localStorage.setItem('ma.settings', JSON.stringify({ quality: 'low', showCamera: false })));
await p.goto(`http://localhost:4173/move-arcade/?demo=play&difficulty=${process.env.DIFF ?? 'normal'}`);
await new Promise((r) => setTimeout(r, Number(process.env.SECS ?? 45) * 1000));
console.log(JSON.stringify(await p.evaluate(() => window.__blade), null, 1));
await browser.close();
