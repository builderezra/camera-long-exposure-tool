/**
 * Does the light-trail maths actually do `max`?
 *
 * This drives the real probe page in a real browser, with the one substitution
 * the brief asks for: acquireStream() is replaced by canvas.captureStream(), so
 * the track, the frames and requestVideoFrameCallback are all the browser's own
 * and only the permission prompt is avoided.
 *
 * The input is a white dot sweeping across black. Under `out = max(out, frame)`
 * every pixel the dot ever touched ends at full brightness and stays there —
 * the pixel it touched first is exactly as bright as the one it touched last.
 * Under an average, a pixel lit for one frame in ~120 would come out at about
 * 2/255. That difference is the whole assertion.
 *
 *   node --run test        (or: node test/light-trail.test.mjs)
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = join(root, req.url === '/' ? '/camera-probe.html' : req.url.split('?')[0]);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const fail = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '[32m✓[0m' : '[31m✗[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(name);
};

await new Promise((r) => server.listen(8099, r));

// Use whatever Chromium is on the box; only fall back to hunting for one.
async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    const { globSync } = await import('node:fs');
    const found = globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome')[0];
    if (!found) throw err;
    return chromium.launch({ executablePath: found });
  }
}
const browser = await launch();

try {
  const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('    [page error]', m.text()); });
  page.on('pageerror', (e) => console.log('    [page exception]', e.message));

  // localhost counts as a secure context, so getUserMedia rules are the real ones.
  await page.goto('http://localhost:8099/camera-probe.html');

  // The one substitution: a synthetic camera. A white dot crosses the frame once,
  // left to right, slowly — 640px over 12s is ~1.8px per frame against a 20px
  // dot, so consecutive frames overlap solidly and the trail has no beading.
  //
  // One pass, never repeated, matters: whatever 4-second window the capture
  // lands on, the pixels at its left edge were lit early and those at its right
  // edge were lit late. That is what makes the brightness comparison below a
  // test of max-over-time rather than of coverage.
  await page.evaluate(() => {
    const src = document.createElement('canvas');
    src.width = 640; src.height = 480;
    const ctx = src.getContext('2d');
    const R = 10, Y = 240, SWEEP = 12000;
    window.__dotY = Y; window.__dotR = R; window.__srcW = 640;

    let t0 = null;
    const draw = (t) => {
      if (t0 === null) t0 = t;
      const phase = Math.min(1, (t - t0) / SWEEP);     // one pass, then it parks
      const x = R + phase * (src.width - 2 * R);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, Y, R, 0, Math.PI * 2); ctx.fill();
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);

    const stream = src.captureStream(30);
    window.acquireStream = async () => stream;         // classic script → real global
  });

  await page.click('#start');
  await page.waitForSelector('#afterShot:not(.hidden)', { timeout: 40000 });

  const r = await page.evaluate(() => {
    const plate = document.getElementById('plate');
    const ctx = plate.getContext('2d');
    const { width: w, height: h } = plate;
    const Y = window.__dotY, R = window.__dotR;
    const scaleY = h / 480, scaleX = w / window.__srcW;

    const lum = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
    const LIT = 200;

    // The row the dot swept: find the trail's extent, then look for holes in it.
    const row = ctx.getImageData(0, Math.round(Y * scaleY), w, 1).data;
    let firstLitX = null, lastLitX = null;
    for (let x = 0; x < w; x++) {
      if (lum(row, x * 4) > LIT) { lastLitX = x; if (firstLitX === null) firstLitX = x; }
    }

    // Inside the trail, every pixel should be lit — a hole is a frame we dropped.
    let gaps = 0, litMin = 255, litMax = 0;
    for (let x = firstLitX; x <= lastLitX; x++) {
      const v = lum(row, x * 4);
      if (v <= LIT) gaps++;
      else { litMin = Math.min(litMin, v); litMax = Math.max(litMax, v); }
    }
    const litCount = (lastLitX - firstLitX + 1) - gaps;

    // A row the dot never touched, well clear of it.
    const clean = ctx.getImageData(0, Math.round(Y * scaleY) + Math.round(60 * scaleY), w, 1).data;
    let cleanMax = 0;
    for (let x = 0; x < w; x++) cleanMax = Math.max(cleanMax, lum(clean, x * 4));

    const text = (id) => document.getElementById(id).textContent;
    const rows = [...document.querySelectorAll('#report .row')]
      .map((el) => [el.querySelector('.k').textContent, el.querySelector('.v').textContent]);

    // Compare the two ends of the trail a little way in from the tips, where the
    // dot only ever half-overlapped.
    const inset = Math.round(R * scaleX);
    return {
      w, h, litCount, litMin, litMax, firstLitX, lastLitX, cleanMax, gaps,
      span: lastLitX - firstLitX + 1,
      earlyLum: lum(row, (firstLitX + inset) * 4),
      lateLum:  lum(row, (lastLitX  - inset) * 4),
      status: text('status'),
      rows
    };
  });

  console.log(`\n  plate ${r.w}×${r.h}`);
  for (const [k, v] of r.rows) console.log(`    ${k}: ${v}`);
  console.log('');

  check('the sweep leaves a trail',
        r.span > r.w * 0.2, `${r.span}px of ${r.w} swept during the exposure`);

  check('the trail is continuous, with no dropped-frame gaps',
        r.gaps === 0, `${r.gaps} dark pixels inside the trail`);

  check('the trail is at full brightness, not averaged down',
        r.litMin > 240, `dimmest pixel ${r.litMin.toFixed(1)}/255 — an average of ~120 frames would be ~2`);

  check('the pixel lit first is as bright as the pixel lit last',
        Math.abs(r.earlyLum - r.lateLum) < 8,
        `${r.earlyLum.toFixed(1)} vs ${r.lateLum.toFixed(1)} — this is what proves max, not mean`);

  check('the trail is uniform end to end',
        r.litMax - r.litMin < 12, `spread ${(r.litMax - r.litMin).toFixed(1)}`);

  check('untouched rows stay black',
        r.cleanMax < 12, `brightest untouched pixel ${r.cleanMax.toFixed(1)}`);

  const kept = r.rows.find(([k]) => k.startsWith('Frames kept'));
  check('the probe measured a keep-rate', !!kept && /%/.test(kept[1]), kept ? kept[1] : 'not reported');

  const accum = r.rows.find(([k]) => k === 'Frames accumulated');
  check('it accumulated a plausible number of frames',
        !!accum && Number(accum[1]) > 60, accum ? `${accum[1]} frames in ~4s` : 'not reported');

} finally {
  await browser.close();
  server.close();
}

console.log('');
if (fail.length) { console.log(`[31m${fail.length} failed[0m`); process.exit(1); }
console.log('[32mAll assertions passed.[0m');
