#!/usr/bin/env node
// Rasterises the jar brand mark (app/public/icons/jar-mark.svg — see that
// file's own header for provenance) into every PNG the PWA manifest and the
// Android shell need. One-off/occasional script, not part of the app build:
// run it by hand (`cd app && npm run icons`) and commit the resulting PNGs,
// same as the SVG source they're generated from.
//
// Uses @resvg/resvg-js (devDependency of app/package.json) rather than a
// browser/canvas — this runs in plain Node, no display needed, and resvg
// renders flat-colour SVG (no filters, which the master mark avoids
// deliberately — see jar-mark.svg's header) pixel-identically to how the
// same shapes get hand-translated into the Android VectorDrawable.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// @resvg/resvg-js is a devDependency of app/package.json, not of this repo
// root — this script lives in the shared scripts/ dir, so plain ESM
// resolution (which walks up from *this file's* directory) would never find
// app/node_modules. Resolve it explicitly from app/'s own package.json
// instead of duplicating the install at the repo root.
const appRequire = createRequire(path.join(repoRoot, 'app/package.json'))
const { Resvg } = appRequire('@resvg/resvg-js')
const svgPath = path.join(repoRoot, 'app/public/icons/jar-mark.svg')
const svgSource = readFileSync(svgPath, 'utf8')

// Pull the inner markup (background rect + jar group) out of the master SVG
// so the round-mipmap variant below can re-wrap it in a circular clip
// without duplicating the artwork by hand.
const innerMatch = svgSource.match(/<svg[^>]*>([\s\S]*)<\/svg>/)
if (!innerMatch) throw new Error(`could not parse ${svgPath}`)
const innerMarkup = innerMatch[1]

/** Renders `svg` (a full <svg>...</svg> document, square viewBox) to a PNG
 *  buffer `size`x`size` px. The master mark paints its own opaque paper
 *  background, so there's no transparency to backfill here. */
function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng()
}

function writeFile(relPath, buffer) {
  const outPath = path.join(repoRoot, relPath)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, buffer)
  console.log(`wrote ${relPath} (${buffer.length} bytes)`)
}

// ---- PWA / web icon set — straight renders of the master mark. ----------
// maskable-512 is the SAME artwork as icon-512: jar-mark.svg already keeps
// everything inside the central ~66% of a full-bleed paper square, which is
// exactly what a maskable icon's safe zone requires — no separate art.
const squareTargets = [
  ['app/public/icons/icon-192.png', 192],
  ['app/public/icons/icon-512.png', 512],
  ['app/public/icons/maskable-512.png', 512],
  ['app/public/icons/apple-touch-icon.png', 180],
]
for (const [relPath, size] of squareTargets) {
  writeFile(relPath, renderPng(svgSource, size))
}

// ---- Android legacy launcher mipmaps -------------------------------------
// Pre-API-26 devices (and anything reading the legacy `ic_launcher`/
// `ic_launcher_round` mipmaps rather than the adaptive-icon XML) need plain
// PNGs at each density bucket.
const densities = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]

// Round variant: the same mark, clipped to a circle so the paper background
// only shows inside the circle (transparent corners) — "a circular paper
// clip" per the design brief. A plain clipPath, not a filter.
const roundSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  `<defs><clipPath id="round-clip"><circle cx="100" cy="100" r="100" /></clipPath></defs>` +
  `<g clip-path="url(#round-clip)">${innerMarkup}</g>` +
  `</svg>`

for (const [density, size] of densities) {
  const dir = `android/app/src/main/res/mipmap-${density}`
  writeFile(`${dir}/ic_launcher.png`, renderPng(svgSource, size))
  writeFile(`${dir}/ic_launcher_round.png`, renderPng(roundSvg, size))
}

console.log('done')
