import { Sun, Moon } from 'lucide-react'
import { Button } from '@ziee/kit'
import { useTheme } from '@ziee/shell'

/**
 * Light/dark toggle for the unauthenticated screens (login + setup) — the ONE
 * place a signed-out user can flip the theme. Deliberately reuses the app's
 * existing theme mechanism (`useTheme()` → `ConfigClient` → `ThemeProvider`
 * toggles the `dark`/`light` class on <html>); it does NOT hand-roll its own
 * theming. Ported in behavior from the former page-local `SetupThemeSwitcher`
 * so both screens share one implementation and one testid.
 *
 * `size-11` (44px) overrides the kit's `size="icon"` (32px) so the tap target
 * meets the mobile touch-target guideline — this control is the primary
 * pre-sign-in affordance on a phone.
 */
export function AuthThemeToggle() {
  const { isDarkMode, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      // ONE string, `tooltip`, not a matching pair: the kit adopts a string tooltip as the
      // aria-label, so the hover text and the accessible name cannot drift apart. A sun/moon
      // glyph is not self-explaining — half the point of this control is which way it goes.
      tooltip={isDarkMode ? 'Switch to light theme' : 'Switch to dark theme'}
      data-testid="auth-theme-toggle"
      className="absolute end-4 top-4 z-20 size-11"
      onClick={() => setTheme(isDarkMode ? 'light' : 'dark')}
    >
      {isDarkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </Button>
  )
}
