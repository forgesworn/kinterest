import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'

interface ErrorBoundaryState {
  hasError: boolean
}

/** A minimal, app-level safety net — see `screens/settingsForms.ts`'s
 *  `MAX_BPS` cap and `store/scheduler.ts`'s own per-config `try/catch` for
 *  the two defence-in-depth layers this backstops (found by review: an
 *  unbounded interest rate could reach `domain/interest.ts#interestMinor`'s
 *  overflow `RangeError` from either place, and with NO error boundary
 *  anywhere, that unmounted the whole tree — the guardian app "bricked"
 *  until manual `localStorage` surgery). Even with both of those layers in
 *  place, a FUTURE render throw anywhere else in the tree must degrade to a
 *  calm, on-brand "something went wrong" card rather than a white screen —
 *  React only supports error boundaries as class components (no hook
 *  equivalent exists), hence the one class component in an otherwise
 *  all-function-component codebase. Reuses the existing `.screen`/`.card`
 *  kit classes (`theme.css` is a static stylesheet import, unaffected by
 *  whatever crashed) rather than inventing bespoke fallback markup. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown): void {
    // Logged, not swallowed silently — a caught crash is still a bug worth
    // finding via the console, it just must never take the whole app down
    // with it (Global Constraints has no rule against console.error itself,
    // only against secrets ever reaching it).
    console.error('Jar: unhandled render error', error)
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="screen">
        <main className="screen-body" style={{ display: 'flex', alignItems: 'center', minHeight: '100dvh' }}>
          <div className="card" style={{ width: '100%', textAlign: 'center' }}>
            <p className="empty-title">Something went wrong</p>
            <p className="empty-sub">Please restart the app.</p>
          </div>
        </main>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
