import { describe, expect, it } from 'vitest'
import {
  SHELL_MODE_MIN_HEIGHT,
  SHELL_MODE_MIN_WIDTH,
  SHELL_MODE_QUERY,
  resolveShellMode,
  shellModeClass,
} from './shellMode'

/**
 * TEST-AS-1 (mode half) — the shell-mode boundary as a pure function.
 * The browser tier (`txr-shell-primitives.spec.ts`) resizes the real
 * window; here the one truth of the boundary is pinned, and so is the
 * media expression the CSS document rules and the hook both answer.
 */
describe('shellMode (TEST-AS-1)', () => {
  it('keeps the audit\'s 768x520 boundary, inclusive on both axes', () => {
    expect(resolveShellMode(768, 520)).toBe('shell')
    expect(resolveShellMode(1440, 900)).toBe('shell')
    expect(resolveShellMode(1024, 768)).toBe('shell')
    // One axis below the bound flows (the audit's phone/web-demo byte).
    expect(resolveShellMode(767, 520)).toBe('flow')
    expect(resolveShellMode(768, 519)).toBe('flow')
    expect(resolveShellMode(390, 844)).toBe('flow')
  })

  it('declares the one query both halves follow, and the mode classes', () => {
    expect(SHELL_MODE_QUERY).toBe(
      `(min-width: ${SHELL_MODE_MIN_WIDTH}px) and (min-height: ${SHELL_MODE_MIN_HEIGHT}px)`,
    )
    expect(shellModeClass('shell')).toBe('txr-shell-mode-shell')
    expect(shellModeClass('flow')).toBe('txr-shell-mode-flow')
  })
})
