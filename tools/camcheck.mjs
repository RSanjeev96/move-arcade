import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream', ...(process.env.Y4M ? [`--use-file-for-fake-video-capture=${process.env.Y4M}`] : [])] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
const p = await ctx.newPage();
const logs = [];
p.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
p.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
await p.goto('http://localhost:4173/move-arcade/');
await p.click('#go');
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await p.$('.calib')) break;
}
await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 4000)));
await p.screenshot({ path: process.argv[2] ?? 'calib.png' });
console.log('calibration screen:', !!(await p.$('.calib')), 'status:', await p.evaluate(() => document.querySelector('.status')?.textContent ?? ''));
console.log(logs.filter((l) => !l.startsWith('debug')).slice(0, 12).join('\n'));
await browser.close();
