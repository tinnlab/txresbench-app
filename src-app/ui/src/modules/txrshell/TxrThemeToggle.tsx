import { FiMoon, FiSun } from 'react-icons/fi'
import { Button } from '@txresbench/kit'
import { useTheme } from '@txresbench/shell'
import { useConfigClientStore } from '@/modules/config-client/ConfigClient.store'

/**
 * The theme switch button in the shell header (owner request 2026-11-09).
 *
 * It is NOT a second theme store: the preference IS the SDK shell's
 * `ConfigClient` store (light/dark/system — `sdk/packages/shell/src/theme/
 * ThemeProvider.tsx` reads `themePreference`, persists it through the
 * store's own storage and toggles the `dark`/`light` class on <html>).
 * This button only maps the RESOLVED theme to the toggle's semantics:
 * the first click from "system" lands on the opposite of what is shown now
 * (the store then holds an explicit light/dark, no longer system), and every
 * later click toggles explicit light ↔ dark. The choice therefore survives a
 * reload and an app restart (desktop included) through the one store.
 *
 * The button shows the CURRENT state (sun + "Light" / moon + "Dark"), while
 * the accessible name and the tooltip are the ACTION — "Switch to dark mode"
 * / "Switch to light mode" — so a screen-reader and a pointer user both hear
 * what clicking does. qa-fixes4 ITEM-5: the visible state text is INSIDE the
 * name as "(currently light)" / "(currently dark)" (the plan's words), so
 * when the label is not visible (the icon-only narrow header, below 700 px)
 * a screen reader still hears what a sighted user would have seen, and the
 * name CONTAINS the visible label (label-in-name, 2.5.3). The kit Button
 * carries the accessible name from the string `tooltip` (it shows on hover
 * AND keyboard focus) and the standard kit focus ring, the same ring every
 * kit control in the header's app uses.
 *
 * At the narrow widths the label collapses and the icon alone stays — the
 * same yield rule as the tagline, in index.css against the
 * `.txr-theme-toggle-*` hooks (a media query cannot touch an inline style).
 */

/** The theme a click switches to: the opposite of what is shown now. */
export function nextThemePreference(resolved: 'light' | 'dark'): 'light' | 'dark' {
  return resolved === 'dark' ? 'light' : 'dark'
}

export function TxrThemeToggle() {
  // `resolvedTheme` is the preference after the system fallback — the byte
  // this button must answer to (the plan's "the first click from 'system'
  // goes to the opposite of what is shown now").
  const { resolvedTheme } = useTheme()
  const setThemePreference = useConfigClientStore(s => s.setThemePreference)

  const dark = resolvedTheme === 'dark'
  const action = dark ? 'Switch to light mode' : 'Switch to dark mode'
  // qa-fixes4 ITEM-5 (the owner byte, help-r3): the accessible name
  // CONTAINS the visible label text — "Light"/"Dark" is what is shown, and
  // the name carries it as "(currently light)"/"(currently dark)" — the
  // plan's exact words (label-in-name 2.5.3; the old "(Light)" suffix read
  // as a name of a state, not the current one).
  const stateLabel = dark ? 'Dark' : 'Light'

  return (
    <Button
      data-testid="txr-theme-toggle"
      className="txr-theme-toggle"
      variant="ghost"
      tooltip={`${action} (currently ${stateLabel.toLowerCase()})`}
      icon={dark ? <FiMoon aria-hidden /> : <FiSun aria-hidden />}
      onClick={() => setThemePreference(nextThemePreference(resolvedTheme))}
      style={{
        color: 'var(--txr-text-2)',
        fontSize: 14,
        height: 'auto',
        padding: '6px 8px',
        borderRadius: 6,
      }}
    >
      <span className="txr-theme-toggle-label">{stateLabel}</span>
    </Button>
  )
}
