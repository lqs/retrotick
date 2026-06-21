import { chromium } from 'playwright';
import fs from 'node:fs';
const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const calc = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const logs=[]; page.on('console',m=>logs.push(m.text()));
await page.addInitScript(() => localStorage.setItem('retrotick-general', JSON.stringify({ v86Backend: true })));
await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__runExe === 'function', { timeout: 15000 });
const b64 = calc.toString('base64');
await page.evaluate((b64) => { const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); window.__runExe(u.buffer,'calc.exe'); }, b64);
await page.waitForTimeout(5000);
// calc's EmulatorView renders many canvases (main + per-button companion). When it
// closes, the whole view unmounts → canvas count collapses. The Welcome window has none.
const canvases = () => page.evaluate(() => document.querySelectorAll('canvas').length);
const before = await canvases();
// Invoke the X-button onClose path ONCE (mainWindow!=0 → SC_CLOSE).
await page.evaluate(() => { const e=window.__emu; if (e?.mainWindow) e.postMessage(e.mainWindow, 0x0112, 0xF060, 0); });
await page.waitForTimeout(2000);
const after = await canvases();
const responsive = await Promise.race([page.evaluate(()=>1+1).then(()=>true), new Promise(r=>setTimeout(()=>r(false),2000))]);
console.log(`[close] canvases before=${before} after ONE X=${after} responsive=${responsive}`);
await browser.close();
const pass = before > 5 && after <= 2 && responsive; // calc's canvases gone after a single click
console.log(`\n[RESULT] single-X closes window: ${pass?'PASS':'FAIL'} (canvases ${before}→${after}, tab responsive=${responsive})`);
process.exit(pass?0:1);
