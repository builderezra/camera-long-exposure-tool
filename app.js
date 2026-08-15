/**
 * Long exposure — phase 1, Light Trail.
 *
 * A web page cannot open a real shutter on iPhone: Safari has not shipped
 * ImageCapture or the exposureTime / iso track constraints. So the exposure is
 * built by taking ordinary ~1/30s frames and folding them together, which is
 * what an optical long exposure is — the same integral, sampled discretely.
 * The folding itself lives in accumulator.js.
 */

import { createLightTrailAccumulator } from './accumulator.js';

const $ = (id) => document.getElementById(id);

const stage      = $('stage');
const video      = $('video');
const result     = $('result');
const gate       = $('gate');
const shootPanel = $('shoot');
const review     = $('review');
const warnEl     = $('warn');
const gateWarn   = $('gateWarn');
const durationEl = $('duration');
const durationOut= $('durationOut');
const hintEl     = $('hint');
const shutter    = $('shutter');
const ringFill   = $('ringFill');
const readout    = $('readout');
const reviewNote = $('reviewNote');
const brightness = $('brightness');
const contrast   = $('contrast');
const brightOut  = $('brightnessOut');
const contrastOut= $('contrastOut');

const RING = 283;                    // 2πr for r = 45, matching the SVG

/* ---------------------------------------------------------------------------
   The single point where a camera is acquired.

   It returns a MediaStream and nothing else, so a test can swap it for
   canvas.captureStream() — a real stream with a real track, so everything
   downstream is the browser's own and only the permission prompt is avoided.
--------------------------------------------------------------------------- */
let acquireStream = async () => navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    // 'ideal', never 'exact': an exact constraint the phone can't meet throws
    // OverconstrainedError and we learn nothing.
    facingMode: { ideal: 'environment' },
    width:      { ideal: 1920 },
    height:     { ideal: 1080 },
    frameRate:  { ideal: 30 }
  }
});
window.__setStreamSource = (fn) => { acquireStream = fn; };   // the test seam

let stream = null;      // the one live stream, or null
let acc = null;         // the accumulator, holding the plate
let capturing = false;
let wakeLock = null;
let shotBlob = null;
let shotUrl = null;
let plateCanvas = null; // the finished plate, kept for re-baking on save

/* Releasing the camera must be total and idempotent. Every exit path calls it —
   finishing a shot, an error, backgrounding, page teardown. A camera left
   running is a privacy problem and a battery problem. */
function releaseCamera() {
  if (stream) {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* already dead */ }
    }
    stream = null;
  }
  if (video.srcObject) video.srcObject = null;
}

/* A 60-second exposure outlasts the screen timeout on most phones. */
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not fatal — the shot still runs */ }
}
function letSleep() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function show(panel) {
  for (const p of [gate, shootPanel, review]) p.hidden = p !== panel;
}

/* --- getting the camera up ------------------------------------------------ */

async function startCamera() {
  gateWarn.hidden = true;
  try {
    stream = await acquireStream();
  } catch (err) {
    failToGate(describeCameraError(err));
    return false;
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iOS will not autoplay inline without it
  video.muted = true;
  try {
    await video.play();
  } catch (err) {
    releaseCamera();
    failToGate('The viewfinder would not start: ' + err.name);
    return false;
  }

  await checkExposureLock();
  show(shootPanel);
  return true;
}

function describeCameraError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError')     return 'Camera access was refused. Allow it in Settings → Safari, then reload.';
  if (name === 'NotFoundError')       return 'No camera found on this device.';
  if (name === 'NotReadableError')    return 'The camera is busy — another app may be holding it.';
  if (name === 'OverconstrainedError')return 'This camera cannot meet the requested format.';
  if (!window.isSecureContext)        return 'This page needs to be served over https for the camera to work.';
  return 'The camera did not start: ' + (name || err);
}

/* Anything that sends the user back to the gate has to put its message *on* the
   gate — the shoot panel is about to be hidden. */
function failToGate(text) {
  gateWarn.textContent = text;
  gateWarn.classList.add('bad');
  gateWarn.hidden = false;
  show(gate);
}

