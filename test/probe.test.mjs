/**
 * Phase 0 — the device probe.
 *
 * Checks the probe runs end to end against a real (synthetic) stream and that
 * the exposure it shoots does `max`, not `mean`. The device-specific numbers it
 * reports are the point of the page and can only be judged on a phone; what is
 * testable here is that it reports them at all and that the maths is right.
 *
 *   node test/probe.test.mjs
 */

import { serve, launch, synthCamera, measureTrail, reporter } from './harness.mjs';

const PORT = 8099;
const r = reporter();
const server = await serve(PORT);
const browser = await launch();

try {
  const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
  page.on('pageerror', (e) => console.log('    [page exception]', e.message));

  // localhost counts as a secure context, so the getUserMedia rules are real.
  await page.goto(`http://localhost:${PORT}/camera-probe.html`);
  await page.evaluate(synthCamera, {});
  await page.click('#start');
  await page.waitForSelector('#afterShot:not(.hidden)', { timeout: 40000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('shot');
    return !el.classList.contains('hidden') && el.complete && el.naturalWidth > 0;
  });

  const rows = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('#report .row')]
      .map((el) => [el.querySelector('.k').textContent, el.querySelector('.v').textContent])));

  r.group('What the probe reports');
  for (const [k, v] of Object.entries(rows)) console.log(`    ${k}: ${v}`);

  r.group('The report is complete');
  const has = (k) => Object.keys(rows).some((name) => name.startsWith(k));
  r.check('it reports whether exposure can be locked', has('Can we lock exposure?'), rows['Can we lock exposure?']);
  r.check('it reports the resolution actually granted', has('Resolution we got'), rows['Resolution we got']);
  r.check('it reports unique frames per second', has('Unique frames/sec'), rows['Unique frames/sec']);
  r.check('it tests a real RGBA16F render target', has('RGBA16F render target'), rows['RGBA16F render target']);
  const keptKey = Object.keys(rows).find((k) => k.startsWith('Frames kept'));
  r.check('it reports a keep-rate from the real capture', !!keptKey && /%/.test(rows[keptKey]),
          keptKey ? rows[keptKey] : 'missing');

  r.group('The exposure it shoots');
  const t = await page.evaluate(measureTrail, '#shot');
  r.check('the dot leaves a trail', t.span > t.w * 0.2, `${t.span}px of ${t.w} swept`);
  r.check('the trail is continuous', t.gaps === 0, `${t.gaps} dark pixels inside it`);
  r.check('the trail is at full brightness, not averaged down',
          t.litMin > 240, `dimmest ${t.litMin.toFixed(1)}/255 — a mean of ~120 frames would be ~2`);
  r.check('the pixel lit first is as bright as the pixel lit last',
          Math.abs(t.earlyLum - t.lateLum) < 8,
          `${t.earlyLum.toFixed(1)} vs ${t.lateLum.toFixed(1)} — this is what proves max, not mean`);

  const live = await page.evaluate(() => {
    const v = document.getElementById('video');
    return v.srcObject ? v.srcObject.getTracks().filter((t) => t.readyState === 'live').length : 0;
  });
  r.check('the camera is released when the probe finishes', live === 0, `${live} live tracks`);

} finally {
  await browser.close();
  server.close();
}

r.done();
