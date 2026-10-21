// TEST-9 (ITEM-8) — the workbenchRegistry singleton exposes all four registries.
//
// The count is the running record of how many contribution points have a real
// contributor. It was nine; ITEM-9 deleted `selectionActions` with the selection feature,
// and ITEM-33/34/35 deleted the five that had ZERO production contributors
// (`plotTypes` / `fieldProviders` / `resultRenderers` / `commands` / `collections`).
// ITEM-1 added `sections` (the Visualize-pane blocks) — the fourth, and a NEW slot
// rather than a reuse of `views`, so a section can never reach the docking path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workbenchRegistry, CONTRIBUTION_KINDS } from './workbenchRegistry.ts'
import { Registry } from './registry.ts'
import { KNOWN_CONTRIBUTES } from '../manifest/validate.ts'
import { defaultSafety } from './types.ts'

test('TEST-9: workbenchRegistry is a stable singleton with four distinct registries', () => {
  assert.equal(CONTRIBUTION_KINDS.length, 4)
  assert.deepEqual([...CONTRIBUTION_KINDS], ['analyses', 'views', 'statusBarItems', 'sections'])
  const seen = new Set<Registry<never>>()
  for (const kind of CONTRIBUTION_KINDS) {
    const reg = workbenchRegistry[kind]
    assert.ok(reg instanceof Registry, `${kind} is a Registry`)
    assert.equal(reg.name, kind)
    seen.add(reg as unknown as Registry<never>)
  }
  assert.equal(seen.size, 4, 'all four registries are distinct instances')
})

test('TEST-9: every registry kind is a known manifest contribution (drift guard, audit EXT-2)', () => {
  for (const kind of CONTRIBUTION_KINDS) {
    assert.ok(KNOWN_CONTRIBUTES.has(kind), `registry kind "${kind}" must be a known manifest contribution key`)
  }
})

test('TEST-9: a manifest may NOT declare a contribution the host has no registry for', () => {
  // The inverse of the drift guard above: the five deleted kinds are now UNKNOWN manifest
  // keys, so an extension declaring one is rejected rather than silently indexed.
  for (const gone of ['plotTypes', 'fieldProviders', 'resultRenderers', 'commands', 'collections']) {
    assert.equal(KNOWN_CONTRIBUTES.has(gone), false, `"${gone}" must not be a known contribution key`)
  }
})

test('TEST-9: defaultSafety is the single source for kind-defaults', () => {
  assert.equal(defaultSafety('analysis'), 'read-run')
})
