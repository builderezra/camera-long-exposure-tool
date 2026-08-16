/**
 * The accumulator: frames go in, an exposure comes out.
 *
 * Phase 1 ships one implementation, Light Trail. Phase 2's Motion Blur and Low
 * Light need a half-float render target and will be a different implementation
 * behind this same shape, so nothing outside this file should care which one it
 * is holding:
 *
 *   mode      a label for the UI
 *   canvas    the surface to put on screen — the live build-up *is* the plate
 *   frames    how many frames have gone in
 *   path      how the blend is being done, once known: direct | copy | broken
 *   reset()   back to black, frame count to zero
 *   addFrame(source)  fold one video frame in
 *   finish()  settle the exposure and return the canvas to read from
 */

const SAMPLE = 16;   // the plate is read back downscaled to this, to sample it whole

/**
 * Light Trail — `out = max(out, frame)`, per channel.
 *
 * `globalCompositeOperation = 'lighten'` is exactly that max, and the max of
 * 8-bit values is itself an 8-bit value, so this is *exact* in a plain 2D
 * canvas: no error accumulates however many frames go in, and there is nothing
 * to resolve at the end. Averaging is the operation that would need float.
 *
 * The catch is that the whole mode rests on one browser feature working, and
 * when a blend mode is quietly ignored the failure is invisible in code and
 * total in the output: every frame overwrites the last, and a 60-second
 * exposure comes out as an ordinary snapshot of whatever was in front of the
 * lens at the end. So the blend is not trusted — it is measured, on the real
 * device, with the real video, before the exposure starts. See verify().
 *
 * `options.path` forces a route instead of measuring, for tests and for
 * checking a suspect device by hand (?blend=copy).
 */
export function createLightTrailAccumulator(width, height, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  // Deliberately NOT { alpha: false }. An opaque canvas takes a different path
  // through WebKit, and 'lighten' can be dropped on it — which is precisely the
  // failure this file now guards against.
  const ctx = canvas.getContext('2d');

  const probe = document.createElement('canvas');
  probe.width = SAMPLE;
  probe.height = SAMPLE;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  let scratch = null, scratchCtx = null;
  let frames = 0;
  let path = options.path || null;

  /* Straight into the plate, blended. One draw per frame. */
  function drawDirect(source) {
    ctx.drawImage(source, 0, 0, width, height);
  }

  /* Via a plain intermediate canvas. Costs a second full-size draw per frame,
     but canvas-to-canvas blending is more reliably implemented than
     video-to-canvas blending, so this is the route that survives when the
     direct one doesn't. */
  function drawCopy(source) {
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = width;
      scratch.height = height;
      scratchCtx = scratch.getContext('2d');
    }
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.drawImage(source, 0, 0, width, height);
    ctx.drawImage(scratch, 0, 0);
  }

  /**
   * Does `lighten` actually take the max here?
   *
   * Fill the plate white, then blend a frame over it. max(255, anything) is 255,
   * so if the blend is working the plate must still be white everywhere. Any
   * pixel that came back darker is the frame having overwritten the white —
   * source-over behaviour wearing a lighten label. There is no false failure in
   * this test: white is the maximum, so nothing can legitimately darken it.
   */
  function blendHolds(draw, source) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighten';
    draw(source);

    probeCtx.drawImage(canvas, 0, 0, SAMPLE, SAMPLE);
    const d = probeCtx.getImageData(0, 0, SAMPLE, SAMPLE).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) return false;
    }
    return true;
  }

  function verify(source) {
    if (blendHolds(drawDirect, source)) path = 'direct';
    else if (blendHolds(drawCopy, source)) path = 'copy';
    else path = 'broken';
    reset();
  }

  function reset() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighten';
    frames = 0;
  }

  reset();

  return {
    mode: 'light-trail',
    canvas,
    width,
    height,
    get frames() { return frames; },
    get path() { return path; },
    reset,
    addFrame(source) {
      // The first frame pays for the check; the plate is reset straight after,
      // so nothing from it leaks into the exposure.
      if (path === null) verify(source);
      if (path === 'copy') drawCopy(source);
      else drawDirect(source);
      frames++;
    },
    finish() { return canvas; }
  };
}
