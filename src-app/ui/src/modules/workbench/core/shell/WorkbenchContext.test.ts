// TEST-314 (ITEM-28) — `backendArch` on `WorkbenchContextValue` feeds
// `computeAvailabilityWithArch` so an arch-unsupported analysis resolves to
// arch-disabled (LISTED, disabled — never hidden). The runner is node-env (no DOM),
// so this pins the wiring at the value level: the same `backendArch` the provider
// exposes, run through the shared arch lens (the exact call the LauncherPane makes via
// `rowAvailability`).

import { describe, expect, it } from 'vitest'
import {
  computeAvailabilityWithArch,
  type AnalysisContribution,
  type DatatypeLattice,
  type WhenContext,
} from '@/modules/workbench/core'
import { DEFAULT_BACKEND_ARCH } from './WorkbenchContext'
import { rowAvailability } from '../../extensions/analysis/launcherAvailability'

const lattice: DatatypeLattice = {
  isA: (sub, sup) => sub === sup,
  matches: (id, sel) => id === sel.type_id || id === sel.subtypes_of,
  get: () => undefined,
}
const ctx: WhenContext = { producedTypeIds: [] }

const x86Only = {
  id: 'cellranger.count',
  extensionId: 'test',
  apiVersion: '^1.0',
  title: 'Cell Ranger',
  category: 'alignment',
  appliesTo: [],
  produces: [],
  run: { kind: 'sandbox', runtime: 'bash', entry: 'run.sh' },
  arch: ['x86_64'],
} as AnalysisContribution

describe('backendArch → computeAvailabilityWithArch (TEST-314)', () => {
  it('default backend arch is a valid BackendArch', () => {
    expect(DEFAULT_BACKEND_ARCH).toBe('x86_64')
  })

  it('an x86-only analysis resolves arch-disabled on an aarch64 backend', () => {
    const verdict = computeAvailabilityWithArch(x86Only, ctx, lattice, 'aarch64')
    expect(verdict).toEqual({ available: true, runnable: false, reason: expect.stringContaining('x86_64') })
    // …and the LauncherPane row mirror (arch-disabled, still listed).
    expect(rowAvailability(x86Only, ctx, lattice, 'aarch64').status).toBe('arch-disabled')
  })

  it('the same analysis is runnable on the default (x86_64) backend', () => {
    expect(rowAvailability(x86Only, ctx, lattice, DEFAULT_BACKEND_ARCH).status).toBe('available')
  })
})
