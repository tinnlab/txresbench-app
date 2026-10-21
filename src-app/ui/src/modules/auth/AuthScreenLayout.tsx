import { useLayoutEffect } from 'react'
import { useMetaThemeColor } from '@ziee/shell'
import { AuthThemeToggle } from './AuthThemeToggle'
import authCloudsUrl from './auth-clouds.webp'

interface AuthScreenLayoutProps {
  children: React.ReactNode
}

// Paper-cut cloudy backdrop — one raster illustration (navy sky → slate layers →
// white front cloud). Raster, not vector: no stair-steps, scales cheaply on
// resize. Dark mode reuses the SAME image and lays a themed darkening layer over
// it. Both the solid fallback AND the darkening layer are tinted from the
// `--auth-backdrop` token so the backdrop edge color follows the theme (and drives
// the iOS status/nav-bar tint via useMetaThemeColor below) — no raw hex.
function AuthBackdrop() {
  return (
    <>
      <div
        aria-hidden
        data-allow-custom-color
        className="pointer-events-none absolute inset-0 -z-0 bg-cover bg-bottom bg-no-repeat"
        style={{
          backgroundColor: 'var(--auth-backdrop)',
          backgroundImage: `url(${authCloudsUrl})`,
        }}
        data-testid="auth-screen-backdrop"
      />
      {/* dark-mode image-darkening layer, tinted with the themed backdrop token */}
      <div
        aria-hidden
        data-allow-custom-color
        className="pointer-events-none absolute inset-0 -z-0 hidden opacity-60 dark:block"
        style={{ backgroundColor: 'var(--auth-backdrop)' }}
      />
    </>
  )
}

/**
 * The single unauthenticated-screen chrome, shared by the login (`AuthPage`) and
 * first-run setup (`SetupPage`) pages so they render as visual twins. Provides:
 *   - the themed cloud backdrop (adapts light/dark),
 *   - the before-sign-in theme toggle (top-right),
 *   - the `main` landmark (these pages render outside the app shell that normally
 *     supplies one),
 *   - `meta[theme-color]` synced to the backdrop edge color (`--auth-backdrop`),
 *   - a synchronous root-background guard to avoid a mount/teardown flash,
 *   - the centered, mobile-safe content container (`w-full max-w-md`).
 *
 * Folds in what `BlankLayout` used to provide for these routes (main landmark +
 * meta-color + flash guard) so neither page needs a separate layout wrapper.
 */
export function AuthScreenLayout({ children }: AuthScreenLayoutProps) {
  // The backdrop paints --auth-backdrop to the edges → match the iOS bars to it.
  useMetaThemeColor('--auth-backdrop')

  // useLayoutEffect (not useEffect) so the background is applied AND restored
  // synchronously before paint — with useEffect the change lands a frame late,
  // producing a visible flash on mount and teardown. Mirrors BlankLayout.
  useLayoutEffect(() => {
    const root = document.documentElement
    const prev = root.style.backgroundColor
    root.style.backgroundColor = 'var(--auth-backdrop)'
    return () => {
      root.style.backgroundColor = prev
    }
  }, [])

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
      <AuthBackdrop />
      <AuthThemeToggle />
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </main>
  )
}
