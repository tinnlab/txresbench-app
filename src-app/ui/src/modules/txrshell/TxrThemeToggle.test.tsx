// @vitest-environment jsdom
/**
 * TEST-QF2-1 (unit half) — the shell theme switch (qa-fixes2 ITEM-1).
 *
 * The toggle's logic is one pure mapping + one write: `nextThemePreference`
 * maps the RESOLVED theme (the preference after the system fallback) to the
 * theme a click switches to, and the onClick writes THAT value to the app's
 * one ConfigClient store (DEC-4: no second theme store — the SDK
 * ThemeProvider persists and applies it). The plan's first-click rule falls
 * out of the mapping: from "system", the first click writes the opposite of
 * what is currently shown, making the preference explicit.
 *
 * jsdom cannot render the kit Tooltip's hover layer or the real ThemeProvider
 * (matchMedia + the kit Toaster), so the provider half is driven through the
 * SDK's own `ThemeContext` with a value a real provider would compute, and the
 * coin-flip logic + copy + store write are asserted here; the real-app flip
 * (`html.dark`), reload persistence, every-route presence and the 390 px
 * label collapse are the browser arm (`tests/e2e/txr-theme-toggle.spec.ts`,
 * TEST-QF2-1's gallery/phone arms in `tests/gallery-e2e/txr-theme-phone.spec.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ThemeContext, type ThemeContextValue } from '@ziee/shell'
import { useConfigClientStore } from '@/modules/config-client/ConfigClient.store'
import { TxrThemeToggle, nextThemePreference } from './TxrThemeToggle'

afterEach(() => {
  cleanup()
})

function withResolved(resolvedTheme: 'light' | 'dark') {
  const value: ThemeContextValue = {
    selectedTheme: 'system',
    resolvedTheme,
    isDarkMode: resolvedTheme === 'dark',
    setTheme: useConfigClientStore.getState().setThemePreference,
  }
  return render(
    <ThemeContext.Provider value={value}>
      <TxrThemeToggle />
    </ThemeContext.Provider>,
  )
}

describe('nextThemePreference (TEST-QF2-1)', () => {
  it('maps the resolved theme to the opposite — and from system the first click goes to the opposite of what is shown', () => {
    // The four states a resolved theme can be in: system→dark, system→light,
    // explicit dark, explicit light. The mapping is the same for all four
    // because the button answers to what is SHOWN, not to the preference.
    expect(nextThemePreference('dark')).toBe('light')
    expect(nextThemePreference('light')).toBe('dark')
    // The plan's first-click-from-system rule is exactly this mapping on the
    // resolved theme (system itself is never written by the toggle).
    expect(nextThemePreference('dark')).not.toBe('system')
    expect(nextThemePreference('light')).not.toBe('system')
  })
})

describe('TxrThemeToggle (TEST-QF2-1)', () => {
  it('shows the CURRENT state: moon + "Dark" when dark, sun + "Light" when light', () => {
    const dark = withResolved('dark')
    expect(screen.getByTestId('txr-theme-toggle').textContent).toContain('Dark')
    expect(dark.container.querySelector('svg')).not.toBeNull()
    dark.unmount()

    const light = withResolved('light')
    expect(screen.getByTestId('txr-theme-toggle').textContent).toContain('Light')
    expect(light.container.querySelector('svg')).not.toBeNull()
  })

  it('carries the ACTION as the accessible name and tooltip copy: "Switch to dark/light mode"', () => {
    // The state label is visible text; the accessible name is the action (the
    // kit Button promotes a string `tooltip` to `aria-label`, shown on hover
    // AND keyboard focus).
    const dark = withResolved('dark')
    expect(screen.getByTestId('txr-theme-toggle').getAttribute('aria-label')).toBe(
      'Switch to light mode',
    )
    dark.unmount()

    const light = withResolved('light')
    expect(screen.getByTestId('txr-theme-toggle').getAttribute('aria-label')).toBe(
      'Switch to dark mode',
    )
  })

  it('writes the opposite-of-resolved preference to the ONE ConfigClient store on click', () => {
    // Start from a known state (the store's default is 'system').
    act(() => useConfigClientStore.getState().setThemePreference('system'))
    const view = withResolved('light') // system currently resolves to light
    fireEvent.click(screen.getByTestId('txr-theme-toggle'))
    expect(useConfigClientStore.getState().themePreference).toBe('dark')
    view.unmount()

    // And from dark: the click writes 'light' (the explicit state, not system).
    const darkView = withResolved('dark')
    fireEvent.click(screen.getByTestId('txr-theme-toggle'))
    expect(useConfigClientStore.getState().themePreference).toBe('light')
    darkView.unmount()
  })
})
