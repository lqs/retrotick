import { chromium } from 'playwright';
import fs from 'node:fs';
const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const L = n => fs.readFileSync(new URL('../examples/'+n, import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const logs=[]; page.on('console',m=>logs.push(m.text())); page.on('pageerror',e=>logs.push('PAGEERR '+e.message));
await page.addInitScript(() => localStorage.setItem('retrotick-general', JSON.stringify({ v86Backend: true })));
await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__runExe === 'function', { timeout: 15000 });
const b64 = (b)=>b.toString('base64');
await page.evaluate(({fc,cards}) => {
  const dec = s => { const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return u.buffer; };
  window.__runExe(dec(fc), 'freecell.exe', { 'cards.dll': dec(cards) });
}, { fc: b64(L('freecell.exe')), cards: b64(L('cards.dll')) });
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/e2e/freecell-initial.png' });
// New game (F2), then attempt several moves by clicking cascade columns to provoke an illegal move.
const click = async (x,y) => { await page.evaluate(({x,y})=>{const e=window.__emu; const lp=((y&0xFFFF)<<16)|(x&0xFFFF); e.postMessage(e.mainWindow,0x0201,1,lp); e.postMessage(e.mainWindow,0x0202,0,lp);},{x,y}); await page.waitForTimeout(200); };
await page.evaluate(()=>{const e=window.__emu; e.postMessage(e.mainWindow,0x0100,0x71,0); e.postMessage(e.mainWindow,0x0101,0x71,0);}); // F2
await page.waitForTimeout(600);
// click around the board to trigger moves / illegal move
for (const [x,y] of [[60,180],[140,180],[60,260],[220,180],[300,180]]) await click(x,y);
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/e2e/freecell-after.png' });
const exh = logs.filter(l=>/exhausted/.test(l)).length;
const av = logs.filter(l=>/kernel-AV/.test(l)).length;
const mbox = logs.filter(l=>/MessageBox/.test(l)).length;
const alive = await page.evaluate(()=>{const e=window.__emu; return !!e && !e.halted && (e.mainWindow>>>0)!==0;});
console.log(`[freecell] msgboxes=${mbox} exhausted=${exh} av=${av} alive=${alive}`);
console.log('[freecell] last:', logs.slice(-5).join(' | '));
await browser.close();
const pass = exh===0 && av===0 && alive;
console.log(`\n[RESULT] freecell (v86 kernel): ${pass?'PASS':'FAIL'} (no exhaustion/AV after moves, app alive)`);
process.exit(pass?0:1);
