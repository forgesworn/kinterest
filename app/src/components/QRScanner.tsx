// Live QR scanner: getUserMedia + jsQR frame decoding. Port of charter's
// `apps/charter-app/src/components/QRScanner.tsx` ("the 'works quite well'
// one" — see this task's brief), trimmed to what this app's pairing flow
// needs and restyled onto this app's own theme.css tokens rather than
// charter's Kintrinsic ones. Kept from charter almost verbatim: `onScan`
// returning `false` keeps the camera scanning past a stray/foreign QR
// (a family member's other QR code in frame) instead of freezing on it;
// progressive-enhancement zoom (hardware `zoom` capability where a camera
// exposes one, a digital centre-crop fallback otherwise).
//
// Total on garbage frames: `jsQR` itself already returns `null` rather than
// throwing on a frame with no decodable code — every branch below treats
// "not decoded yet" and "decoded but the caller rejected it" identically
// (keep scanning), never surfacing either as an error. The one real failure
// mode is the camera itself being unavailable (permission denied, no
// device, insecure context) — surfaced once via `error`, at which point the
// caller's own paste-fallback (this task's "Camera-less fallback: paste the
// QR text") is the way forward; this component has no text-input UI of its
// own by design, so ChildOnboarding.tsx owns that half.

import { useEffect, useRef, useCallback, useState } from 'react'
import jsQR from 'jsqr'

interface Props {
  onScan: (data: string) => boolean
  active: boolean
}

export const PREFERRED_ZOOM = 1.6
const ZOOM_BUTTON_STEP = 0.2
const DIGITAL_ZOOM_RANGE = { min: 1, max: 3.5, step: 0.1 }
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30, max: 30 },
}

/** The source rectangle to crop out of the raw video frame for a given
 *  digital zoom level — pure, tested directly without a camera. */
export function scanSourceRect(videoWidth: number, videoHeight: number, zoom: number) {
  const safeWidth = Math.max(0, videoWidth)
  const safeHeight = Math.max(0, videoHeight)
  const safeZoom = Number.isFinite(zoom) ? Math.max(1, Math.min(zoom, 6)) : 1
  const width = safeWidth / safeZoom
  const height = safeHeight / safeZoom
  return {
    sx: (safeWidth - width) / 2,
    sy: (safeHeight - height) / 2,
    sw: width,
    sh: height,
  }
}

export function initialZoom(range: { min: number; max: number } | null, preferred = PREFERRED_ZOOM) {
  if (!range) return Math.max(1, preferred)
  return Math.max(range.min, Math.min(preferred, range.max))
}

export function nextZoom(
  current: number,
  range: { min: number; max: number; step?: number },
  direction: -1 | 1,
  buttonStep = ZOOM_BUTTON_STEP,
) {
  const step = Math.max(range.step ?? buttonStep, buttonStep)
  const bounded = Math.max(range.min, Math.min(range.max, current + direction * step))
  return Number(bounded.toFixed(2))
}

