/**
 * ITEM-2 (c) — the run-bar copy layer (`lib/runBar.ts`): the plan's bar
 * sentence ("6 methods selected · about 2 min (3 at a time on 8 CPUs)") is
 * the count + the estimate's short-form total + the lane facts; the Auto
 * CPU choice names the lanes only (the count resolves at run start); the
 * disabled reason, the save switch's meaning and the More-settings facts
 * are the items' constants. No timing is derived here (INV-4 — the total
 * is the estimate response's bytes).
 */
import { describe, expect, it } from 'vitest'
import {
  ESTIMATE_EXPLAINED,
  FIXED_SEED_FACT,
  RUN_BAR_EMPTY_REASON,
  SAVE_MODELS_MEANING,
  formatRunBarTime,
} from './runBar'

describe('formatRunBarTime (ITEM-2 c)', () => {
  it('the plan\u2019s sentence: short total + the lanes in parentheses', () => {
    expect(formatRunBarTime(120, 3, 8)).toBe('about 2 min (3 at a time on 8 CPUs)')
    expect(formatRunBarTime(840, 3, 8)).toBe('about 14 min (3 at a time on 8 CPUs)')
  })

  it('the Auto CPU choice names the lanes only (no machine fact the screen did not measure)', () => {
    expect(formatRunBarTime(120, 3, null)).toBe('about 2 min (3 at a time)')
  })

  it('a null total is the loading ellipsis', () => {
    expect(formatRunBarTime(null, 3, 8)).toBe('…')
  })

  it('the sub-minute form reads "under 1 min"', () => {
    expect(formatRunBarTime(45, 3, 8)).toBe('under 1 min (3 at a time on 8 CPUs)')
  })
})

describe('the ITEM-2 bar constants', () => {
  it('the disabled reason, the save meaning and the More-settings facts are the plan\u2019s words', () => {
    expect(RUN_BAR_EMPTY_REASON).toBe('Select at least one method')
    expect(SAVE_MODELS_MEANING).toContain('reuse it on new patients')
    expect(ESTIMATE_EXPLAINED).toContain('scaled to your file')
    expect(FIXED_SEED_FACT).toContain('fixed seed')
  })
})
