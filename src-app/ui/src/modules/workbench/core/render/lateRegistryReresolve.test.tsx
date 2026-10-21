// @vitest-environment jsdom
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// A `data:` slice must RE-RESOLVE when the datatype registry populates late (issue #439).
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The FE datatype registry (`core/datatypes/registry.ts`) is populated ASYNCHRONOUSLY,
// post-auth, by `populateDatatypeRegistry` (`core/datatypes/boot.ts`, fired-and-forgotten
// from `modules/datatypes/module.tsx`). It lands AFTER a pane mounts. A declarative
// `data:` slice whose source reads the registry — `container_members` reads
// `datatypeRegistry.get(datatype)?.input_requirements` (`runtime/viewData.ts:746`) — is
// therefore resolved ONCE, against a registry that does not yet carry the manifest
// datatype, and lands `empty` (`viewData.ts:1685` → `store.setData(undefined, 'empty')`).
// The bin picker of the shipped importer view that declares a `container_members` slice
// offers NOTHING, and stays that way PERMANENTLY: the resolve effect in
// `DeclarativeRegion.tsx:431-444` is keyed on
// `[viewId, spec, api, data, catalogEpoch, axisKey, stateKey, paneScope]`, and
// `datatypeRegistry.replaceAll` bumps NONE of those. DeclarativeRegion does NOT subscribe
// to the registry. THAT is the bug this file pins.
//
// Every existing suite hides it by seeding the registry SYNCHRONOUSLY before mounting
// (`visiumHdRunInputs.test.ts:136-153`, `dataStatusGate.test.tsx:529`,
// `containerMembers.reader.test.ts:83-86`), so the registry is authoritative before any
// resolve runs and the window never opens. This file deliberately does NOT seed: it mounts
// the REAL declarative render path with the registry carrying only the bootstrap skeleton,
// asserts the picker offers nothing, then drives the late populate EXACTLY as boot does —
// `datatypeRegistry.replaceAll([...])` inside `act`, no remount, no `refreshCatalog`, no
// `catalogEpoch` bump — and asserts the picker corrects itself. On today's code that
// assertion FAILS: the slice stays `empty` and the picker stays disabled forever.
//
// The expected option set is DERIVED from the SHIPPED container declaration — the
// manifest's `input_requirements.members` for the datatype the slice names — through the
// SAME `resolveContainerMembers` the slice reader uses — never a literal. The container id
// is read off the shipped view's own `container_members` slice args, so a divergence
// between the view and the declaration fails here rather than drifting.
// T1 pins WHEN the slice resolves (the #439 seam) and HOW MANY options the declaration
// yields; the per-option value/label/sort derivation is pinned by `containerMembers.test.ts`,
// not here.
//
// ── The second test: the "correct for a user" half ────────────────────────────────────
//
// A test that only proves the picker repopulates proves the ENGINE re-resolves; it does
// not prove a USER can act on it. So the second test drives the whole chain after the late
// populate: the picker offers the derived bins, a bin is SELECTED through the real control
// (`choosePicker`), the Run button is pressed, and the chosen value is asserted to reach
// the launched job as `params.bin_um` — the STRING the picker sends (the declarative
// select is string-valued at the kit level). On today's code this fails at the same root
// cause: the picker is still empty, so there is nothing to select.

import * as React from 'react'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'

import { datatypeRegistry } from '@/core/datatypes/registry'
import { BOOTSTRAP_LATTICE } from '@/core/datatypes/builtin'
import type { Datatype, InputRequirements } from '@/core/datatypes/types'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ProcessorPackage } from '@/modules/workbench/core/manifest/processorPackage'
import { registerProcessorPackage } from '@/modules/workbench/core/runtime/loadProcessors'
import {
  workbenchRegistry,
  createWorkbenchApi,
  WORKBENCH_API_VERSION,
  type WorkbenchHost,
} from '@/modules/workbench/core'
import { isDeclarativeRenderSpec, type DeclarativeRenderSpec } from '@/modules/workbench/core/runtime/seam'
import { CONTAINER_MEMBERS_SOURCE, resolveContainerMembers } from '@/modules/workbench/core/runtime/containerMembers'
import { COMPATIBLE_COLUMNS_SOURCE } from '@/modules/workbench/core/runtime/compatibleColumns'
import { peekStore, __resetDeclarativeMountsForTests } from './declarativeMount'
import { DeclarativeStack } from './DeclarativeRegion'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { workbenchLattice } from '@/modules/workbench/core/host/createHost'
import { makeFakeDataHost } from '@/modules/workbench/extensions/data/dataHost'
import type { ArtifactRow, DataHost } from '@/modules/workbench/extensions/data/contract'
import { DATA_CAPABILITY_ID, JOBS_CAPABILITY_ID } from '@/modules/workbench/extensions'
import type { ComputeHost, JobCreateRequest } from '@/modules/workbench/extensions/jobs/contract'
import { getDeclarativeCanvasHost, registerDeclarativeCanvasHost } from './canvasHost'
import { choosePicker, pickerOptions } from '@/modules/workbench/core/__testutil__/pickerDriver'

// ── jsdom gaps the kit's base-ui controls probe at mount (same set as the sibling tier) ──
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// The shipped package + declaration — FOUND structurally, never named
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Resolved from the RUNNER's cwd rather than `import.meta.url`: under jsdom the module URL
 *  is an `http:` one and `fileURLToPath` refuses it. */
function findProcessorsDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages')
    if (existsSync(candidate) && readdirSync(candidate).some(d => existsSync(join(candidate, d, 'manifest.yaml')))) {
      return candidate
    }
    dir = join(dir, '..')
  }
  throw new Error('lateRegistryReresolve: no packages/ package root found from ' + process.cwd())
}
const PROCESSORS_DIR = findProcessorsDir()
const ALL_PACKAGE_DIRS = readdirSync(PROCESSORS_DIR).sort()

