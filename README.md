# Long exposure

A long-exposure camera that runs as a web page, for use on a phone. Plain HTML/CSS/JS — no build
step, no framework, no dependencies at runtime.

**Phase 0 is what exists so far: the device probe.** Nothing else is built yet, on purpose — the
probe's numbers decide some of the design of phase 1.

## Running the probe on your phone

`getUserMedia` is refused over `http://`, so the page has to be served over HTTPS. GitHub Pages is
the easy route:

1. In this repo, **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick the
   branch and `/ (root)`.
2. Wait for the deploy, then open the Pages URL on your phone. The root redirects to the probe.

For desktop work, `localhost` counts as a secure context: `npm run serve`, then
<http://localhost:8080>.

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

## The test

```
npm install
npm test
```

The camera is acquired in exactly one place — `acquireStream()` in `camera-probe.html` — which
returns a `MediaStream` and nothing else. The test replaces that one function with
`canvas.captureStream()`, so the track, the frames and `requestVideoFrameCallback` are all the
browser's own and only the permission prompt is avoided.

The input is a white dot crossing black. Light Trail is `out = max(out, frame)`, so every pixel the
dot touched ends at full brightness and *stays* there — the pixel lit first is exactly as bright as
the pixel lit last. Under an average, a pixel lit for one frame in ~120 would come out at about
2/255. That gap is the assertion.

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
| 1 | Light Trail only: viewfinder, live build-up, duration, shutter, result screen, save. 2D canvas, no WebGL |
| 2 | Motion Blur + Low Light: WebGL2 half-float accumulator, Light Sensitivity, ISO |
| 3 | Save the build-up as video; freeze-composite |
| 4 | Hand-held frame alignment |

Phase 1 is the one that answers "is this cool".
