# Vendored from Liquid Glass

The files in this folder, and `../shaders/`, are taken unchanged from the
Liquid Glass GNOME Shell extension (https://github.com/ryohsuke1231/liquid-glass,
MIT, see `LICENSE`), from its compiled `dist/` output. They are the glass
renderer: the stage copy, the blur passes, `glass.frag` (refraction, rim light,
tint) and the relays that keep the copy current.

Three things differ from the original:

* `diagnostics/glass.js` is a stub, because the original ties into a debugging
  console that is not shipped here.
* `rendering/glassRenderer.js` and `../shaders/glass.frag` gained a per-region
  corner radius (`region_radius`), so a capsule, a card and a circle can share
  one surface and each keep its own shape. A region without one uses the
  surface's `corner_radius`, as before.

`actors/dockGeometry.js` is also unchanged. It, with the renderer, is what the
dock support (`../dockGlass.js`, a port of Liquid Glass's `dockManager.ts` and
`dockWatcher.ts`) is built on.