function readShippedPackage(dir: string): ProcessorPackage | undefined {
  const manifestPath = join(PROCESSORS_DIR, dir, 'manifest.yaml')
  if (!existsSync(manifestPath)) return undefined
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'))
  if (!manifest || typeof manifest.id !== 'string') return undefined
  const uiDir = join(PROCESSORS_DIR, dir, 'ui')
  const views: Record<string, unknown> = {}
  if (existsSync(uiDir)) {
    for (const f of readdirSync(uiDir).filter(x => x.endsWith('.yaml')).sort()) {
      views[`ui/${f}`] = parseYaml(readFileSync(join(uiDir, f), 'utf8'))
    }
  }
  return { manifest, views } as ProcessorPackage
}

/** Assert EXACTLY ONE match and return it. A locator that takes a FIRST match silently
 *  redirects the whole test to a different subject the day a second match ships — it could
 *  pass while testing nothing relevant — so every locator in this file asserts uniqueness
 *  instead, naming what it found. */
function soleMatch<T>(matches: T[], what: string, describe: (m: T) => string): T {
  if (matches.length === 0) {
    throw new Error(`lateRegistryReresolve: no shipped ${what} found`)
  }
  if (matches.length > 1) {
    throw new Error(
      `lateRegistryReresolve: ${matches.length} shipped ${what} found — ${matches
        .map(describe)
        .join(', ')}; expected exactly one`,
    )
  }
  return matches[0]
}

/** The shipped package whose view declares a `container_members` data slice — located by
 *  walking the shipped set, so this file names no package and no view file. Asserts
 *  UNIQUENESS: a second package declaring the slice would silently redirect the whole test
 *  to a different subject, so it fails loudly (naming what it found) instead of taking a
 *  first match. */
function packageDeclaringContainerMembers(): ProcessorPackage {
  return soleMatch(
    ALL_PACKAGE_DIRS.map(dir => readShippedPackage(dir)).filter(
      (pkg): pkg is ProcessorPackage =>
        pkg !== undefined &&
        Object.values(pkg.views).some(raw => {
          const data = (raw as ViewSpec).data ?? {}
          return Object.values(data).some(d => (d as { source?: string })?.source === CONTAINER_MEMBERS_SOURCE)
        }),
    ),
    'package declaring a container_members data slice',
    p => p.manifest.id,
  )
}

/** The key of the `container_members` slice in the shipped view — asserted UNIQUE, for the
 *  same reason the package locator is: a second slice would silently change which slice the
 *  test drives. */
function containerMembersSliceKey(): string {
  const pkg = packageDeclaringContainerMembers()
  return soleMatch(
    Object.values(pkg.views).flatMap(raw => {
      const data = (raw as ViewSpec).data ?? {}
      return Object.entries(data)
        .filter(([, decl]) => (decl as { source?: string })?.source === CONTAINER_MEMBERS_SOURCE)
        .map(([key]) => key)
    }),
    'container_members slice in the shipped view',
    key => key,
  )
}

/** The container datatype id the shipped view's `container_members` slice names — the id
 *  the late populate must register. Read off the view, never written down; asserted UNIQUE
 *  for the same reason the other locators are. */
function containerId(): string {
  const pkg = packageDeclaringContainerMembers()
  return soleMatch(
    Object.values(pkg.views).flatMap(raw => {
      const data = (raw as ViewSpec).data ?? {}
      return Object.values(data)
        .filter(decl => (decl as { source?: string })?.source === CONTAINER_MEMBERS_SOURCE)
        .map(decl => (decl as { args?: { datatype?: string } })?.args?.datatype)
        .filter((datatype): datatype is string => typeof datatype === 'string' && datatype !== '')
    }),
    'container datatype id named by the container_members slice',
    id => id,
  )
}

/** The id of the select widget whose options binding reads the `container_members` slice —
 *  the bin picker. Found by its binding, never by name; asserted UNIQUE. */