/* Safari is unlikely to ever offer manual exposure, so this warning would
   otherwise appear on every single launch and become furniture. Say it once,
   let it be dismissed, and stay quiet after that. */
let warningDismissed = false;

function showWarning(text) {
  if (warningDismissed) return;
  warnEl.textContent = text;
  warnEl.hidden = false;
}

warnEl.addEventListener('click', () => {
  warningDismissed = true;
  warnEl.hidden = true;
});

/* Auto-exposure fighting back is the biggest quality risk here: as the trails
   build and the scene reads brighter, iOS may darken the incoming frames and
   flatten the result. If we cannot pin exposure, say so rather than let the
   user wonder why the shot went flat. */
async function checkExposureLock() {
  warnEl.hidden = true;
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return;

  let caps = null;
  if (typeof track.getCapabilities === 'function') {
    try { caps = track.getCapabilities(); } catch { caps = null; }
  }

  if (caps && Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual')) {
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual' }] });
      const now = track.getSettings ? track.getSettings().exposureMode : null;
      if (now === 'manual') return;                 // pinned; nothing to warn about
    } catch { /* fall through to the warning */ }
  }

  showWarning('Auto-exposure can’t be locked here — the camera may darken the scene ' +
              'as trails build. Tap to dismiss.');
}

/* --- the exposure --------------------------------------------------------- */

function startCapture() {
  if (capturing || !stream) return;

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) { readout.textContent = 'The viewfinder is not ready yet.'; return; }

  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    readout.textContent = 'This browser cannot deliver camera frames one at a time.';
    return;
  }

  // The accumulator owns the surface, and that surface *is* the live preview —
  // watching the trails draw themselves is the whole appeal.
  if (acc) acc.canvas.remove();
  acc = createLightTrailAccumulator(width, height);
  stage.insertBefore(acc.canvas, result);

  const seconds = Number(durationEl.value);
  const totalMs = seconds * 1000;
  let firstAt = null, lastAt = null;

  capturing = true;
  shutter.classList.add('is-running');
  shutter.setAttribute('aria-label', 'Stop the exposure');
  durationEl.disabled = true;
  hintEl.textContent = 'Tap again to stop early.';
  warnEl.hidden = true;              // nothing to be done about it mid-shot
  keepAwake();

  const finish = () => {
    if (!capturing) return;
    capturing = false;
    const elapsed = firstAt === null ? 0 : (lastAt - firstAt) / 1000;
    endCapture(elapsed);
  };

  /* requestVideoFrameCallback, not requestAnimationFrame: rAF fires at the
     display's 60/120Hz while the camera delivers 24–30, so polling with it
     would fold the same picture in two or three times — flattering the frame
     count while adding nothing to the image. */
  const onFrame = (now, _meta) => {
    if (!capturing) return;
    if (!stream) { finish(); return; }             // backgrounded: keep what we have

    acc.addFrame(video);
    if (firstAt === null) firstAt = now;
    lastAt = now;

    const elapsed = lastAt - firstAt;
    ringFill.style.strokeDashoffset = String(RING * (1 - Math.min(1, elapsed / totalMs)));
    readout.textContent = (elapsed / 1000).toFixed(1) + 's · ' + acc.frames + ' frames';

    if (elapsed >= totalMs) finish();
    else video.requestVideoFrameCallback(onFrame);
  };

  window.__capture = { stop: finish };             // used by the tests
  video.requestVideoFrameCallback(onFrame);
}

function stopCapture() {
  if (window.__capture) window.__capture.stop();
}

