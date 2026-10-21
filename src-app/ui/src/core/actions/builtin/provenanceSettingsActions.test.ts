// TEST-7 (#49) — the provenance.updateSettings admin settings-save mutation is a permissioned defineAction
// dispatched via runAction in its settings page (not a human-only form submit), with the
// exact permission that gates the settings PUT.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './provenanceSettingsActions' // register
import { getActionMeta, getActionRegistry } from '../defineAction'

const ID = 'provenance.updateSettings'
const PERMISSION = 'provenance::settings::manage'
const COMPONENT = 'src/modules/provenance/components/ProvenanceSettingsCard.tsx'

describe('TEST-7 — provenance.updateSettings is a permissioned, AI-drivable settings defineAction', () => {
  it('is registered, mutating, AI-surfaced with the exact permission', () => {
    const meta = getActionMeta(ID)
    expect(meta, ID + ' not registered').toBeTruthy()
    expect(meta?.permission).toBe(PERMISSION)
    expect(meta?.mutating).toBe(true)
    expect(meta?.surfaces?.ai).not.toBe(false)
  })
  it('is dispatched via runAction in its settings page', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')
    expect(src).toContain("runAction('" + ID + "'")
  })

  // TEST-12 (#54) — the GC knobs are part of the action's typed param surface, so a save
  // (and an AI/palette invocation) can set them; each is an optional integer.
  it('accepts the rootfs-GC knobs as optional integer params, rejecting non-integers', () => {
    const schema = getActionRegistry().get(ID)?.params
    expect(schema, 'params schema present').toBeTruthy()
    // Both GC knobs accepted together.
    expect(
      schema!.safeParse({ rootfs_gc_interval_secs: 3600, rootfs_cache_max_digests: 8 }).success,
    ).toBe(true)
    // Omitting them is valid (partial update).
    expect(schema!.safeParse({}).success).toBe(true)
    // A non-integer interval is rejected.
    expect(schema!.safeParse({ rootfs_gc_interval_secs: 1.5 }).success).toBe(false)
    expect(schema!.safeParse({ rootfs_cache_max_digests: 'lots' }).success).toBe(false)
  })

  // TEST-13 support — the card wires the GC controls through the SAME permissioned action,
  // not an inline handler (ai-controllable-actions).
  it('the card sends the GC fields through the action payload', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')
    expect(src).toContain('rootfs_gc_interval_secs:')
    expect(src).toContain('rootfs_cache_max_digests:')
  })
})
