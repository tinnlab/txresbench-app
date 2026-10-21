import { describe, it, expect } from 'vitest'
import { Permissions } from '@/api-client/permissions'
import {
  regionForRole,
  ROLE_REGION,
  assertContributableArea,
  PANE_KIND_PERMISSION,
  SURFACE_ROLES,
} from './regionModel'

// declarative-canvas-plots ITEM-14/15 (TEST-15) — the surface ROLE → region placement contract,
// and the LOUD rejection of a contributed `area: center` (the center is reserved for the canvas).

describe('role → region placement (ITEM-15 / DEC-11)', () => {
  it('maps plot→center(canvas), control/run→right, output/report→bottom, inspect→left', () => {
    expect(regionForRole('plot')).toBe('center') // the canvas grid
    expect(regionForRole('control')).toBe('right')
    expect(regionForRole('run')).toBe('right')
    expect(regionForRole('output')).toBe('bottom')
    expect(regionForRole('report')).toBe('bottom')
    expect(regionForRole('inspect')).toBe('left')
  })

  it('the role map is total over the fixed role set', () => {
    for (const role of SURFACE_ROLES) expect(ROLE_REGION[role]).toBeDefined()
  })
})

describe('assertContributableArea — center is reserved for the canvas (ITEM-14)', () => {
  it('REJECTS a contributed area: center LOUD (no view tab beside the canvas)', () => {
    expect(() => assertContributableArea('center')).toThrow(/center/)
  })

  it('accepts left / right / bottom unchanged', () => {
    expect(assertContributableArea('left')).toBe('left')
    expect(assertContributableArea('right')).toBe('right')
    expect(assertContributableArea('bottom')).toBe('bottom')
  })

  it('rejects an out-of-vocabulary area', () => {
    expect(() => assertContributableArea('floating')).toThrow(/out-of-vocabulary/)
  })
})

// R6-E3 — `PANE_KIND_PERMISSION` is the "+"-menu / centre-picker half of the R4C-05
// provenance gate (`RegionShell.usePermittedAddablePaneKinds` filters `ADDABLE_PANE_KINDS`
// through it). Emptying the map left the whole ui vitest suite green — only an e2e spec
// covered it. This is the unit backstop for the map's one entry.
describe('PANE_KIND_PERMISSION — the addable-pane permission gate (R4C-05)', () => {
  it('gates the reproducibility pane kind on provenance::read', () => {
    expect(PANE_KIND_PERMISSION.reproducibility).toBe(Permissions.ProvenanceRead)
  })
})