function endCapture(elapsedSeconds) {
  letSleep();
  shutter.classList.remove('is-running');
  shutter.setAttribute('aria-label', 'Start the exposure');
  durationEl.disabled = false;
  ringFill.style.strokeDashoffset = String(RING);
  hintEl.textContent = 'Prop the phone against something. Hand-held, a long exposure smears.';

  const frames = acc ? acc.frames : 0;
  releaseCamera();                                  // not needed while reviewing

  window.__lastShot = { frames, seconds: elapsedSeconds, width: acc && acc.width, height: acc && acc.height };

  if (frames === 0) {
    // Nothing arrived — a black rectangle is not a photograph. Say so instead.
    if (acc) { acc.canvas.remove(); acc = null; }
    failToGate('No frames arrived, so there is nothing to show. Try again.');
    return;
  }

  plateCanvas = acc.finish();
  plateCanvas.remove();                             // the <img> takes over from here

  brightness.value = 100;
  contrast.value = 100;
  applyAdjustments();

  plateCanvas.toBlob((blob) => {
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotBlob = blob;
    shotUrl = URL.createObjectURL(blob);
    result.src = shotUrl;
    result.hidden = false;
  }, 'image/png');

  reviewNote.textContent =
    elapsedSeconds.toFixed(1) + 's · ' + frames + ' frames · ' +
    plateCanvas.width + '×' + plateCanvas.height;
  readout.textContent = ' ';
  show(review);
}

/* --- brightness and contrast ---------------------------------------------- */

/* Preview through a CSS filter, which is instant and always supported. The same
   numbers get baked into the pixels only when saving. */
function applyAdjustments() {
  const b = Number(brightness.value) / 100;
  const c = Number(contrast.value) / 100;
  brightOut.textContent = brightness.value + '%';
  contrastOut.textContent = contrast.value + '%';
  result.style.filter = `brightness(${b}) contrast(${c})`;
}

function bakeAdjustments() {
  const b = Number(brightness.value) / 100;
  const c = Number(contrast.value) / 100;
  if (b === 1 && c === 1) return plateCanvas;

  const out = document.createElement('canvas');
  out.width = plateCanvas.width;
  out.height = plateCanvas.height;
  const ctx = out.getContext('2d', { alpha: false });

  ctx.filter = `brightness(${b}) contrast(${c})`;
  if (ctx.filter && ctx.filter !== 'none') {
    ctx.drawImage(plateCanvas, 0, 0);
    return out;
  }

  // Older Safari has no canvas filter. brightness then contrast, per CSS order.
  ctx.filter = 'none';
  ctx.drawImage(plateCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = ((d[i + k] / 255) * b - 0.5) * c + 0.5;
      d[i + k] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* A plain <a download> is unreliable on iOS. The share sheet works, and
   long-pressing the <img> is the fallback — which is why the result is shown as
   an <img> rather than left in a canvas. */
async function save() {
  if (!plateCanvas) return;
  const canvas = bakeAdjustments();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) { reviewNote.textContent = 'Could not encode the image.'; return; }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new File([blob], `long-exposure-${stamp}.png`, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;        // dismissed, not failed
    }
  }
  reviewNote.textContent = 'No share sheet here — long-press the image and choose Save Image.';
}

/* --- lifecycle ------------------------------------------------------------ */

window.addEventListener('pagehide', () => { releaseCamera(); letSleep(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;

  // Backgrounding kills the stream on iOS. Stop, but keep the frames already
  // accumulated rather than throwing the shot away.
  releaseCamera();
  letSleep();

  if (capturing) {
    stopCapture();                 // keeps the frames already accumulated
  } else if (!shootPanel.hidden) {
    // Composing, not shooting. The stream is gone and re-acquiring needs a
    // fresh gesture, so hand the user the button rather than a frozen preview.
    failToGate('The camera was released while the app was in the background.');
  }
});

durationEl.addEventListener('input', () => {
  durationOut.textContent = durationEl.value + 's';
});

shutter.addEventListener('click', () => {
  if (capturing) stopCapture();
  else startCapture();
});

$('begin').addEventListener('click', startCamera);   // camera needs a real gesture

$('retake').addEventListener('click', async () => {
  result.hidden = true;
  if (shotUrl) { URL.revokeObjectURL(shotUrl); shotUrl = null; }
  shotBlob = null;
  plateCanvas = null;
  if (acc) { acc.canvas.remove(); acc = null; }
  readout.textContent = ' ';
  await startCamera();                               // the tap is the gesture
});

$('save').addEventListener('click', save);
brightness.addEventListener('input', applyAdjustments);
contrast.addEventListener('input', applyAdjustments);
