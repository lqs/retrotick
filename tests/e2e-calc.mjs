// Playwright E2E: verify calc.exe under the v86 kernel backend in a real browser.
// Renders digit buttons, and clicking a number does not crash (no kernel-AV).
import { chromium } from 'playwright';
import fs from 'node:fs';

const APP_URL = process.env.APP_URL || 'http://localhost:5174/';
const calc = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

const consoleLines = [];
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

// Enable the v86 kernel backend before the app boots.
await page.addInitScript(() => {
    localStorage.setItem('retrotick-general', JSON.stringify({ v86Backend: true }));
    window.__cbdbg = 0;
});

await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__runExe === 'function', { timeout: 15000 });

// Launch calc.exe via the dev hook.
const calcB64 = calc.toString('base64');
await page.evaluate((b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    window.__runExe(buf.buffer, 'calc.exe');
}, calcB64);

// Give the kernel time to boot + reach the message loop + render the dialog.
await page.waitForTimeout(6000);

fs.mkdirSync('/tmp/e2e', { recursive: true });
await page.screenshot({ path: '/tmp/e2e/calc-initial.png' });

// Inspect: did the calc window + buttons render? Count overlay buttons + look for digit text.
const ui = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [class*="control"], [class*="overlay"]')];
    const texts = btns.map(b => (b.textContent || '').trim()).filter(Boolean);
    const canvases = document.querySelectorAll('canvas').length;
    return { buttonCount: btns.length, sampleTexts: texts.slice(0, 40), canvases };
});
console.log('[e2e] UI:', JSON.stringify(ui));

// Click digit "7" then "+" then "3" then "=" by DOM button coordinates and read
// the display. The owner-draw digit glyphs aren't DOM text, but the BS_OWNERDRAW
// buttons ARE positioned DOM elements — locate the one at digit 7's grid cell.
const before = consoleLines.filter(l => /kernel-AV/.test(l)).length;
const readDisplay = () => page.evaluate(() => {
    const emu = window.__emu; const m = emu?.handles.get(emu.mainWindow);
    const c = m?.children?.get?.(403); const w = c ? emu.handles.get(c) : null;
    return (w?.title ?? '').trim();
});
// Click via the guest by posting WM_COMMAND through the emulator (button IDs:
// 7→131, +→92, 3→127, =→112) — exercises the real wndproc dispatch path.
const click = async (id) => { await page.evaluate((id) => { const e = window.__emu; e.postMessage(e.mainWindow, 0x0111, id, 0); }, id); await page.waitForTimeout(250); };
await click(131); await click(92); await click(127); await click(112);
await page.waitForTimeout(400);
const display = await readDisplay();
await page.screenshot({ path: '/tmp/e2e/calc-after-click.png' });
const clicked = display.replace(/\.$/, '') === '10';

const avAfter = consoleLines.filter(l => /kernel-AV/.test(l)).length;
const exhausted = consoleLines.filter(l => /exhausted/.test(l)).length;
const terminated = consoleLines.filter(l => /terminating/.test(l)).length;

console.log('[e2e] 7+3= display:', JSON.stringify(display), 'correct:', clicked);
console.log('[e2e] kernel-AV count:', avAfter, ' exhausted:', exhausted, ' terminating:', terminated);
console.log('[e2e] last console lines:');
for (const l of consoleLines.slice(-25)) console.log('   ' + l);

await browser.close();

const pass = avAfter === 0 && exhausted === 0 && terminated === 0 && ui.canvases > 0 && clicked;
console.log(`\n[RESULT] calc e2e (v86 kernel): ${pass ? 'PASS' : 'FAIL'} (AV=${avAfter}, exhausted=${exhausted}, terminated=${terminated}, 7+3=${JSON.stringify(display)})`);
process.exit(pass ? 0 : 1);
