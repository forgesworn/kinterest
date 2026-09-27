// QR rendering for the pairing screen. Port of an earlier sibling app's
// `app/src/qr.ts` (see internal plan 2026-08-11-parent-mode,
// Task 3, "QR reference to port"), trimmed to this app's needs: that app's
// `qrImgTag` builds a raw HTML string with its own `alt` escaping because it
// has no JSX layer; this app does, so a thin component replaces it and lets
// React handle attribute escaping the normal way.

import type { ReactElement } from 'react'
import qrcode from 'qrcode-generator'

/** Renders `data` as a QR code data: URL. Type 0 = automatic size (smallest
 *  that fits the payload); 'M' error correction (~15% damage tolerance) —
 *  the pairing QR is scanned off a phone or laptop screen at an angle or
 *  distance, unlike a clean static invite screen, so it needs more
 *  tolerance than the format's minimum ('L'). `cellSize`/`margin` are CSS
 *  pixels per module / border, matching that earlier sibling app's own defaults. */
export function qrDataUrl(data: string, cellSize = 6, margin = 16): string {
  const qr = qrcode(0, 'M')
  qr.addData(data)
  qr.make()
  return qr.createDataURL(cellSize, margin)
}

/** Thin wrapper — an `<img>` of {@link qrDataUrl}'s output. Every caller in
 *  this app passes a fixed, non-wire-derived `alt` (the pairing QR carries
 *  no user-chosen text of its own), so unlike that earlier sibling app's `qrImgTag` this
 *  needs no escaping of its own beyond what JSX already does for every
 *  attribute. */
export function QRCode({
  data,
  alt = 'Pairing QR code',
  size = 220,
}: {
  data: string
  alt?: string
  size?: number
}): ReactElement {
  return <img className="qr-code" src={qrDataUrl(data)} alt={alt} width={size} height={size} />
}
