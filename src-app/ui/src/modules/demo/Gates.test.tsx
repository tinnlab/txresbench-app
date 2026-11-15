// @vitest-environment jsdom
/**
 * TEST-DM-5 (gates half) — DemoOnly / DesktopOnly + the useAppMode hook's
 * shape: the no-flash rule (unknown mode renders NEITHER face), demo renders
 * only the demo children, desktop renders only the desktop children.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useAppMode } from './useAppMode'
import { DemoOnly } from './components/DemoOnly'
import { DesktopOnly } from './components/DesktopOnly'
import { resetDemoMode, seedDemoMode } from './test-utils/demoSeed'

function Probe() {
  const mode = useAppMode()
  return (
    <output data-testid="probe">
      {mode.ready ? String(mode.mode) : 'unknown'}|
      {String(mode.isDemo)}|{String(mode.isDesktop)}|{mode.downloadUrl}|{mode.notice}
    </output>
  )
}

beforeEach(() => resetDemoMode())
afterEach(() => cleanup())

describe('DemoOnly / DesktopOnly (ITEM-5 gates)', () => {
  it('renders NEITHER gate while the boot read is pending (the no-flash rule)', () => {
    render(
      <>
        <DemoOnly><span data-testid="demo-child">demo</span></DemoOnly>
        <DesktopOnly><span data-testid="desktop-child">desktop</span></DesktopOnly>
      </>,
    )
    expect(screen.queryByTestId('demo-child')).toBeNull()
    expect(screen.queryByTestId('desktop-child')).toBeNull()
  })

  it('demo mode: DemoOnly renders, DesktopOnly does not', () => {
    seedDemoMode('demo')
    render(
      <>
        <DemoOnly><span data-testid="demo-child">demo</span></DemoOnly>
        <DesktopOnly><span data-testid="desktop-child">desktop</span></DesktopOnly>
      </>,
    )
    expect(screen.getByTestId('demo-child')).toBeTruthy()
    expect(screen.queryByTestId('desktop-child')).toBeNull()
  })

  it('desktop mode: DesktopOnly renders, DemoOnly does not', () => {
    seedDemoMode('desktop')
    render(
      <>
        <DemoOnly><span data-testid="demo-child">demo</span></DemoOnly>
        <DesktopOnly><span data-testid="desktop-child">desktop</span></DesktopOnly>
      </>,
    )
    expect(screen.queryByTestId('demo-child')).toBeNull()
    expect(screen.getByTestId('desktop-child')).toBeTruthy()
  })
})

describe('useAppMode (ITEM-5 context hook)', () => {
  it('is unknown (both isDemo and isDesktop false) while pending', () => {
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('unknown|false|false||')
  })

  it('carries the demo facts once the read settles', () => {
    seedDemoMode('demo', { downloadUrl: 'https://downloads.example.test/x', notice: 'n' })
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe(
      'demo|true|false|https://downloads.example.test/x|n',
    )
  })

  it('is desktop (and the url + notice are the empty desktop bytes) in desktop mode', () => {
    seedDemoMode('desktop')
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('desktop|false|true||')
  })
})
