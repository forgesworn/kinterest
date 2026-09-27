// The Kindred brand mark as UI: a mason-jar silhouette holding a small flame
// low inside, drawn purely from theme.css tokens (--ink strokes, --amber
// fill/glow) so it stays dark-mode aware for free. See
// internal plan 2026-08-11-child-mode, Task 3 ("the jar is the
// brand mark as UI... simple geometric mason-jar SVG in theme tokens, fill =
// balance share of soft target... flame-amber glow, no clutter") and this
// plan's brand-context note ("shouldered rectangle + lid band... geometric,
// woodcut-adjacent").
//
// Split the same way QRScanner.tsx is: a handful of pure, DOM-free helpers
// exported and tested directly (this module's whole reason for existing, per
// the plan's own file list — "pure jarFill(balance, highWater) tested"),
// then the SVG component itself underneath, un-tested by an automated DOM
// runner (this suite has none — see Task 2's report on QRScanner/
// ChildOnboarding for the same precedent).

import type { ReactElement } from 'react'

// ============================================================================
// jarFill — pure. See this module's header.
// ============================================================================

/** The soft target the jar fills TOWARDS is `highWaterMinor × 1.2` — never
 *  the current balance itself — so a brand-new all-time-high balance always
 *  reads as "nearly full, with room to keep growing" (≈83%) rather than
 *  "completely full", and the jar never has to awkwardly overflow past its
 *  own rim. */
const SOFT_TARGET_MULTIPLIER = 1.2

/** The minimum fill this function ever returns for a positive `highWater` —
 *  see the "0 balance" case below: an empty jar must still show a low ember
 *  glow, never read as literally empty/black (the brand mark is a keepsake,
 *  not a "you have nothing" shame indicator). */
const EMBER_FLOOR = 0.04

/**
 * Pure. `balanceMinor`/`highWaterMinor` are minor-unit integers in whatever
 * single currency the caller has already resolved (this function has no
 * currency concept of its own — see ChildHome.tsx's own call site for how it
 * picks one). `highWaterMinor` is the CALLER's running record of the largest
 * balance this jar has ever shown (never derived internally — a caller
 * folding a child's own entry history is expected to pass
 * `Math.max(priorHighWater, currentBalance)`, so `highWaterMinor >=
 * balanceMinor` holds in the common case; a caller that violates this simply
 * gets a fill clamped to 1 rather than a value >1, never a throw).
 *
 * Three properties this function is tested against directly (Jar.test.ts):
 *  - a non-positive balance still returns `EMBER_FLOOR`, never 0 — "0
 *    balance -> low ember glow, not empty-black".
 *  - monotonic in `balanceMinor`: holding `highWaterMinor` fixed, a bigger
 *    balance never produces a smaller fill.
 *  - monotonic (decreasing) in `highWaterMinor`: holding `balanceMinor`
 *    fixed, a bigger historical high-water mark (a bigger soft target)
 *    never produces a BIGGER fill — "highWater growth" dilutes the same
 *    balance's share rather than inflating it.
 *
 * Always a finite number in `[EMBER_FLOOR, 1]`; never throws (garbage/
 * non-finite input degrades to `EMBER_FLOOR`, matching this suite's "total
 * parsers, fail closed" convention for anything that ends up in a render).
 */
export function jarFill(balanceMinor: number, highWaterMinor: number): number {
  if (!Number.isFinite(balanceMinor) || !Number.isFinite(highWaterMinor)) return EMBER_FLOOR
  if (balanceMinor <= 0) return EMBER_FLOOR
  const target = Math.max(highWaterMinor, 1) * SOFT_TARGET_MULTIPLIER
  const raw = balanceMinor / target
  return Math.min(1, Math.max(EMBER_FLOOR, raw))
}

// ============================================================================
// The jar SVG. Geometric, woodcut-adjacent per the brand note: a shouldered
// rectangle (the jar body) + a narrower lid band, a horizontal waterline
// clipped to `fill`'s height, and a small flame shape low inside glowing at
// low fill levels (the ember). No photographic detail, no gradients beyond
// the flame's own glow filter — "no clutter" per the plan.
// ============================================================================

const VIEW_W = 160
const VIEW_H = 200
// Jar body outline, drawn as one path: lid band top, shoulder taper, straight
// sides, rounded base.
const JAR_PATH =
  'M56 20 H104 V34 C104 34 128 44 128 70 V158 C128 176 112 188 80 188 C48 188 32 176 32 158 V70 C32 44 56 34 56 34 Z'
const LID_PATH = 'M52 14 H108 C112 14 114 17 114 20 V26 H46 V20 C46 17 48 14 52 14 Z'
// The body's interior fill region, inset slightly from JAR_PATH's outline so
// the waterline never draws over the --ink stroke itself.
const INTERIOR_TOP = 40
const INTERIOR_BOTTOM = 182
const INTERIOR_HEIGHT = INTERIOR_BOTTOM - INTERIOR_TOP

export function Jar({ fill, className = '' }: { fill: number; className?: string }): ReactElement {
  const clamped = Number.isFinite(fill) ? Math.min(1, Math.max(0, fill)) : 0
  const waterY = INTERIOR_BOTTOM - clamped * INTERIOR_HEIGHT
  // The flame glows brighter the lower the fill (an ember-lit jar in a dark
  // room, per the brand note) but is always at least dimly present — never
  // fully invisible — matching jarFill's own EMBER_FLOOR floor.
  const glowOpacity = 0.35 + (1 - clamped) * 0.5

  return (
    <svg
      className={`jar ${className}`.trim()}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="A jar, filling with saved money"
    >
      <defs>
        <clipPath id="jar-interior-clip">
          <path d={JAR_PATH} />
        </clipPath>
        <filter id="jar-flame-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g clipPath="url(#jar-interior-clip)">
        <rect x="0" y={waterY} width={VIEW_W} height={VIEW_H - waterY} className="jar-water" />
      </g>

      <path d={LID_PATH} className="jar-lid" />
      <path d={JAR_PATH} className="jar-outline" />

      <g className="jar-flame" opacity={glowOpacity} filter="url(#jar-flame-glow)">
        <path d="M80 150 C74 142 72 134 80 124 C88 134 86 142 80 150 Z" />
      </g>
    </svg>
  )
}
