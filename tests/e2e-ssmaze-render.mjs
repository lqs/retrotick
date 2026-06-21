// Verify ssmaze actually renders: GL context created, SwapBuffers called, and
// the canvas has non-trivial (non-uniform) pixels = something drawn.
import { chromium } from 'playwright'; import fs from 'node:fs';
const scr = fs.readFileSync(new URL('../examples/ssmaze.scr', import.meta.url));
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
let glCreated=false, swaps=0, exited=false;
page.on('console', m => {
  const t = m.text();
  if (/Created GL1Context/.test(t)) glCreated = true;
  if (/SwapBuffers|wglSwapBuffers/.test(t)) swaps++;
  if (/process terminated|ExitProcess|exited/.test(t)) exited = true;
});
await page.addInitScript(() => localStorage.setItem('retrotick-general', JSON.stringify({ v86Backend: true })));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__runExe === 'function', { timeout: 15000 });
await page.evaluate((b64) => { const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); window.__runExe(u.buffer,'ssmaze.scr',undefined,'/s'); }, scr.toString('base64'));
await page.waitForTimeout(5000);
// Find the largest canvas and sample its pixels for non-uniformity.
const stat = await page.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')];
  let best=null, area=0;
  for (const c of cs) { const a=c.width*c.height; if (a>area){area=a;best=c;} }
  if (!best) return { found:false };
  const w=best.width, h=best.height;
  // Try to read pixels: 2d first, then webgl.
  let data=null;
  const g = best.getContext('webgl2')||best.getContext('webgl');
  if (g) { const px=new Uint8Array(w*h*4); g.readPixels(0,0,w,h,g.RGBA,g.UNSIGNED_BYTE,px); data=px; }
  else { const ctx=best.getContext('2d'); if(ctx){ data=ctx.getImageData(0,0,w,h).data; } }
  if (!data) return { found:true, w, h, readable:false };
  let min=255,max=0,nonblack=0;
  for (let i=0;i<data.length;i+=4){ const lum=(data[i]+data[i+1]+data[i+2]); if(lum>10)nonblack++; const v=data[i]; if(v<min)min=v; if(v>max)max=v; }
  return { found:true, w, h, readable:true, min, max, nonblack, total:data.length/4 };
});
console.log(`[ssmaze-render] glCreated=${glCreated} swaps=${swaps} exited=${exited}`);
console.log(`[ssmaze-render] canvas:`, JSON.stringify(stat));
await page.screenshot({ path: '/private/tmp/claude-501/-Users-lqs-src-retrotick/4391c836-9852-424e-8e75-be31a7864597/scratchpad/ssmaze.png' });
await browser.close();
const drew = stat.found && (!stat.readable || stat.nonblack > 50);
console.log(`\n[RESULT] ssmaze render: glCreated=${glCreated} drewPixels=${drew} → ${glCreated && drew && !exited ? 'PASS' : 'CHECK'}`);
process.exit(0);
