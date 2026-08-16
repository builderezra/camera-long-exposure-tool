/**
 * Phase 1 — Light Trail, tested through the real app.
 *
 *   node test/app.test.mjs
 */

import { serve, launch, synthCamera, measureTrail, reporter } from './harness.mjs';

const PORT = 8097;
const r = reporter();
const server = await serve(PORT);
const browser = await launch();

/** Open the app with a synthetic camera already wired in, ready to shoot. */
async function openApp(durationSeconds, query = '') {
  const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
  page.on('pageerror', (e) => console.log('    [page exception]', e.message));
  await page.goto(`http://localhost:${PORT}/index.html${query}`);
  await page.evaluate(synthCamera, {});
  await page.click('#begin');
  await page.waitForSelector('#shoot:not([hidden])');
  await page.evaluate((s) => {
    const d = document.getElementById('duration');
    d.value = String(s);
    d.dispatchEvent(new Event('input'));
  }, durationSeconds);
  return page;
}

try {
  /* --- the exposure it is supposed to make -------------------------------- */
  r.group('A four-second Light Trail exposure');
  {
    const page = await openApp(4);
    await page.click('#shutter');
    await page.waitForSelector('#review:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('result');
      return !el.hidden && el.complete && el.naturalWidth > 0;
    });

    const t = await page.evaluate(measureTrail, '#result');
    const shot = await page.evaluate(() => window.__lastShot);
    const note = await page.textContent('#reviewNote');

    r.check('the live build-up became the saved plate', t.w > 0, `${t.w}×${t.h}`);
    r.check('the dot leaves a trail', t.span > t.w * 0.2, `${t.span}px of ${t.w} swept`);
    r.check('the trail is continuous', t.gaps === 0, `${t.gaps} dark pixels inside it`);
    r.check('the trail is at full brightness, not averaged down',
            t.litMin > 240, `dimmest ${t.litMin.toFixed(1)}/255 — a mean of ~120 frames would be ~2`);
    r.check('the pixel lit first is as bright as the pixel lit last',
            Math.abs(t.earlyLum - t.lateLum) < 8,
            `${t.earlyLum.toFixed(1)} vs ${t.lateLum.toFixed(1)} — this is what proves max, not mean`);
    r.check('it ran for about the duration asked for',
            Math.abs(shot.seconds - 4) < 0.6, `${shot.seconds.toFixed(2)}s`);
    r.check('it accumulated roughly 30 frames a second',
            shot.frames > 90 && shot.frames < 150, `${shot.frames} frames`);
    r.check('the review screen reports what was shot', /frames/.test(note), note.trim());

    // The camera must not be left running once the shot is done.
    const live = await page.evaluate(() => {
      const v = document.getElementById('video');
      return v.srcObject ? v.srcObject.getTracks().filter((t) => t.readyState === 'live').length : 0;
    });
    r.check('the camera is released once the exposure ends', live === 0, `${live} live tracks`);
    r.check('it measured the blend and found a working route',
            shot.path === 'direct' || shot.path === 'copy', `path: ${shot.path}`);
    await page.close();
  }

  /* --- the fallback route -------------------------------------------------
     A blend mode that is quietly ignored turns every frame into an overwrite,
     and the exposure comes out as a snapshot of the last thing seen. The
     accumulator measures rather than trusts, and falls back to blending via an
     intermediate canvas. That fallback has to produce the same exposure, so it
     is tested as a first-class route rather than assumed to work. */
  r.group('The via-copy fallback route');
  {
    const page = await openApp(4, '?blend=copy');
    await page.click('#shutter');
    await page.waitForSelector('#review:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('result');
      return !el.hidden && el.complete && el.naturalWidth > 0;
    });

    const t = await page.evaluate(measureTrail, '#result');
    const shot = await page.evaluate(() => window.__lastShot);

    r.check('the forced route is the one that ran', shot.path === 'copy', `path: ${shot.path}`);
    r.check('it still takes the max, not the last frame',
            t.span > t.w * 0.2 && t.gaps === 0, `${t.span}px of continuous trail`);
    r.check('the trail is at full brightness',
            t.litMin > 240, `dimmest ${t.litMin.toFixed(1)}/255`);
    r.check('the pixel lit first is as bright as the pixel lit last',
            Math.abs(t.earlyLum - t.lateLum) < 8,
            `${t.earlyLum.toFixed(1)} vs ${t.lateLum.toFixed(1)}`);
    r.check('it keeps up despite the extra draw per frame',
            shot.frames > 90, `${shot.frames} frames in ${shot.seconds.toFixed(1)}s`);
    await page.close();
  }

  /* --- tapping again mid-shot -------------------------------------------- */
  r.group('Stopping early');
  {
    const page = await openApp(60);
    await page.click('#shutter');
    await page.waitForFunction(() => (window.__lastShot, document.getElementById('readout').textContent.startsWith('2.')), { timeout: 20000 });
    await page.click('#shutter');
    await page.waitForSelector('#review:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('result');
      return !el.hidden && el.complete && el.naturalWidth > 0;
    });

    const shot = await page.evaluate(() => window.__lastShot);
    const t = await page.evaluate(measureTrail, '#result');

    r.check('it stops well short of the 60s asked for',
            shot.seconds > 1.5 && shot.seconds < 6, `${shot.seconds.toFixed(2)}s`);
    r.check('the frames already accumulated are kept',
            shot.frames > 40, `${shot.frames} frames`);
    r.check('the partial exposure is a real image, not black',
            t.span > 20 && t.litMin > 240, `${t.span}px of trail at ${t.litMin.toFixed(0)}/255`);
    await page.close();
  }

  /* --- the self-timer ----------------------------------------------------- */
  r.group('Self-timer');
  {
    const page = await openApp(2);
    await page.click('.timer[data-delay="3"]');
    await page.click('#shutter');
    await page.waitForSelector('#countdown:not([hidden])', { timeout: 5000 });

    const startedAt = Date.now();
    const firstNumber = (await page.textContent('#countdown')).trim();
    const readoutDuring = (await page.textContent('#readout')).trim();
    const liveDuring = await page.evaluate(() => {
      const v = document.getElementById('video');
      return v.srcObject ? v.srcObject.getTracks().filter((t) => t.readyState === 'live').length : 0;
    });

    r.check('it counts down from the delay chosen', firstNumber === '3', `showed "${firstNumber}"`);
    r.check('nothing is being exposed yet', readoutDuring === '', `readout was "${readoutDuring}"`);
    r.check('the viewfinder stays live while waiting', liveDuring === 1, `${liveDuring} live tracks`);

    await page.waitForFunction(() => document.getElementById('countdown').textContent === '1',
                               { timeout: 5000 });
    await page.waitForSelector('#review:not([hidden])', { timeout: 20000 });
    const wall = (Date.now() - startedAt) / 1000;
    const shot = await page.evaluate(() => window.__lastShot);

    r.check('the countdown ran before the exposure, not during it',
            wall > 4.4 && wall < 7, `${wall.toFixed(1)}s from tap to result, for a 3s timer + 2s exposure`);
    r.check('the exposure is the length asked for, not the timer plus it',
            Math.abs(shot.seconds - 2) < 0.5, `${shot.seconds.toFixed(2)}s exposed`);
    r.check('no frames were accumulated during the countdown',
            shot.frames > 40 && shot.frames < 90, `${shot.frames} frames — 2s of ~30fps`);
    await page.close();
  }

  r.group('Cancelling the self-timer');
  {
    const page = await openApp(2);
    await page.click('.timer[data-delay="10"]');
    await page.click('#shutter');
    await page.waitForSelector('#countdown:not([hidden])', { timeout: 5000 });
    await page.click('#shutter');
    await page.waitForSelector('#countdown', { state: 'hidden', timeout: 5000 });

    const state = await page.evaluate(() => ({
      review: !document.getElementById('review').hidden,
      shoot: !document.getElementById('shoot').hidden,
      shutterWaiting: document.getElementById('shutter').classList.contains('is-waiting'),
      durationLocked: document.getElementById('duration').disabled
    }));
    r.check('it does not fall through into an exposure', state.review === false);
    r.check('it goes back to composing', state.shoot && !state.shutterWaiting);
    r.check('the controls are usable again', state.durationLocked === false);

    // And the shutter still works afterwards.
    await page.click('.timer[data-delay="0"]');
    await page.click('#shutter');
    await page.waitForSelector('#review:not([hidden])', { timeout: 15000 });
    const shot = await page.evaluate(() => window.__lastShot);
    r.check('it can still shoot after a cancel', shot.frames > 40, `${shot.frames} frames`);
    await page.close();
  }

  /* --- backgrounding mid-shot -------------------------------------------- */
  r.group('Backgrounding mid-shot');
  {
    const page = await openApp(60);
    await page.click('#shutter');
    await page.waitForFunction(() => document.getElementById('readout').textContent.startsWith('2.'), { timeout: 20000 });

    const before = await page.evaluate(() =>
      Number(document.getElementById('readout').textContent.split(' · ')[1].split(' ')[0]));

    // iOS kills the stream when the app goes to the background. Simulate that
    // exactly: visibilityState flips, the event fires, the tracks die.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForSelector('#review:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('result');
      return !el.hidden && el.complete && el.naturalWidth > 0;
    });

    const shot = await page.evaluate(() => window.__lastShot);
    const t = await page.evaluate(measureTrail, '#result');

    r.check('the shot survives being backgrounded',
            shot.frames >= before - 2, `${shot.frames} frames kept, ${before} were in when it went away`);
    r.check('the plate is not half-black — the trail is all there',
            t.span > 20 && t.gaps === 0, `${t.span}px of continuous trail`);
    r.check('what was accumulated is at full brightness',
            t.litMin > 240, `dimmest ${t.litMin.toFixed(1)}/255`);

    const live = await page.evaluate(() => {
      const v = document.getElementById('video');
      return v.srcObject ? v.srcObject.getTracks().filter((t) => t.readyState === 'live').length : 0;
    });
    r.check('the camera is released on the way out', live === 0, `${live} live tracks`);
    await page.close();
  }

} finally {
  await browser.close();
  server.close();
}

r.done();