export function QRScanner({ onScan, active }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doneRef = useRef(false)
  const onScanRef = useRef(onScan)
  const [error, setError] = useState<string | null>(null)
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [hardwareZoom, setHardwareZoom] = useState(false)
  const zoomRef = useRef(1)
  const hardwareZoomRef = useRef(false)
  zoomRef.current = zoom
  hardwareZoomRef.current = hardwareZoom
  onScanRef.current = onScan

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    trackRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const applyZoom = useCallback(
    (value: number) => {
      const range = zoomRange ?? DIGITAL_ZOOM_RANGE
      const bounded = Number(Math.max(range.min, Math.min(range.max, value)).toFixed(2))
      zoomRef.current = bounded
      setZoom(bounded)
      if (!hardwareZoomRef.current) return
      const track = trackRef.current as
        | (MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> })
        | null
      if (!track?.applyConstraints) return
      try {
        void track.applyConstraints({ advanced: [{ zoom: bounded }] })
      } catch {
        // Camera rejected the constraint mid-stream — leave zoom where it was.
      }
    },
    [zoomRange],
  )

  const stepZoom = useCallback(
    (direction: -1 | 1) => {
      if (!zoomRange) return
      applyZoom(nextZoom(zoomRef.current, zoomRange, direction))
    },
    [applyZoom, zoomRange],
  )

  // Tap-to-refocus — restored from charter's original component (trimmed out
  // of the first port of this file by mistake; most phone cameras' AF hunts
  // on a close-up, low-contrast QR code, and a tap nudging continuous
  // focus/exposure is the fix charter's own comment documents). Best-effort:
  // most desktop/laptop webcams don't expose these constraints at all, so a
  // rejected `applyConstraints` is swallowed rather than surfaced.
  const nudgeFocus = useCallback(() => {
    const track = trackRef.current as
      | (MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> })
      | null
    if (!track?.applyConstraints) return
    void track
      .applyConstraints({ advanced: [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }] })
      .catch(() => {
        // Unsupported on many mobile browsers.
      })
  }, [])

  useEffect(() => {
    if (!active) {
      stopCamera()
      doneRef.current = false
      setError(null)
      setZoomRange(null)
      setZoom(1)
      zoomRef.current = 1
      setHardwareZoom(false)
      hardwareZoomRef.current = false
      return
    }

    let mounted = true
    doneRef.current = false

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('no mediaDevices')
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: VIDEO_CONSTRAINTS,
          audio: false,
        })

        if (!mounted) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream

        const track = stream.getVideoTracks()[0] ?? null
        trackRef.current = track
        const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined
        const zoomCap = caps?.zoom as { min?: number; max?: number; step?: number } | undefined
        if (zoomCap && typeof zoomCap.max === 'number' && zoomCap.max > (zoomCap.min ?? 1)) {
          const min = zoomCap.min ?? 1
          const max = zoomCap.max
          setHardwareZoom(true)
          hardwareZoomRef.current = true
          setZoomRange({ min, max, step: zoomCap.step || 0.1 })
          const startZoom = initialZoom({ min, max })
          zoomRef.current = startZoom
          setZoom(startZoom)
          void (track as MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> })
            .applyConstraints?.({ advanced: [{ zoom: startZoom }] })
            .catch(() => {
              // Optical zoom is best-effort.
            })
        } else {
          setHardwareZoom(false)
          hardwareZoomRef.current = false
          setZoomRange(DIGITAL_ZOOM_RANGE)
          const startZoom = initialZoom(DIGITAL_ZOOM_RANGE)
          zoomRef.current = startZoom
          setZoom(startZoom)
        }

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        scanFrame()
      } catch {
        if (mounted) setError("Couldn't open the camera. You can type the code in below instead.")
      }
    }

    function scanFrame() {
      if (!mounted || doneRef.current) return

      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < video.HAVE_ENOUGH_DATA) {
        timerRef.current = setTimeout(scanFrame, 250)
        return
      }

      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        timerRef.current = setTimeout(scanFrame, 250)
        return
      }

      const digitalZoom = hardwareZoomRef.current ? 1 : zoomRef.current
      const source = scanSourceRect(video.videoWidth, video.videoHeight, digitalZoom)
      ctx.drawImage(video, source.sx, source.sy, source.sw, source.sh, 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // jsQR is total: a frame with no decodable code (blur, motion, an
      // empty room) yields `null` rather than throwing — see this module's
      // header.
      const result = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      })

      if (result?.data && !doneRef.current) {
        // Only stop on a code the caller accepts — a stray/foreign QR keeps
        // scanning rather than freezing the camera on it.
        if (onScanRef.current(result.data)) {
          doneRef.current = true
          stopCamera()
          return
        }
      }

      timerRef.current = setTimeout(scanFrame, 150)
    }

    start()
    return () => {
      mounted = false
      stopCamera()
    }
  }, [active, stopCamera])

  const digitalPreviewZoom = hardwareZoom ? 1 : zoom

  return (
    <div className="qr-scanner">
      {error && <p className="qr-scanner-error">{error}</p>}
      <video
        ref={videoRef}
        onClick={nudgeFocus}
        className="qr-scanner-video"
        style={{
          display: error ? 'none' : 'block',
          transform: digitalPreviewZoom > 1 ? `scale(${digitalPreviewZoom})` : undefined,
          cursor: active && !error ? 'crosshair' : undefined,
        }}
        playsInline
        muted
      />
      {active && !error && <div className="qr-scanner-frame" aria-hidden="true" />}
      {active && !error && zoomRange && (
        <div className="qr-scanner-zoom">
          <button
            type="button"
            className="qr-scanner-zoom-btn"
            onClick={() => stepZoom(-1)}
            aria-label="Zoom out"
            disabled={zoom <= zoomRange.min}
          >
            −
          </button>
          <input
            type="range"
            min={zoomRange.min}
            max={zoomRange.max}
            step={zoomRange.step}
            value={zoom}
            onChange={(e) => applyZoom(Number(e.target.value))}
            className="qr-scanner-zoom-range"
            aria-label="Camera zoom"
          />
          <button
            type="button"
            className="qr-scanner-zoom-btn"
            onClick={() => stepZoom(1)}
            aria-label="Zoom in"
            disabled={zoom >= zoomRange.max}
          >
            +
          </button>
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
}
