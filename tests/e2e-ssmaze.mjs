// ssmaze.scr on the ring3 kernel. Verifies the screensaver launches in /s RUN
// mode (command-line lazily resolved), the frame pump drives WM_PAINT so the
// saver reaches GL setup, and it creates+activates its OpenGL context.
// (Known gap: it exits before presenting the first frame — under investigation.)
import { chromium } from 'playwright'; import fs from 'node:fs';
const scr = fs.readFileSync(new URL('../examples/ssmaze.scr', import.meta.url));
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
let glCreated=false; page.on('console',m=>{ if(/Created GL1Context/.test(m.text())) glCreated=true; });
await page.addInitScript(() => localStorage.setItem('retrotick-general', JSON.stringify({ v86Backend: true })));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__runExe === 'function', { timeout: 15000 });
await page.evaluate((b64) => { const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); window.__runExe(u.buffer,'ssmaze.scr',undefined,'/s'); }, scr.toString('base64'));
await page.waitForTimeout(3000);
const cmd = await page.evaluate(()=>window.__emu?.commandLine).catch(()=>null);
console.log(`[ssmaze] commandLine="${cmd}" glContextCreated=${glCreated}`);
await browser.close();
const pass = cmd === '/s' && glCreated;
console.log(`\n[RESULT] ssmaze /s + GL setup: ${pass?'PASS':'FAIL'}`);
process.exit(pass?0:1);
