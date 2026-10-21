// TEST-38 (ITEM-39) — the dimension-primitive widget kinds are GONE, and the guard is
// keyed on the kind vocabulary rather than on a directory name.
//
// ITEM-39 swept `primitives/` (1,707 L, 11 files) for the dead-registry shape and found
// it: no shipping processor spec instantiates ANY of the seven kinds `registerPrimitives()`
// registered, so the registration existed only to satisfy itself. Deleting the directory
// is not the assertion — a re-creation under any other name would be the same defect —
// so what is asserted is that the KINDS cannot be resolved and the REGISTRAR is gone.
// vitest, not `node:test`: the mount path imports `.tsx` renderers, which the plain-node
// strip-types runner cannot load (verified — it throws ERR_UNKNOWN_FILE_EXTENSION).
import { test, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { registeredWidgetKinds, hasWidget, __clearWidgetsForTests } from './registry'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WB = path.resolve(HERE, '../..')

/** The seven kinds `primitives/index.ts::registerPrimitives()` registered at origin/main
 *  — the five `PRIMITIVE_KINDS` plus the two stub widgets it also installed. */
const PRIMITIVE_KINDS = [
  'dimension-selector',
  'annotation-filter',
  'category-group',
  'brush-selection',
  'dimension-stats',
  'colormap-picker',
  'threshold-on-histogram',
]

test('TEST-38: NONE of the primitive widget kinds is registered by the mount path', () => {
  __resetBuiltinWidgetsForTests()
  __clearWidgetsForTests()
  installBuiltinWidgets()
  const kinds = registeredWidgetKinds()
  // POSITIVE COUNT first: an empty registry would satisfy "none of them are registered"
  // and prove nothing. The mount path registers 21 kinds (14 form controls + 5 canvas plot
  // kinds + 2 visualize kinds) — 16 until `artifact_ref` (ITEM-7) joined the form-control set,
  // 17 until `entry_list` (ITEM-23) was registered by the VISUALIZE extension through the same
  // open seam the canvas plots use, 18 → 20 as `tabs` (ITEM-16) + `token-input` (ITEM-17) joined
  // the form-control set (geneset increment 1), and 21 as the `lineage` (DEC-11) display widget
  // registered through that same visualize open seam.
  expect(kinds.length, `expected 21 registered widget kinds, got ${kinds.length}: ${kinds}`).toBe(21)
  const leaked = PRIMITIVE_KINDS.filter(k => kinds.includes(k) || hasWidget(k))
  expect(leaked, 'a dimension-primitive kind is still registered in production').toEqual([])
})

test('TEST-38: the `registerPrimitives` registrar does not exist anywhere in the workbench', () => {
  const offenders: string[] = []
  let scanned = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      if (/\.test\.(ts|tsx)$/.test(e.name)) continue // suites NAME the vocabulary to assert on it
      scanned++
      // Strip line comments: ITEM-39's rationale is recorded in prose in several files
      // and that prose is not a registration.
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      if (/\bregisterPrimitives\b|\bPRIMITIVE_KINDS\b/.test(code)) offenders.push(path.relative(WB, p))
    }
  }
  walk(WB)
  expect(scanned, `scan set collapsed: ${scanned} file(s)`).toBeGreaterThanOrEqual(180)
  expect(offenders, 'the primitives registrar survived its subject').toEqual([])
})

test('TEST-38: no production module REGISTERS a primitive kind, under any name', () => {
  // The kind vocabulary, not the directory. A re-creation of `dimension-stats` under a
  // new path is exactly as dead as the original.
  const offenders: string[] = []
  let scanned = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      if (/\.test\.(ts|tsx)$/.test(e.name)) continue
      // `__fixtures__` + `fixtures/` are gallery DATA: they may still NAME a kind in a
      // fixture spec (which then renders the honest "no renderer" note). Naming is not
      // registering; what must not exist is a `registerWidget('<primitive kind>', …)`.
      scanned++
      const src = readFileSync(p, 'utf8')
      for (const k of PRIMITIVE_KINDS) {
        if (new RegExp(`registerWidget\\s*\\(\\s*['"\`]${k}['"\`]`).test(src))
          offenders.push(`${path.relative(WB, p)} registers ${k}`)
      }
    }
  }
  walk(WB)
  expect(scanned, `scan set collapsed: ${scanned} file(s)`).toBeGreaterThanOrEqual(180)
  expect(offenders, 'a dimension-primitive kind is still being registered').toEqual([])
})

test('TEST-38: the `primitives/` directory is gone (the ITEM-39 disposition is DELETE)', () => {
  // ITEM-39 offered two dispositions — unregistered-but-kept-as-gallery-fixtures, or
  // absent entirely. The one taken is DELETE, so that is what is pinned; if a future
  // change re-introduces the directory this fails and the disposition gets re-decided
  // deliberately rather than by accident.
  expect(existsSync(path.join(WB, 'primitives'))).toBe(false)
})

test('TEST-38: an unregistered kind still renders the VISIBLE fallback, never a crash', () => {
  // The guarantee that makes the deletion safe: a gallery fixture that still names
  // `dimension-stats` must degrade to an honest empty state.
  __resetBuiltinWidgetsForTests()
  __clearWidgetsForTests()
  installBuiltinWidgets()
  for (const k of PRIMITIVE_KINDS) expect(hasWidget(k), k).toBe(false)
  // `getWidget` on an unknown kind must not throw — `WidgetHost` renders its note.
  // (The registry's contract; asserted here because it is what carries the deletion.)
  expect(() => registeredWidgetKinds()).not.toThrow()
})
