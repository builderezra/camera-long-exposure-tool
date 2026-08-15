/**
 * Shared plumbing for the tests: a static server, a browser, and a synthetic
 * camera.
 *
 * The synthetic camera is the substitution the whole test strategy rests on.
 * Camera acquisition is one function returning a MediaStream, so swapping it
 * for canvas.captureStream() leaves a real stream with a real track — every
 * step downstream is the browser's own, and only the permission prompt is
 * avoided.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css'
};

export function serve(port) {
  const server = createServer(async (req, res) => {
    const path = join(root, req.url === '/' ? '/index.html' : req.url.split('?')[0]);
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

export async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    const found = globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome')[0];
    if (!found) throw err;
    return chromium.launch({ executablePath: found });
  }
}

/**
 * A white dot crossing black, once, slowly.
 *
 * Slowly matters: 640px over `sweepMs` at 30fps has to move less than the dot's
 * own diameter per frame, or consecutive frames don't overlap and the trail
 * comes out beaded — the real gap-between-frames artefact, but here it would
 * just be a bad fixture.
 *
 * Once matters too: whatever window the exposure lands on, the pixels at its
 * left edge were lit early and those at its right were lit late, which is what
 * makes "as bright at the end as at the start" a test of max over time.
 */
export const synthCamera = ({ sweepMs = 12000, radius = 10, w = 640, h = 480 } = {}) => {
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const ctx = src.getContext('2d');
  const Y = Math.round(h / 2);
  window.__synth = { w, h, Y, radius };

  let t0 = null;
  const draw = (t) => {
    if (t0 === null) t0 = t;
    const phase = Math.min(1, (t - t0) / sweepMs);
    const x = radius + phase * (w - 2 * radius);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, Y, radius, 0, Math.PI * 2);
    ctx.fill();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const stream = src.captureStream(30);
  if (window.__setStreamSource) window.__setStreamSource(async () => stream);
  else window.acquireStream = async () => stream;   // the probe page, a classic script
};

/** Read the trail out of an image that is already on the page. */
export const measureTrail = (selector) => {
  const el = document.querySelector(selector);
  const w = el.naturalWidth || el.width;
  const h = el.naturalHeight || el.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(el, 0, 0);

  const { Y, radius, h: srcH, w: srcW } = window.__synth;
  const scaleX = w / srcW;
  const row = ctx.getImageData(0, Math.round((Y / srcH) * h), w, 1).data;
  const lum = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
  const LIT = 200;

  let firstLitX = null, lastLitX = null;
  for (let x = 0; x < w; x++) {
    if (lum(row, x * 4) > LIT) { lastLitX = x; if (firstLitX === null) firstLitX = x; }
  }
  if (firstLitX === null) return { w, h, span: 0, gaps: 0, litMin: 0, litMax: 0, mean: 0 };

  // Judge brightness over the trail's core, not its tips. The dot's own edge is
  // antialiased, so the last pixel or two at each end ramps down through the
  // threshold — that is the shape of a round dot, not a flaw in the exposure.
  const inset = Math.round(radius * scaleX);
  const coreFrom = firstLitX + inset;
  const coreTo = lastLitX - inset;

  let gaps = 0, litMin = 255, litMax = 0;
  for (let x = coreFrom; x <= coreTo; x++) {
    const v = lum(row, x * 4);
    if (v <= LIT) gaps++;
    else { litMin = Math.min(litMin, v); litMax = Math.max(litMax, v); }
  }

  // Whole-plate mean, to catch a plate that came out mostly black.
  const all = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 0; i < all.length; i += 4) sum += lum(all, i);
  const mean = sum / (all.length / 4);

  return {
    w, h, gaps, litMin, litMax, mean,
    span: lastLitX - firstLitX + 1,
    earlyLum: lum(row, coreFrom * 4),
    lateLum: lum(row, coreTo * 4)
  };
};

export function reporter() {
  const failed = [];
  return {
    check(name, ok, detail) {
      console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failed.push(name);
    },
    group(name) { console.log(`\n\x1b[1m${name}\x1b[0m`); },
    done() {
      console.log('');
      if (failed.length) { console.log(`\x1b[31m${failed.length} failed\x1b[0m`); process.exit(1); }
      console.log('\x1b[32mAll assertions passed.\x1b[0m');
    }
  };
}
