import './polyfills' // crypto.randomUUID fallback for plain-HTTP LAN contexts — MUST be first
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import { AppErrorBoundary } from '@ziee/shell'
import { installChunkLoadRecovery } from '@ziee/framework/chunk-recovery'
import { installAccountHeaderStamping } from '@/core/sync/installAccountHeader'
import '@/index.css'

// Stamp the active-account header (X-Account-Id) on same-origin requests when an org
// has been switched to (app-side; the SDK exposes no header hook). A pure no-op for
// solo/desktop users, whose switcher never sets the holder. See its module header.
installAccountHeaderStamping()

// Code-split chunk failure recovery. A deploy while this tab is open invalidates
// every hashed chunk URL the loaded page still holds, so a lazy surface 404s.
// Installs a `vite:preloadError` OBSERVER that logs the failure once and marks
// the page as running against a stale build — which is what lets a user-facing
// error say "the app may have been updated, reload".
//
// It deliberately does NOT `preventDefault()` the event and does NOT reload the
// page; see the header of `@ziee/framework/chunk-recovery` for why each of those
// would be actively harmful (preventDefault makes the failed import RESOLVE with
// `undefined`; auto-reload destroys unsent in-progress work).
installChunkLoadRecovery()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary
      label="root"
      fallback={(error, reset) => (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100dvh',
            padding: 24,
            gap: 16,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 24 }}>Something went wrong</h1>
          {/* bootstrap/crash-fallback: self-contained inline colors, must not depend on the token CSS pipeline */}
          <p data-allow-custom-color style={{ margin: 0, color: '#666', maxWidth: 480, textAlign: 'center' }}>
            The application encountered an unexpected error. You can try
            again, or reload the page if the problem persists.
          </p>
          {/* bootstrap/crash-fallback: self-contained inline colors, must not depend on the token CSS pipeline */}
          <pre
            data-allow-custom-color
            style={{
              margin: 0,
              padding: 12,
              background: '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: 4,
              fontSize: 12,
              maxWidth: 600,
              overflow: 'auto',
            }}
          >
            {error.message}
          </pre>
          <div style={{ display: 'flex', gap: 12 }}>
            {/* biome-ignore lint: root crash-fallback must be self-contained (inline styles, no kit/theme/CSS dependency) so it still renders when the design system is what failed */}
            <button
              onClick={reset}
              data-allow-custom-color
              style={{
                padding: '8px 16px',
                border: '1px solid #1677ff',
                borderRadius: 4,
                background: '#1677ff',
                color: 'white',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            {/* biome-ignore lint: root crash-fallback must be self-contained (inline styles, no kit/theme/CSS dependency) so it still renders when the design system is what failed */}
            <button
              onClick={() => window.location.reload()}
              data-allow-custom-color
              style={{
                padding: '8px 16px',
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                background: 'white',
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      )}
    >
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)
