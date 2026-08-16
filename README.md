# Long exposure

A long-exposure camera that runs as a web page, for use on a phone. Plain HTML/CSS/JS — no build
step, no framework, no dependencies at runtime.

**Phases 0 and 1 exist: the device probe, and Light Trail.** Motion Blur and Low Light are not built
yet — they need a half-float accumulator, and phase 1 is the one that answers "is this cool".

| file | what it is |
|---|---|
| `index.html` + `app.css` + `app.js` | the camera |
| `accumulator.js` | frames in, exposure out — the one piece phase 2 replaces |
| `camera-probe.html` | the phase 0 device probe, standalone |

## Getting it on your phone

`getUserMedia` is refused over `http://`, so the page has to be served over HTTPS. GitHub Pages is
the easy route:

1. In this repo, **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick the
   branch and `/ (root)`.
2. Wait for the deploy, then open the Pages URL on your phone, and **Share → Add to Home Screen**.

The probe is at `/camera-probe.html`, linked from the bottom of the opening screen.

For desktop work, `localhost` counts as a secure context: `npm run serve`, then
<http://localhost:8080>. A webcam is a useless stand-in for a rear phone camera at night, though —
the real judgements happen outdoors, after dark.

## Phase 1 — Light Trail

`out = max(out, frame)`, per channel, which is what `globalCompositeOperation = 'lighten'` does. The
max of 8-bit values is itself 8-bit, so this is *exact* in a plain 2D canvas — no error accumulates
however many frames go in, and there is nothing to resolve at the end. It is both the cheapest mode
and the most striking one, which is why it goes first.

- Full-screen viewfinder. Tap the shutter and **the preview becomes the exposure as it builds** —
  the accumulator's canvas is what you are looking at, not a copy of it.
- Duration 1–60s, or tap again to stop early, which is how you actually judge a long exposure.
- **Self-timer, off / 3s / 10s.** Tapping the shutter is the moment you are most likely to nudge the
  phone, and on a light trail that wobble smears every trail already drawn. The timer buys the
  seconds it takes for the phone to settle after your finger leaves it. The ring drains while it
  waits and fills while it exposes; tapping again cancels. The countdown is not part of the
  exposure — a 3s timer with an 8s duration still exposes for 8s.
- Review screen: the whole plate, brightness and contrast, retake, save.
- A screen wake lock holds the display on, since a 60-second exposure outlasts most screen timeouts.
- The camera is released the moment the exposure ends, so it is not running while you review.

Not in phase 1, on purpose: **Light Sensitivity** is the per-frame weight, and a weight means
nothing to a `max` — it would just cap the ceiling rather than expose less. It belongs with the
averaging modes in phase 2, along with ISO.

### The blend is measured, not trusted

The whole mode rests on one browser feature working. When a blend mode is quietly ignored, the
failure is invisible in the code and total in the output: every frame overwrites the last, and a
60-second exposure comes out as an ordinary snapshot of whatever was in front of the lens at the
end.

So before each exposure the accumulator fills the plate white and blends one real frame over it.
`max(255, anything)` is 255, so a working blend leaves it white; any pixel that came back darker is
the frame having overwritten the white. There is no false failure in that test — white is the
maximum, nothing can legitimately darken it.

If the direct route fails, it blends via a plain intermediate canvas instead, which is more
reliably implemented, at the cost of one extra draw per frame. The review screen says `via copy`
when that happened. If neither route takes the max, the app says so rather than hand over a
snapshot dressed as an exposure. `?blend=direct` or `?blend=copy` forces a route by hand.

### The thing most likely to spoil a shot

Auto-exposure. As trails build the scene reads brighter, and iOS may darken the incoming frames to
compensate, flattening the result. The app tries to pin `exposureMode: 'manual'` and warns you once
if it can't. Safari is unlikely to offer it, so expect the warning — and expect to work around it by
keeping a bright source out of the middle of the frame.

The other one is hand-holding. Every frame lands a few pixels off and the whole scene smears, so the
app tells you to prop the phone. Frame alignment is phase 4 and only if you ask.

## What the probe reports

- Whether real shutter/ISO control exists here — `getSupportedConstraints`, `track.getCapabilities`,
  and a live attempt to actually switch auto-exposure off. That last one matters most: AE darkening
  the incoming frames as the scene brightens is the biggest quality risk in the project.
- What we actually got when we asked for a 1080p rear camera, rather than what we asked for.
- How many **unique** frames per second the camera really delivers, counted with
  `requestVideoFrameCallback`. `requestAnimationFrame` would fire at the display's 60/120Hz and
  count the same picture two or three times.
- **The share of offered frames actually accumulated**, measured during a real capture. This is the
  number that says whether the phone can hold a long exposure at this resolution. It is not a
  microbenchmark: timing `drawImage` lies in both directions, because it returns when the command is
  queued, not when it is drawn.
- WebGL2 with a genuinely complete `RGBA16F` render target — the thing phase 2 needs. The extension
  being listed is not proof, so the probe builds the framebuffer and asks the driver.

Then it shoots a real 4-second light-trail exposure and puts it on screen. Nothing is uploaded and
nothing is saved unless you tap save.

## The tests

```
npm install
npm test
```

The camera is acquired in exactly one place per page, in a function that returns a `MediaStream` and
nothing else. The tests replace that one function with `canvas.captureStream()`, so the track, the
frames and `requestVideoFrameCallback` are all the browser's own and only the permission prompt is
avoided.

The input is a white dot crossing black, once, slowly. Because Light Trail is `max`, every pixel the
dot touched ends at full brightness and *stays* there — the pixel lit first is exactly as bright as
the pixel lit last. Under an average, a pixel lit for one frame in ~120 would come out at about
2/255. That gap is the assertion, and it also covers stopping early and being backgrounded mid-shot:
both must keep the frames already accumulated rather than returning a half-black plate.

The dot has to move less than its own diameter per frame or the trail comes out beaded. That is not
a testing artefact — it is the real gap-between-frames effect, since ~30 samples/sec is not
continuous light. A fast enough light really will bead. Traffic and water are slow enough that it
doesn't show.

## Why frames are accumulated at all

Safari has not shipped `ImageCapture` or the `exposureTime` / `iso` track constraints, so a web page
cannot open a real shutter. The exposure is built by taking ordinary ~1/30s frames and combining
them — which is what an optical long exposure is, the same integral sampled discretely, and what
every phone app in this category does. Three consequences worth knowing:

- **Clipping** — frames arrive already 8-bit and already clipped, so "brighter" has to come from
  gain, not from more frames.
- **Gaps** — ~30 samples/sec is not continuous light, so a very fast light beads slightly. Traffic
  and water are slow enough that it doesn't show. The test fixture had to be slowed down to avoid
  it, which is a fair demonstration of the effect.
- **Auto-exposure** — see above.

## What comes next

| phase | what ships |
|---|---|
| 0 | **The device probe — done.** |
| 1 | **Light Trail — done.** |
| 2 | Motion Blur + Low Light: WebGL2 half-float accumulator, Light Sensitivity, ISO |
| 3 | Save the build-up as video; freeze-composite |
| 4 | Hand-held frame alignment |

Averaging hundreds of frames in 8 bits quantises every sample to 1/255 and the error compounds into
visible banding, so phase 2 needs a half-float render target — WebGL2 with
`EXT_color_buffer_half_float`, ping-ponged between two textures. The probe already checks that a
complete `RGBA16F` framebuffer can be built. It goes behind the same interface `accumulator.js`
defines, so nothing outside that file should need to change.
