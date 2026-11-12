import { afterEach, describe, expect, it } from 'vitest'
import {
  clearScrollCache,
  getScrollPosition,
  saveScrollPosition,
  scrollCacheKey,
  scrollCacheSize,
} from './scrollCache'

/**
 * TEST-AS-1 (restore half) — the per-route scroll cache: an in-memory map
 * keyed by route + region label (a route with two regions needs two
 * entries), restored on Back, forgotten on reload (the cache is memory,
 * never storage).
 */
describe('scroll cache (TEST-AS-1)', () => {
  afterEach(() => clearScrollCache())

  it('keys by route pathname and the region label', () => {
    expect(scrollCacheKey('/study', 'Questionnaire')).toBe('/study#Questionnaire')
    expect(scrollCacheKey('/study', 'Methods that fit')).toBe(
      '/study#Methods that fit',
    )
    // The two regions of one route never collide; the same region on two
    // routes never mixes.
    expect(scrollCacheKey('/study', 'Questionnaire')).not.toBe(
      scrollCacheKey('/study', 'Methods that fit'),
    )
    expect(scrollCacheKey('/study', 'Questionnaire')).not.toBe(
      scrollCacheKey('/files', 'Questionnaire'),
    )
  })

  it('remembers a position per key and forgets nothing until cleared', () => {
    saveScrollPosition('/analysis/1/results#Patients', 438)
    expect(getScrollPosition('/analysis/1/results#Patients')).toBe(438)
    // A zero is remembered too (the user's explicit back-at-the-top).
    saveScrollPosition('/history#Runs', 0)
    expect(getScrollPosition('/history#Runs')).toBe(0)
    expect(getScrollPosition('/files#None')).toBeUndefined()
    expect(scrollCacheSize()).toBe(2)
    clearScrollCache()
    expect(scrollCacheSize()).toBe(0)
  })

  it('a later save replaces the earlier one (the route re-visit rule)', () => {
    saveScrollPosition('/help#Article', 100)
    saveScrollPosition('/help#Article', 620)
    expect(getScrollPosition('/help#Article')).toBe(620)
  })
})
