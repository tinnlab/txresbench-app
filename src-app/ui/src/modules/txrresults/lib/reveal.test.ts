// @vitest-environment jsdom
//
// TEST-UR-9 (ITEM-10) — the folder-reveal seam (PROV-UR-7 / DEC-9, INV-6,
// EXAMPLE-UR-5): `revealRunDir` invokes `reveal_in_file_manager` with the
// run's directory (the engine's `TxrRunDetail.dir`, passed as DATA through
// the `{path}` argument) ONLY when `isDesktop()` is true and nothing at all
// when false (the pure `@/core/platform` gate tested both ways — the web
// mode never touches the Tauri bridge); a rejection resolves silently to
// the path-only rendering (a missing folder or an unavailable file manager
// never takes the board down); a missing Tauri bridge resolves as a no-op.
// The helper is re-exported by the module barrel (PROV-UR-9, GAP-HIST-4).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revealRunDir } from './reveal'

const platform = vi.hoisted(() => ({ desktop: false }))
vi.mock('@/core/platform', () => ({
  isDesktop: () => platform.desktop,
  isWeb: () => !platform.desktop,
}))

/** The barrel re-export — the seam's public surface (PROV-UR-9). */
const { revealRunDir: fromBarrel } = await import('../index')

function installTauri(invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  const global = window as unknown as { __TAURI__?: unknown }
  global.__TAURI__ = { core: { invoke } }
  return () => {
    delete global.__TAURI__
  }
}

describe('revealRunDir (TEST-UR-9)', () => {
  beforeEach(() => {
    platform.desktop = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('invokes the desktop command with the run dir only under isDesktop()', async () => {
    platform.desktop = true
    const invoke = vi.fn().mockResolvedValue(undefined)
    const uninstall = installTauri(invoke)
    await revealRunDir('/home/owner/.txresbench/analysis-run-1')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('reveal_in_file_manager', {
      path: '/home/owner/.txresbench/analysis-run-1',
    })
    uninstall()
  })

  it('does nothing at all in web mode — the path-only rendering stays', async () => {
    platform.desktop = false
    const invoke = vi.fn()
    const uninstall = installTauri(invoke)
    await revealRunDir('/home/owner/.txresbench/analysis-run-1')
    expect(invoke).not.toHaveBeenCalled()
    uninstall()
  })

  it('swallows a rejection to the path-only rendering (a failed open is never a crash or a status)', async () => {
    platform.desktop = true
    const invoke = vi.fn().mockRejectedValue(new Error('no file manager on this system'))
    const uninstall = installTauri(invoke)
    await expect(revealRunDir('/home/owner/.txresbench/analysis-run-1')).resolves.toBeUndefined()
    uninstall()
  })

  it('resolves as a no-op when the Tauri bridge is absent even under isDesktop()', async () => {
    platform.desktop = true
    await expect(revealRunDir('/home/owner/.txresbench/analysis-run-1')).resolves.toBeUndefined()
  })

  it('is re-exported from the module barrel (GAP-HIST-4 — a missing re-export fails this test)', () => {
    expect(fromBarrel).toBe(revealRunDir)
  })
})
