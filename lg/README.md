# Vendored from Liquid Glass

The files in this folder, and `../shaders/`, are taken unchanged from the
Liquid Glass GNOME Shell extension (https://github.com/ryohsuke1231/liquid-glass,
MIT, see `LICENSE`), from its compiled `dist/` output. They are the glass
renderer: the stage copy, the blur passes, `glass.frag` (refraction, rim light,
tint) and the relays that keep the copy current.

One file differs: `diagnostics/glass.js` is a stub, because the original ties
into a debugging console that is not shipped here.