function binPickerWidgetId(): string {
  const pkg = packageDeclaringContainerMembers()
  const sliceKey = containerMembersSliceKey()
  return soleMatch(
    Object.values(pkg.views).flatMap(raw => {
      const spec = raw as ViewSpec
      return (spec.widgets ?? [])
        .filter(w => w.kind === 'select' && (w as { options?: string }).options === `$data.${sliceKey}`)
        .map(w => (w as { id?: string }).id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
    }),
    'select over the container_members slice',
    id => id,
  )
}

/** The id of the button whose onClick action dispatches a run — the Run button. Found by
 *  the action's body, never by name; asserted UNIQUE. */
function runButtonWidgetId(): string {
  const pkg = packageDeclaringContainerMembers()
  return soleMatch(
    Object.values(pkg.views).flatMap(raw => {
      const spec = raw as ViewSpec
      const actions = (spec.actions ?? []) as Array<{ id?: string; body?: unknown[] }>
      const runActionIds = new Set(
        actions
          .filter(a => (a.body ?? []).some(e => e != null && typeof e === 'object' && 'run_processor' in e))
          .map(a => a.id),
      )
      return (spec.widgets ?? [])
        .filter(w => w.kind === 'button' && runActionIds.has((w as { onClick?: string }).onClick ?? ''))
        .map(w => (w as { id?: string }).id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
    }),
    'run button',
    id => id,
  )
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The expected offer — DERIVED from the SHIPPED container declaration, never a literal
// ═══════════════════════════════════════════════════════════════════════════════════════

/** The SHIPPED manifest container's `input_requirements`, or a loud failure naming what is
 *  missing — a test that silently derived from nothing would be a test that asserts nothing.
 *  Returns the NARROWED manifest variant, so callers can read `members` without re-narrowing
 *  the `InputRequirements` union. The declaring package is found STRUCTURALLY — the package
 *  whose manifest `contributes.datatypes` declares the derived container id — so this file
 *  names no package, and the test survives the datatype moving packages (it fails loudly on
 *  an ambiguity instead of silently picking one). */
function shippedRequirements(): Extract<InputRequirements, { requires: 'manifest' }> {
  const container = containerId()
  const declaring = soleMatch(
    ALL_PACKAGE_DIRS.map(dir => readShippedPackage(dir)).filter(
      (pkg): pkg is ProcessorPackage =>
        pkg !== undefined &&
        ((pkg.manifest.contributes as { datatypes?: Array<Record<string, unknown>> } | undefined)?.datatypes ?? []).some(
          d => d.id === container,
        ),
    ),
    'package manifest declaring the derived container datatype',
    p => p.manifest.id,
  )
  const datatypes = (declaring.manifest.contributes as { datatypes: Array<Record<string, unknown>> }).datatypes
  const bundle = datatypes.find(d => d.id === container)
  const requirements = bundle?.input_requirements as
    | { requires?: string; members?: string[]; allow_archive?: boolean }
    | undefined
  if (!requirements || requirements.requires !== 'manifest' || !requirements.members?.length) {
    throw new Error(
      `the shipped manifest must declare the derived container ${container} as a manifest container`,
    )
  }
  return requirements as Extract<InputRequirements, { requires: 'manifest' }>
}

/** The offer the SHIPPED container declaration implies — computed through the SAME
 *  `resolveContainerMembers` the slice reader uses, so "the offered bins" is whatever the
 *  container actually declares, never a literal `[2,8,16]`. */
function offeredBins(): Array<{ value: number; label: string }> {
  const requirements: InputRequirements = {
    requires: 'manifest',
    members: shippedRequirements().members,
    allow_archive: shippedRequirements().allow_archive,
  }
  return resolveContainerMembers(requirements) as Array<{ value: number; label: string }>
}

/** The number of DISTINCT LEADING PATH SEGMENTS the shipped declaration's members carry —
 *  an INDEPENDENT structural fact, computed straight off the declaration (never through
 *  `resolveContainerMembers`). A member with no `/` sits at the container's root and
 *  contributes nothing; each member with a path contributes its text before the first `/`;
 *  distinct segments count once. This is the COUNT oracle: it pins HOW MANY options the
 *  declaration yields without reimplementing the derivation (the digit extraction, the
 *  label format, the sort, the same-value dedupe — all pinned by
 *  `containerMembers.test.ts`).
 *
 *  KNOWN LATENT DIVERGENCE: this counts DISTINCT SEGMENTS, while the real
 *  `resolveContainerMembers` additionally dedupes by the derived numeric VALUE
 *  (`containerMembers.ts:116-122`) — `singleDigitRun` collapses e.g. "group_008" and
 *  "group_8" to the same value 8, so two such segments would count twice here but once
 *  there. Today's shipped HD declaration has no such collision, so the two counts agree;
 *  if it ever gained one, this oracle would OVERCOUNT and the test would fail spuriously —
 *  a false RED, never a false GREEN, since the primary `toEqual(offeredBins())` assertion
 *  stays correct either way. */
function declaredGroupCount(): number {
  const prefixes = new Set<string>()
  for (const member of shippedRequirements().members) {
    const slash = member.indexOf('/')
    if (slash === -1) continue
    prefixes.add(member.slice(0, slash))
  }
  return prefixes.size
}

/** The datatype the late populate registers — the SHIPPED container's declaration, shaped
 *  as the registry's `Datatype`. Only `input_requirements` is load-bearing for the
 *  `container_members` slice; `id` + `capabilities` are what the bundle picker's source
 *  filter reads. */
function manifestDatatype(): Datatype {
  return {
    id: containerId(),
    extends: 'data/opaque',
    title: containerId(),
    description: '',
    storage: {
      layout: { kind: 'opaque_as_is' },
      format: 'spaceranger-hd',
      selector_map: {},
      file_layout: 'manifest',
      tiers: [],
    },
    capabilities: ['spatial-bundle-target'],
    viewers: [],
    converters: [],
    input_requirements: shippedRequirements(),
  } as unknown as Datatype
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The SECOND site (issue #439): the `caps` memo — a LOCAL fixture, never a shipped view
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The `data:` slice fix above pins the FIRST registry consumer. The adversarial review
// found a SECOND one: `DeclarativeRegion`'s `caps` memo (`deriveCaps(producedTypeIds,
// lattice)`), which feeds the `has:<capability>` `when` predicate. `lattice` is the
// registry-backed adapter (`createHost.ts:50-53`) — a STABLE reference that does NOT
// change identity when the registry populates — so before the fix the memo stayed computed
// from the BOOTSTRAP lattice, whose datatypes carry `capabilities: []`
// (`core/datatypes/builtin.ts`). A pane that mounts before `GET /api/datatypes` lands
// therefore evaluated every `has:<capability>` gate against a capability-less set, and a
// widget gated on a capability the produced datatype DECLARES stayed hidden FOREVER — even
// after the registry populated.
//
// This test pins that with a LOCAL fixture view (generic ids, no domain vocabulary): a
// widget gated `when: has:probe-capability`, where `probe-capability` is a DECLARED
// capability of the produced datatype `test/cap-probe` — the thing the late populate
// supplies. It mounts with the registry carrying only the bootstrap skeleton, asserts the
// gated widget is NOT rendered, drives the late populate exactly as boot does
// (`datatypeRegistry.replaceAll([...])` inside `act`, no remount, no `refreshCatalog`, no
// `catalogEpoch` bump), and asserts the widget NOW RENDERS. On the unfixed code
// (`registryVersion` removed from the `caps` memo deps) that last assertion FAILS: the
// memo stays computed from the bootstrap lattice and the gate stays closed forever.

/** The produced datatype the fixture's project holds — generic, no domain vocabulary. */
const CAP_PROBE_DATATYPE = 'test/cap-probe'
/** The DECLARED capability the late populate supplies — generic, no domain vocabulary. */
const CAP_PROBE_CAPABILITY = 'probe-capability'
/** The gated widget's id — the DOM surface the assertions read. */
const CAP_PROBE_WIDGET_ID = 'cap-probe-alert'
const CAP_PROBE_WIDGET_TESTID = `widget-${CAP_PROBE_WIDGET_ID}`
const CAP_PROBE_VIEW_ID = 'cap-probe-view'
const CAP_PROBE_ANALYSIS_ID = 'cap-probe-analysis'

/** The datatype the late populate registers — `test/cap-probe` WITH its declared
 *  capability. Only `id`/`extends`/`capabilities` are load-bearing for `deriveCaps`. */
function capProbeDatatype(): Datatype {
  return {
    id: CAP_PROBE_DATATYPE,
    extends: 'data/opaque',
    title: CAP_PROBE_DATATYPE,
    description: '',
    storage: {
      layout: { kind: 'opaque_as_is' },
      format: '',
      selector_map: {},
      file_layout: 'single',
      tiers: [],
    },
    capabilities: [CAP_PROBE_CAPABILITY],
    viewers: [],
    converters: [],
  } as unknown as Datatype
}

/** The local fixture package: ONE analysis whose view declares the gated widget. */
function capProbePackage(): ProcessorPackage {
  return {
    manifest: {
      id: 'cap-probe-pkg',
      name: 'cap-probe-pkg',
      version: '0.0.0',
      apiVersion: WORKBENCH_API_VERSION,
      contributes: {
        analyses: [
          {
            id: CAP_PROBE_ANALYSIS_ID,
            category: 'test',
            title: 'Capability probe',
            appliesTo: [],
            produces: [CAP_PROBE_DATATYPE],
            ui: ['ui/cap-probe.yaml'],
            run: { kind: 'builtin', fn: 'noop' },
          },
        ],
      },
    },
    views: {
      'ui/cap-probe.yaml': {
        id: CAP_PROBE_VIEW_ID,
        title: 'Capability probe',
        permission: 'cap-probe',
        state: {},
        widgets: [
          {
            id: CAP_PROBE_WIDGET_ID,
            kind: 'alert',
            when: `has:${CAP_PROBE_CAPABILITY}`,
            text: 'probe visible',
          },
        ],
        actions: [],
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The THIRD site (issue #439): the REQUEST-KEY half — a LOCAL fixture, never a shipped view
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The `data:` slice fix above pins that the resolve effect RE-RUNS when the registry
// populates. It does NOT pin the REQUEST-KEY half: `resolveAndApplyViewData` de-dupes
// concurrent resolves by request key (`viewData.ts:1635-1637`), and a DIFFERENT key
// SUPERSEDES the in-flight resolve (`nextGeneration`, `viewData.ts:1638`; the stale
// landing is discarded at 1677). So if the registry populates WHILE the first resolve is
// still in flight and the key does not carry the version, the second resolve is swallowed
// by the same-key guard and the picker keeps the pre-populate (empty) answer.
//
// This test pins that with a LOCAL fixture view (generic ids, no domain vocabulary): a
// `container_members` slice (the registry consumer) PLUS a `compatible_columns` slice (a
// plane read). The plane read is what makes the first resolve genuinely IN FLIGHT — the
// `container_members` slice is pure, so a view declaring only it would resolve in a
// microtask and the window would never open. The data host's list read is HELD (the same
// gate the sibling `dataStatusGate.test.tsx` uses), the pane mounts with the registry
// carrying only the bootstrap skeleton, the first resolve starts and is caught by the
// gate, the late populate lands while it is still in flight, the host is released, and
// the slice must end up holding the POPULATED answer — not the pre-populate empty one. On
// the unfixed code (the `|registry:${registryVersion}|` segment removed from the request
// key) the second resolve carries the SAME key as the still-in-flight first one, is
// swallowed by the same-key guard, and the first resolve's empty answer lands — this
// assertion FAILS.

/** The fixture view's id — generic, no domain vocabulary. */
const RERESOLVE_VIEW_ID = 'reresolve-view'
/** The fixture analysis's id — generic, no domain vocabulary. */
const RERESOLVE_ANALYSIS_ID = 'reresolve-analysis'
/** The datatype the fixture's analysis produces — generic, no domain vocabulary. */
const RERESOLVE_PRODUCED = 'test/reresolve-probe'
/** The `container_members` slice key — the registry consumer under test. */
const RERESOLVE_BINS_SLICE = 'bins'
/** The plane-reading slice key — the read that holds the first resolve in flight. */
const RERESOLVE_HOLD_SLICE = 'columns'
/** A trivial widget so the pane renders a form (the resolve effect fires regardless). */
const RERESOLVE_WIDGET_ID = 'reresolve-alert'

/** The local fixture package: ONE analysis whose view declares the `container_members`
 *  slice — naming the SHIPPED container, found structurally — beside a plane-reading
 *  `compatible_columns` slice. */
function reresolvePackage(): ProcessorPackage {
  return {
    manifest: {
      id: 'reresolve-pkg',
      name: 'reresolve-pkg',
      version: '0.0.0',
      apiVersion: WORKBENCH_API_VERSION,
      contributes: {
        analyses: [
          {
            id: RERESOLVE_ANALYSIS_ID,
            category: 'test',
            title: 'Reresolve probe',
            appliesTo: [],
            produces: [RERESOLVE_PRODUCED],
            ui: ['ui/reresolve.yaml'],
            run: { kind: 'builtin', fn: 'noop' },
          },
        ],
      },
    },
    views: {
      'ui/reresolve.yaml': {
        id: RERESOLVE_VIEW_ID,
        title: 'Reresolve probe',
        permission: 'reresolve',
        state: {},
        data: {
          [RERESOLVE_BINS_SLICE]: {
            source: CONTAINER_MEMBERS_SOURCE,
            args: { datatype: containerId() },
          },
          [RERESOLVE_HOLD_SLICE]: {
            source: COMPATIBLE_COLUMNS_SOURCE,
            args: {},
          },
        },
        widgets: [
          {
            id: RERESOLVE_WIDGET_ID,
            kind: 'alert',
            text: 'reresolve probe visible',
          },
        ],
        actions: [],
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The harness — the REAL declarative render path over a fake data/jobs plane
// ═══════════════════════════════════════════════════════════════════════════════════════

interface Mounted {
  render: DeclarativeRenderSpec
  viewId: string
  sliceKey: string
  /** Every `createJob` request the launched run produced — the wire the chosen bin reaches. */
  captured: JobCreateRequest[]
}

/** The value the `container_members` slice currently holds in the live store — `undefined`
 *  while the slice is `empty` (the store's `data` is cleared wholesale on an authoritative
 *  empty, `viewData.ts:1685`). */
function sliceValue(viewId: string, key: string): unknown {
  return (peekStore(viewId)?.data as Record<string, unknown> | undefined)?.[key]
}

/** Restore whatever canvas host was registered before (the real provider, installed by the
 *  extensions barrel) on teardown. */
let restoreCanvasHost: (() => void) | undefined

async function mountPane(): Promise<Mounted> {
  const pkg = packageDeclaringContainerMembers()
  const result = registerProcessorPackage(pkg, workbenchRegistry)
  expect(result.errors, 'the shipped package must register cleanly').toEqual([])
  const contribution = workbenchRegistry.views.all().find(v => result.viewContributionIds.includes(v.id))
  const spec = (contribution as { render?: { spec?: unknown } } | undefined)?.render?.spec
  if (!isDeclarativeRenderSpec(spec)) throw new Error('the package under test is not a declarative pane')

  const sliceKey = containerMembersSliceKey()
  const pickerId = binPickerWidgetId()
  const view = spec.views.find(v =>
    (v.view_spec.widgets ?? []).some(w => (w as { id?: string }).id === pickerId),
  )
  if (!view) throw new Error('lateRegistryReresolve: the registered pane declares no bin picker widget')

  // The project catalog: ONE bundle artifact of the container datatype — the upload a user
  // would have made. The `container_members` slice itself is PURE (it reads the registry,
  // never the plane), so the data plane only matters for the bundle picker's candidate set
  // and the run's input binding.
  const bundle: ArtifactRow = {
    id: 'art-bundle',
    project_id: 'p-hd',
    datatype: containerId(),
    structure: {},
    created_at: '2026-08-01T00:00:00Z',
    source_dataset_id: 'ds-hd',
  }
  const fake = makeFakeDataHost({
    projectId: 'p-hd',
    artifacts: [bundle],
    axes: [],
    isA: (sub, sup) => workbenchLattice.isA(sub, sup),
  })
  const captured: JobCreateRequest[] = []
  const compute = {
    createJob: async (req: JobCreateRequest) => {
      captured.push(req)
      return { jobId: 'job-1' }
    },
    streamJob: (_id: string, onFrame: (f: { phase: string }) => void) => {
      onFrame({ phase: 'completed' })
      return { dispose: () => {} }
    },
  } as unknown as ComputeHost
  const host = {
    projectId: 'p-hd',
    events: { on: () => ({ dispose: () => {} }), emit: () => {} },
    storage: { get: () => null, set: () => {}, remove: () => {} },
    ui: { notify: () => {}, confirm: async () => true },
    datatypes: workbenchLattice,
    planes: { [DATA_CAPABILITY_ID]: fake, [JOBS_CAPABILITY_ID]: compute },
  } as unknown as WorkbenchHost
  const api = createWorkbenchApi(host, 'hd-test')

  // The shipped view declares no canvas, so a no-op host keeps the publish effect inert
  // (the real provider would otherwise run its own coordinate resolution).
  const previous = getDeclarativeCanvasHost()
  registerDeclarativeCanvasHost({ publish: () => {}, clear: () => {} })
  restoreCanvasHost = () => {
    if (previous) registerDeclarativeCanvasHost(previous)
  }

  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId="p-hd" viewId="wb" canEdit>
        <DeclarativeStack render={spec} />
      </WorkbenchProvider>,
    )
  })
  // Let the mount-time resolve land: the `container_members` slice is pure, but the pane's
  // catalog read + the provider's produced-type read are async, and the resolve effect runs
  // after first paint.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  return { render: spec, viewId: view.view_id, sliceKey, captured }
}

/** Mount the REAL declarative render path for the local capability-probe fixture, with the
 *  registry carrying ONLY the bootstrap skeleton. The project catalog holds ONE artifact of
 *  `test/cap-probe`, so `producedTypeIds` is `['test/cap-probe']` — the id whose DECLARED
 *  capability the late populate supplies. The view declares no `data` slice, so the store
 *  starts `ready` and the form (the gated widget) renders immediately. */
async function mountCapProbePane(): Promise<{ viewId: string }> {
  const result = registerProcessorPackage(capProbePackage(), workbenchRegistry)
  expect(result.errors, 'the fixture package must register cleanly').toEqual([])
  const contribution = workbenchRegistry.views.all().find(v => result.viewContributionIds.includes(v.id))
  const spec = (contribution as { render?: { spec?: unknown } } | undefined)?.render?.spec
  if (!isDeclarativeRenderSpec(spec)) throw new Error('the fixture package is not a declarative pane')

  const probe: ArtifactRow = {
    id: 'art-cap-probe',
    project_id: 'p-cap-probe',
    datatype: CAP_PROBE_DATATYPE,
    structure: {},
    created_at: '2026-08-01T00:00:00Z',
    source_dataset_id: 'ds-cap-probe',
  }
  const fake = makeFakeDataHost({
    projectId: 'p-cap-probe',
    artifacts: [probe],
    axes: [],
    isA: (sub, sup) => workbenchLattice.isA(sub, sup),
  })
  const compute = {
    createJob: async () => ({ jobId: 'job-1' }),
    streamJob: (_id: string, onFrame: (f: { phase: string }) => void) => {
      onFrame({ phase: 'completed' })
      return { dispose: () => {} }
    },
  } as unknown as ComputeHost
  const host = {
    projectId: 'p-cap-probe',
    events: { on: () => ({ dispose: () => {} }), emit: () => {} },
    storage: { get: () => null, set: () => {}, remove: () => {} },
    ui: { notify: () => {}, confirm: async () => true },
    datatypes: workbenchLattice,
    planes: { [DATA_CAPABILITY_ID]: fake, [JOBS_CAPABILITY_ID]: compute },
  } as unknown as WorkbenchHost
  const api = createWorkbenchApi(host, 'cap-probe-test')

  // The fixture declares no canvas, but the publish effect still calls whatever host is
  // registered (the real provider would run its own coordinate resolution) — a no-op host
  // keeps it inert, exactly as `mountPane` does for the shipped view.
  const previous = getDeclarativeCanvasHost()
  registerDeclarativeCanvasHost({ publish: () => {}, clear: () => {} })
  restoreCanvasHost = () => {
    if (previous) registerDeclarativeCanvasHost(previous)
  }

  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId="p-cap-probe" viewId="wb" canEdit>
        <DeclarativeStack render={spec} />
      </WorkbenchProvider>,
    )
  })
  // Let the mount-time catalog read land (`producedTypeIds` → `['test/cap-probe']`) and the
  // resolve effect settle.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  const view = spec.views.find(v =>
    (v.view_spec.widgets ?? []).some(w => (w as { id?: string }).id === CAP_PROBE_WIDGET_ID),
  )
  if (!view) throw new Error('the fixture pane declares no gated widget')
  return { viewId: view.view_id }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The HOLD gate over the plane's list read — the same mechanism the sibling
// `dataStatusGate.test.tsx` uses to make an in-flight window observable
// ═══════════════════════════════════════════════════════════════════════════════════════

interface QueryGate {
  /** Hold every subsequent read. */
  hold(): void
  /** How many reads are waiting right now — the proof a fetch is genuinely OUTSTANDING, so
   *  an "in flight" assertion cannot pass vacuously against a region that never started
   *  fetching. */
  pending(): number
  /** Stop holding and let everything settle. */
  release(): Promise<void>
}

function gateQueries(plane: DataHost): { plane: DataHost; gate: QueryGate } {
  let holding = false
  let waiters: Array<() => void> = []
  return {
    plane: {
      ...plane,
      listArtifacts: async (scope, query) => {
        const answer = plane.listArtifacts(scope, query)
        if (holding) await new Promise<void>(resolve => waiters.push(resolve))
        return answer
      },
    },
    gate: {
      hold() {
        holding = true
      },
      pending: () => waiters.length,
      async release() {
        const pending = waiters
        waiters = []
        holding = false
        await act(async () => {
          for (const resolve of pending) resolve()
          await new Promise(resolve => setTimeout(resolve, 30))
        })
      },
    },
  }
}

/** Mount the REAL declarative render path for the local reresolve fixture, with the
 *  registry carrying ONLY the bootstrap skeleton. When `hold` is set, the data host's list
 *  read is HELD before mount, so the first resolve cannot complete — the window the
 *  request-key half of the fix exists for. */
async function mountReresolvePane(options: { hold?: boolean } = {}): Promise<{ viewId: string; gate: QueryGate }> {
  const result = registerProcessorPackage(reresolvePackage(), workbenchRegistry)
  expect(result.errors, 'the fixture package must register cleanly').toEqual([])
  const contribution = workbenchRegistry.views.all().find(v => result.viewContributionIds.includes(v.id))
  const spec = (contribution as { render?: { spec?: unknown } } | undefined)?.render?.spec
  if (!isDeclarativeRenderSpec(spec)) throw new Error('the fixture package is not a declarative pane')

  // The fixture's `compatible_columns` slice reads the plane's list; the fake answers with
  // an empty catalog, which is all that slice needs to resolve `ready`.
  const fake = makeFakeDataHost({
    projectId: 'p-reresolve',
    artifacts: [],
    axes: [],
    isA: (sub, sup) => workbenchLattice.isA(sub, sup),
  })
  const gated = gateQueries(fake)
  const compute = {
    createJob: async () => ({ jobId: 'job-1' }),
    streamJob: (_id: string, onFrame: (f: { phase: string }) => void) => {
      onFrame({ phase: 'completed' })
      return { dispose: () => {} }
    },
  } as unknown as ComputeHost
  const host = {
    projectId: 'p-reresolve',
    events: { on: () => ({ dispose: () => {} }), emit: () => {} },
    storage: { get: () => null, set: () => {}, remove: () => {} },
    ui: { notify: () => {}, confirm: async () => true },
    datatypes: workbenchLattice,
    planes: { [DATA_CAPABILITY_ID]: gated.plane, [JOBS_CAPABILITY_ID]: compute },
  } as unknown as WorkbenchHost
  const api = createWorkbenchApi(host, 'reresolve-test')

  // The fixture declares no canvas, so a no-op host keeps the publish effect inert.
  const previous = getDeclarativeCanvasHost()
  registerDeclarativeCanvasHost({ publish: () => {}, clear: () => {} })
  restoreCanvasHost = () => {
    if (previous) registerDeclarativeCanvasHost(previous)
  }

  if (options.hold) gated.gate.hold()
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId="p-reresolve" viewId="wb" canEdit>
        <DeclarativeStack render={spec} />
      </WorkbenchProvider>,
    )
  })
  // Let the mount-time reads be issued (the catalog read + the first resolve's held slice
  // read) — the gate keeps them outstanding, so the first resolve stays in flight.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  const view = spec.views.find(v =>
    (v.view_spec.widgets ?? []).some(w => (w as { id?: string }).id === RERESOLVE_WIDGET_ID),
  )
  if (!view) throw new Error('the fixture pane declares no widget')
  return { viewId: view.view_id, gate: gated.gate }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The registry is a process-wide singleton: save and restore it so this suite cannot leak
// its seeds into a sibling suite (or inherit theirs). Each test then starts from the
// BOOTSTRAP skeleton — the state the registry is in before `GET /api/datatypes` lands —
// which is exactly the state that hides the defect in every other suite.
// ═══════════════════════════════════════════════════════════════════════════════════════

let original: Datatype[]
beforeEach(() => {
  original = datatypeRegistry.all()
})
afterEach(() => {
  cleanup()
  __resetDeclarativeMountsForTests()
  restoreCanvasHost?.()
  restoreCanvasHost = undefined
  datatypeRegistry.replaceAll(original)
})

describe('a `data:` slice re-resolves when the datatype registry populates late (issue #439)', () => {
  it('the bin picker stays EMPTY forever when the registry lands after the pane mounted — THE DEFECT', async () => {
    // (a) Mount the REAL declarative render path with the registry NOT yet carrying the
    //     manifest datatype — the bootstrap skeleton only, exactly as before the async
    //     `GET /api/datatypes` populate lands.
    datatypeRegistry.replaceAll(BOOTSTRAP_LATTICE)
    const { viewId, sliceKey } = await mountPane()

    // (b) The bin picker offers NOTHING at that point. This documents the window: the
    //     slice resolved against an empty registry and landed an authoritative `empty`.
    expect(peekStore(viewId)?.dataStatus, 'the slice landed authoritative empty').toBe('empty')
    expect(sliceValue(viewId, sliceKey), 'no bins are offered').toBeUndefined()
    const picker = screen.getByTestId(`widget-${binPickerWidgetId()}`)
    expect(picker.hasAttribute('disabled'), 'the picker is disabled — nothing to choose').toBe(true)

    // (c) WITHOUT remounting, WITHOUT unmount/remount, and WITHOUT bumping `catalogEpoch`
    //     or firing `refreshCatalog`, drive the late populate exactly as boot does.
    await act(async () => {
      datatypeRegistry.replaceAll([manifestDatatype()])
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

    // (d) THE DEFECT. The slice must re-resolve against the populated registry and the
    //     picker must offer the derived bins. On today's code the resolve effect
    //     (`DeclarativeRegion.tsx:431-444`) never re-runs — `replaceAll` bumps none of its
    //     dependencies and DeclarativeRegion does not subscribe to the registry — so the
    //     store stays `empty` and this assertion FAILS.
    expect(
      sliceValue(viewId, sliceKey),
      'the slice must re-resolve against the populated registry — the picker must not sit empty forever',
    ).toEqual(offeredBins())
    // The INDEPENDENT COUNT oracle: the slice must offer exactly as many options as the
    // declaration yields distinct leading path segments — computed straight off the
    // declaration, never through the same `resolveContainerMembers` that produced the
    // `toEqual` expectation above (a derivation that silently DROPS an option would pass
    // the tautological `toEqual` and fail here).
    expect(
      (sliceValue(viewId, sliceKey) as unknown[] | undefined)?.length,
      'the slice offers exactly as many options as the declaration yields distinct leading path segments',
    ).toBe(declaredGroupCount())
    expect(
      screen.getByTestId(`widget-${binPickerWidgetId()}`).hasAttribute('disabled'),
      'the picker must offer the derived bins',
    ).toBe(false)
    expect(await pickerOptions(screen.getByTestId(`widget-${binPickerWidgetId()}`))).toEqual(
      offeredBins().map(b => String(b.value)),
    )
  })

  it('a bin chosen after the late populate reaches the launched run as params.bin_um', async () => {
    // The same late-populate sequence as the defect test — the "correct for a user, not
    // merely for a test" half: after the populate the user must be able to SELECT a bin and
    // have that choice reach the job.
    datatypeRegistry.replaceAll(BOOTSTRAP_LATTICE)
    const { viewId, sliceKey, captured } = await mountPane()

    await act(async () => {
      datatypeRegistry.replaceAll([manifestDatatype()])
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

    // The picker now offers the derived bins — the same re-resolve test 1 pins. On today's
    // code this fails here (the slice never re-resolves), which is the same root cause.
    const bins = offeredBins()
    expect(sliceValue(viewId, sliceKey), 'the slice must re-resolve against the populated registry').toEqual(bins)
    const picker = screen.getByTestId(`widget-${binPickerWidgetId()}`)
    expect(picker.hasAttribute('disabled'), 'the picker must offer the derived bins').toBe(false)

    // The sole bundle candidate pre-selected (the view declares `auto_bind_sole_candidate`),
    // so the run's required input is bound and the Run button is enabled.
    expect(peekStore(viewId)?.state?.bundle, 'the sole bundle candidate pre-selected').toBeTruthy()

    // SELECT a bin through the real control — the largest offered, DERIVED never a literal.
    const chosen = bins[bins.length - 1].value
    await choosePicker(picker, String(chosen))

    // LAUNCH through the real Run button.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`widget-${runButtonWidgetId()}`))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

    expect(captured.length, 'a run was launched').toBe(1)
    // The declarative select is string-valued at the kit level, so the chosen bin reaches
    // the job as the STRING the picker sends — `params.bin_um` on the flat AnalysisSpec.
    // `params.params` is `unknown` on the contract (`JobCreateRequest.params` is
    // `Record<string, unknown>`), so read `bin_um` through a narrowed local — the same
    // `params.bin_um` read the sibling suite makes (visiumHdRunInputs.test.ts:306).
    const launchedParams = captured[0].params.params as { bin_um?: unknown }
    expect(
      launchedParams.bin_um,
      'the chosen bin reached the job as the string the picker sends',
    ).toBe(String(chosen))
  })

  it('a `has:<capability>` gate opens when the registry lands the capability after the pane mounted (issue #439)', async () => {
    // (a) Mount the REAL declarative render path with the registry carrying ONLY the
    //     bootstrap skeleton — the produced datatype's DECLARED capability is unknown.
    datatypeRegistry.replaceAll(BOOTSTRAP_LATTICE)
    const { viewId } = await mountCapProbePane()

    // The pane is up and rendering its form (a view with no resolvable slice starts
    // `ready`, never a skeleton) — so an absent widget is a CLOSED gate, not a dead pane.
    expect(peekStore(viewId)?.dataStatus, 'the fixture pane is ready').toBe('ready')
    expect(
      screen.queryByTestId(CAP_PROBE_WIDGET_TESTID),
      'the gated widget is hidden while the capability is unknown',
    ).toBeNull()

    // (b) WITHOUT remounting and WITHOUT bumping `catalogEpoch`/`refreshCatalog`, drive the
    //     late populate exactly as boot does.
    await act(async () => {
      datatypeRegistry.replaceAll([...BOOTSTRAP_LATTICE, capProbeDatatype()])
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

    // (c) THE FIX. The `caps` memo must re-derive against the populated lattice and the
    //     gated widget must now render. On the unfixed code (`registryVersion` removed from
    //     the memo deps) the memo stays computed from the bootstrap lattice — `lattice` is
    //     a STABLE reference that never changes identity on `replaceAll` — so the gate
    //     stays closed and this assertion FAILS.
    expect(
      screen.getByTestId(CAP_PROBE_WIDGET_TESTID),
      'the gated widget must render once the registry declares the capability',
    ).toBeTruthy()
  })

  it('a late populate WHILE the first resolve is in flight still lands the populated answer — the request-key half (issue #439)', async () => {
    // (a) Mount the REAL declarative render path with the registry carrying ONLY the
    //     bootstrap skeleton, and the data host's list read HELD so the first resolve
    //     cannot complete. The fixture view declares a plane-reading slice beside the
    //     `container_members` one, so the whole resolve is genuinely in flight — a view
    //     declaring only the pure `container_members` slice would resolve in a microtask
    //     and the window would never open.
    datatypeRegistry.replaceAll(BOOTSTRAP_LATTICE)
    const { viewId, gate } = await mountReresolvePane({ hold: true })

    // The first resolve is OUTSTANDING — the proof the window is real, not a region that
    // never started fetching. (The pane's catalog read and the held slice read both wait
    // on the gate.)
    expect(gate.pending(), 'the first resolve is in flight against the held host').toBeGreaterThan(0)

    // (b) WHILE the first resolve is still in flight, drive the late populate exactly as
    //     boot does — no remount, no `refreshCatalog`, no `catalogEpoch` bump.
    const pendingBeforePopulate = gate.pending()
    await act(async () => {
      datatypeRegistry.replaceAll([manifestDatatype()])
    })
    // Let the re-fired resolve effect issue its own plane read (the gate keeps it held).
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

    // The version bump re-fired the resolve effect and its plane read is caught by the
    // gate too — the second resolve is ALSO in flight. On the unfixed code (the
    // `|registry:${registryVersion}|` segment removed from the request key) the second
    // resolve carries the SAME key as the still-in-flight first one and is swallowed by
    // the same-key guard (`viewData.ts:1637`) — no new read is issued, and this assertion
    // FAILS before the release even happens.
    expect(
      gate.pending(),
      'the re-resolve issued its own plane read — it was not swallowed by the same-key guard',
    ).toBeGreaterThan(pendingBeforePopulate)

    // (c) Release the host and flush.
    await gate.release()

    // (d) THE REQUEST-KEY HALF. The slice must end up holding the POPULATED answer, not
    //     the pre-populate empty one. On the unfixed code the second resolve was swallowed
    //     above, so the first resolve's empty answer lands and this assertion FAILS.
    expect(
      sliceValue(viewId, RERESOLVE_BINS_SLICE),
      'the slice must hold the populated answer, not the pre-populate empty one',
    ).toEqual(offeredBins())
  })
})
