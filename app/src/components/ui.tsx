import { useEffect } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

// Base components for the Kindred design system (theme.css). Thin wrappers
// over plain classes so screens stay declarative and consistent. Deliberately
// no icon set bundled here — see Global Constraints: no shields, eyes, locks
// or magnifying-glass iconography anywhere in this app.

export function Screen({
  title,
  onBack,
  action,
  children,
}: {
  title: string
  onBack?: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="screen">
      <header className="topbar">
        {onBack && (
          <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
            ‹
          </button>
        )}
        <h1 className="topbar-title">{title}</h1>
        {action && <div className="topbar-action">{action}</div>}
      </header>
      <main className="screen-body">{children}</main>
    </div>
  )
}

export function Card({
  children,
  className = '',
  ...rest
}: {
  children: ReactNode
  className?: string
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {children}
    </div>
  )
}

export type ButtonVariant = 'primary' | 'quiet' | 'danger'

export function Button({
  variant = 'primary',
  block,
  className = '',
  children,
  ...rest
}: {
  variant?: ButtonVariant
  block?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`btn btn-${variant} ${block ? 'btn-block' : ''} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  )
}

export type PillTone = 'neutral' | 'good' | 'bad' | 'amber'

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}

export type BannerTone = 'info' | 'good' | 'bad'

export function Banner({ tone = 'info', children }: { tone?: BannerTone; children: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-sub">{children}</p>}
    </div>
  )
}

export function ListRow({
  title,
  sub,
  leading,
  trailing,
  onClick,
}: {
  title: ReactNode
  sub?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  onClick?: () => void
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className="row" onClick={onClick} type={onClick ? 'button' : undefined}>
      {leading}
      <span className="row-main">
        <span className="row-title">{title}</span>
        {sub && <span className="row-sub">{sub}</span>}
      </span>
      {trailing ?? (onClick ? (
        <span className="row-chevron" aria-hidden="true">
          ›
        </span>
      ) : null)}
    </Tag>
  )
}

// Bottom action sheet. Tapping the backdrop or pressing Escape closes it —
// callers own the open/closed state and pass `onClose`.
export function Sheet({
  title,
  onClose,
  children,
}: {
  title?: string
  onClose: () => void
  children: ReactNode
}) {
  // The caller mounts a Sheet only while it's open (no internal open state
  // here), so a listener bound for the component's lifetime is exactly the
  // "while open" window — cleaned up the moment it unmounts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="sheet-title">{title}</h2>}
        {children}
      </div>
    </div>
  )
}

// Big friendly number pad for a child's PIN (setting it, or unlocking with
// it) — see internal plan 2026-08-11-child-mode, Task 2. Purely
// a text-entry widget: it knows nothing about pinLock.ts, validation, or
// submission — callers (ChildOnboarding.tsx, ChildLock.tsx) own the
// value/onChange and decide when a length is "enough" to submit.
export function PinPad({
  value,
  onChange,
  maxLength = 8,
  disabled = false,
  label,
}: {
  value: string
  onChange: (next: string) => void
  maxLength?: number
  disabled?: boolean
  label?: string
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back']

  function press(digit: string) {
    if (disabled || value.length >= maxLength) return
    onChange(value + digit)
  }
  function backspace() {
    if (disabled) return
    onChange(value.slice(0, -1))
  }

  return (
    <div className="pin-pad" role="group" aria-label={label ?? 'PIN entry'}>
      <div className="pin-pad-dots" aria-hidden="true">
        {Array.from({ length: Math.max(value.length, 4) }, (_, i) => (
          <span key={i} className={`pin-pad-dot ${i < value.length ? 'pin-pad-dot-filled' : ''}`} />
        ))}
      </div>
      <div className="pin-pad-grid">
        {keys.map((key, i) => {
          if (key === '') return <span key={i} className="pin-pad-spacer" aria-hidden="true" />
          if (key === 'back') {
            return (
              <button
                key={i}
                type="button"
                className="pin-pad-key pin-pad-key-back"
                onClick={backspace}
                disabled={disabled || value.length === 0}
                aria-label="Delete last digit"
              >
                ⌫
              </button>
            )
          }
          return (
            <button
              key={i}
              type="button"
              className="pin-pad-key"
              onClick={() => press(key)}
              disabled={disabled || value.length >= maxLength}
              aria-label={`Digit ${key}`}
            >
              {key}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Numeric stepper with +/- controls. Long-press-to-repeat is explicitly not
// required (see Task 1 gate) — a single tap changes the value by `step`.
export function Stepper({
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  onChange,
  format,
  label,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (next: number) => void
  format?: (value: number) => string
  label?: string
}) {
  const dec = () => onChange(Math.max(min, value - step))
  const inc = () => onChange(Math.min(max, value + step))
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper-btn"
        onClick={dec}
        disabled={value <= min}
        aria-label="Decrease"
      >
        −
      </button>
      <span className="stepper-value">{format ? format(value) : value}</span>
      <button
        type="button"
        className="stepper-btn"
        onClick={inc}
        disabled={value >= max}
        aria-label="Increase"
      >
        +
      </button>
    </div>
  )
}
