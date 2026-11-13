// @vitest-environment jsdom
/**
 * TEST-QF4-1 (ITEM-1, UI half) — the `safeText` guard: the UI-side second
 * line behind the server's API-boundary sanitiser. A rendered reason /
 * message carrying an absolute path of the common roots or the
 * `<app_data>` placeholder is NEVER rendered: the formatters that consume
 * provider text pass the detail through `safeText`, so the guard's contract
 * here is (a) detect every pinned pattern, (b) return the generic sentence
 * on a hit and (c) leave clean text alone (no false positive on the normal
 * reason vocabulary).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  INTERNAL_PATH,
  INTERNAL_PLACEHOLDER,
  SAFE_TEXT_GENERIC,
  isInternalText,
  safeText,
} from './safeText'

describe('isInternalText (TEST-QF4-1)', () => {
  it('matches the plan\'s absolute-path pattern at a word start', () => {
    expect(isInternalText('/data/txr/analysis-1')).toBe(true)
    expect(isInternalText('Saved in /home/u1/.txresbench/analysis-1')).toBe(true)
    expect(isInternalText('failed: /var/lib/txr/models/m.txr is gone')).toBe(true)
    expect(isInternalText('read /usr/share/txr/config.toml: no such file')).toBe(true)
    expect(isInternalText('a /tmp/txr-envs cache problem')).toBe(true)
    expect(isInternalText('stored under /opt/txresbench/app-data')).toBe(true)
  })

  it('does not match import-ish or word-embedded occurrences', () => {
    expect(isInternalText('from \'@/data/useModelInventory\'')).toBe(false)
    expect(isInternalText('../data/useModelInventory')).toBe(false)
  })

  it('matches the <app_data> placeholder', () => {
    expect(isInternalText('oras is not installed (looked in <app_data>/bin and PATH)')).toBe(true)
    expect(INTERNAL_PLACEHOLDER.test('<app_data>')).toBe(true)
  })

  it('clean provider text passes unchanged', () => {
    expect(isInternalText('LDH is not in your measurements')).toBe(false)
    expect(isInternalText('no published environment for method "x"')).toBe(false)
    expect(isInternalText('stopped by the user')).toBe(false)
    expect(isInternalText('')).toBe(false)
  })

  it('the patterns are the plan\'s own bytes', () => {
    expect(String(INTERNAL_PATH)).toBe('/((^|\\s)\\/(data|home|usr|var|tmp|opt)\\/)/i')
  })
})

describe('safeText (TEST-QF4-1)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeEach(() => {
    warn.mockClear()
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('refuses internal text with the generic sentence (and warns in dev)', () => {
    expect(safeText('oras is not installed (looked in <app_data>/bin and PATH)')).toBe(
      SAFE_TEXT_GENERIC,
    )
    expect(safeText('read /data/txr/models/m.txr failed')).toBe(SAFE_TEXT_GENERIC)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('returns clean text verbatim, with no warning', () => {
    expect(safeText('LDH is not in your measurements')).toBe('LDH is not in your measurements')
    expect(safeText('')).toBe('')
    expect(warn).not.toHaveBeenCalled()
  })
})
