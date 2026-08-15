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
 *   reset()   back to black, frame count to zero
 *   addFrame(source)  fold one video frame in
 *   finish()  settle the exposure and return the canvas to read from
 */

/**
 * Light Trail — `out = max(out, frame)`, per channel.
 *
 * `globalCompositeOperation = 'lighten'` is exactly that max, and the max of
 * 8-bit values is itself an 8-bit value, so this is *exact* in a plain 2D
 * canvas: no error accumulates however many frames go in, and there is nothing
 * to resolve at the end. Averaging is the operation that would need float.
 */
export function createLightTrailAccumulator(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  let frames = 0;

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
    reset,
    addFrame(source) {
      ctx.drawImage(source, 0, 0, width, height);
      frames++;
    },
    finish() { return canvas; }
  };
}
