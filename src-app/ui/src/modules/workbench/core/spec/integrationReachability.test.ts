// CAN A PERSON ACTUALLY GET FROM THE LAUNCHER TO A RUNNING INTEGRATION?
//
// Every other suite over this form asks a question about the yaml: does it parse, does it
// declare a `require`, does the launch mention every state field. All of those were GREEN
// while the analysis was absent from the launcher, and while its binding plan resolved to
// the empty plan on every real input — because none of them ever RESOLVES the form's own
// declarations against a catalog shaped like the one a producer writes.
//
// So this file asks the one question the others cannot: starting from the shipped manifest
// and the shipped view, over artifacts shaped the way the real importer emits them, does
// the chain
//
//     launcher visibility → the datasets picker's OFFER → the binding plan → a launchable run
//
// close? Each link is a separate `it`, so a break names the link rather than the whole chain.
//
// ── IT SPELLS NO DOMAIN VOCABULARY, AND THAT IS NOT ONLY THE LINT ──────────────────────
//
// Every datatype id and every axis name below is READ OUT of the shipped declarations —
// the analysis' own `appliesTo`, the picker's own `source`, the slice's own `args`. Two
// reasons, and the second is the load-bearing one:
//
//   · this file lives under `workbench/core`, which may carry none of the domain lattice;
//   · a spelled id silently finds NOTHING after a rename, so a fixture built from spellings
//     degrades into a suite that agrees with itself while disagreeing with every producer.
//     That exact failure — guard and guarded sharing one invented string — is what let an
//     axis nobody declares ship in this very form.
//
// The fixture's SHAPE (which artifact carries the axis index, that a column store declares
// one axis, that the anchor declares two) is transcribed from the importer's emit sites and
// is asserted against them in `integrationGrid.test.ts`'s axis-vocabulary guard.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import type { DatatypeLattice } from '@/modules/workbench/core/datatypes/lattice'
import { resolveArtifactRefSource } from '@/modules/workbench/core/runtime/axisSource'
import {
  type IntegrationGridArgs,
  INTEGRATION_GRID_SOURCE,
  resolveIntegrationGrid,
} from '@/modules/workbench/core/runtime/integrationGrid'
import { isLauncherVisible } from '@/modules/workbench/extensions/analysis/launcherAvailability'

const PACKAGES = fileURLToPath(new URL('../../../../../../packages', import.meta.url))

// ── reading the shipped declarations ────────────────────────────────────────────────────

interface ManifestAnalysis {
  id?: string
  ui?: string[]
  launchable?: boolean
  trigger?: string
  appliesTo?: Array<{ slot?: string; subtypes_of?: string; multiple?: boolean }>
}

interface PackageDoc {
  dir: string
  manifest: {
    contributes?: {
      analyses?: ManifestAnalysis[]
      datatypes?: Array<{ id?: string; extends?: string }>
    }
  }
}

function packages(): PackageDoc[] {
  const out: PackageDoc[] = []
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = `${PACKAGES}/${entry.name}/manifest.yaml`
    if (!existsSync(file)) continue
    out.push({ dir: entry.name, manifest: parseYaml(readFileSync(file, 'utf8')) })
  }
  return out
}

/** The SUBTYPING lattice, built from the shipped datatype contributions.
 *
 *  The real host injects P2's registry; this rebuilds the same reflexive `extends` walk from
 *  the same DATA. Using `identityLattice` instead would make `subtypes_of` mean exact
 *  equality, so a picker naming an abstract supertype would look empty for a reason that
 *  exists only in the test. */
function shippedLattice(): DatatypeLattice {
  const parent = new Map<string, string | undefined>()
  for (const p of packages()) {
    for (const d of p.manifest.contributes?.datatypes ?? []) {
      if (typeof d?.id === 'string') parent.set(d.id, typeof d.extends === 'string' ? d.extends : undefined)
    }
  }
  const isA = (sub: string, sup: string): boolean => {
    let cur: string | undefined = sub
    const seen = new Set<string>()
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === sup) return true
      seen.add(cur)
      cur = parent.get(cur)
    }
    return false
  }
  return { isA, matches: (id, sel) => (sel.subtypes_of ? isA(id, sel.subtypes_of) : id === sel.type_id), get: () => undefined }
}

/** The ONE analysis in the tree whose shipped view declares an `integration_grid` slice.
 *
 *  Selected STRUCTURALLY — by the resolver its own view selects — rather than by spelling an
 *  analysis id. A spelled id survives a rename by silently matching nothing, at which point
 *  every assertion below passes over an empty corpus. */
function integrationForm(): {
  pkg: string
  analysis: ManifestAnalysis
  view: {
    id?: string
    data?: Record<string, { source?: string; args?: Record<string, unknown> }>
    widgets?: Array<Record<string, unknown>>
    actions?: Array<Record<string, unknown>>
  }
  gridKey: string
  gridArgs: IntegrationGridArgs & Record<string, unknown>
} {
  for (const p of packages()) {
    for (const analysis of p.manifest.contributes?.analyses ?? []) {
      for (const rel of analysis.ui ?? []) {
        const file = `${PACKAGES}/${p.dir}/${rel}`
        if (!existsSync(file)) continue
        const view = parseYaml(readFileSync(file, 'utf8'))
        for (const [key, decl] of Object.entries((view?.data ?? {}) as Record<string, { source?: string }>)) {
          if (decl?.source !== INTEGRATION_GRID_SOURCE) continue
          return {
            pkg: p.dir,
            analysis,
            view,
            gridKey: key,
            gridArgs: ((decl as { args?: unknown }).args ?? {}) as IntegrationGridArgs & Record<string, unknown>,
          }
        }
      }
    }
  }
  throw new Error(`no shipped analysis view declares a "${INTEGRATION_GRID_SOURCE}" slice`)
}

const FORM = integrationForm()
const LATTICE = shippedLattice()

/** The picker whose value the grid slice's `of` reference reads — found by following the
 *  `$`-ref, so a renamed control or a re-pointed slice is a FAILURE rather than a silent
 *  fixture of the wrong widget. */
function datasetsPicker(): { id: string; source: { subtypes_of?: string; datatype?: string }; require?: Record<string, unknown>; multiple?: boolean } {
  const ref = String(FORM.gridArgs.of ?? '')
  const field = ref.startsWith('$state.') ? ref.slice('$state.'.length) : ''
  expect(field, `the ${INTEGRATION_GRID_SOURCE} slice's "of" must be a $state reference`).not.toBe('')
  const w = (FORM.view.widgets ?? []).find(
    x => x?.kind === 'artifact_ref' && String(x?.value ?? '') === `$state.${field}`,
  )
  expect(w, `no artifact_ref widget binds $state.${field}, which the binding plan reads`).toBeDefined()
  return w as never
}

/** The datatype the ANALYSIS says it consumes on its one statically-nameable slot. That is
 *  the type every per-dataset column artifact in the fixture carries — taken from the
 *  analysis' own declaration rather than spelled, so the fixture cannot drift from it. */
function columnDatatype(): string {
  const slotted = (FORM.analysis.appliesTo ?? []).find(s => typeof s?.slot === 'string' && s.slot !== '')
  expect(slotted, 'the analysis declares no slot-bearing appliesTo selector').toBeDefined()
  const id = slotted?.subtypes_of
  expect(typeof id, 'that selector declares no subtypes_of').toBe('string')
  return id as string
}

// ── the fixture: artifacts shaped the way the importer emits them ───────────────────────
//
// Per dataset, transcribed from the importer's emit sites:
//   · ONE anchor of the picker's own declared type, declaring BOTH axes (a matrix);
//   · ONE index on the LEVEL axis — `meta.is_axis_index` plus a `content_hash`, which is
//     what keys the compute's cross-check and what `rows` mounts;
//   · one identifier column on the ENTITY axis (what `entity:<i>:<c>` mounts);
//   · one categorical on the LEVEL axis (what `level:<i>:<c>` mounts, once chosen).
//
// The two datasets deliberately share the entity- and level-column NAMES and nothing else:
// every id is distinct and the ARTIFACT id is never the DATASET id, so a resolver that
// relays one where the other is meant cannot pass by coincidence.

const ENTITY_COLUMN = 'shared_identifier'
const LEVEL_COLUMN = 'shared_label'

const entityAxis = String(FORM.gridArgs.entity_axis ?? '')
const levelAxis = String(FORM.gridArgs.level_axis ?? '')

function anchor(dataset: string, datatype: string): ArtifactRow {
  return {
    id: `art-anchor-${dataset}`,
    datatype,
    source_dataset_ids: [dataset],
    structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: [levelAxis, entityAxis], shape: [3, 2] },
  } as unknown as ArtifactRow
}

function column(id: string, dataset: string, axis: string, name: string, index = false): ArtifactRow {
  return {
    id,
    datatype: columnDatatype(),
    source_dataset_ids: [dataset],
    ...(index ? { content_hash: `sha256:${id}` } : {}),
    meta: { name, ...(index ? { is_axis_index: true } : {}) },
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      n: 3,
      ...(index ? { key: 'values', key_sequence_digest: `d-${id}` } : {}),
      columns: [{ path: 'values', name }],
    },
  } as unknown as ArtifactRow
}

/** One dataset's artifacts. `anchorType` is a parameter so the negative control can build a
 *  dataset that carries everything EXCEPT an artifact the picker would offer. */
function datasetArtifacts(dataset: string, anchorType: string | undefined): ArtifactRow[] {
  return [
    ...(anchorType === undefined ? [] : [anchor(dataset, anchorType)]),
    column(`art-idx-${dataset}`, dataset, levelAxis, `${dataset}_index`, true),
    column(`art-ent-${dataset}`, dataset, entityAxis, ENTITY_COLUMN),
    column(`art-lvl-${dataset}`, dataset, levelAxis, LEVEL_COLUMN),
  ]
}

const DATASETS = ['ds-first', 'ds-second']

function catalogFor(anchorType: string | undefined): ArtifactRow[] {
  return DATASETS.flatMap(d => datasetArtifacts(d, anchorType))
}

// ────────────────────────────────────────────────────────────────────────────────────────

describe('a person can reach a running integration from the launcher', () => {
  it('the fixture is anchored in the shipped declarations, not in this file', () => {
    // Non-vacuity for everything below: an empty axis name or an empty datatype would make
    // every later assertion an assertion about nothing.
    expect(entityAxis, 'the binding plan declares no entity axis').not.toBe('')
    expect(levelAxis, 'the binding plan declares no level axis').not.toBe('')
    expect(entityAxis).not.toBe(levelAxis)
    expect(columnDatatype()).not.toBe('')
    // The lattice must be a real one: a subtype relation that holds nowhere would make the
    // picker's `subtypes_of` behave as exact equality and hide a real narrowing defect.
    const anchorType = datasetsPicker().source.subtypes_of ?? datasetsPicker().source.datatype ?? ''
    expect(anchorType, 'the datasets picker declares no datatype constraint').not.toBe('')
    expect(LATTICE.isA(anchorType, anchorType)).toBe(true)
  })

  // LINK 1 — the launcher. `launchable: false` keeps an analysis registered but removes it
  // from the launcher, so no amount of correctness below is reachable by a person.
  it('the analysis is VISIBLE in the launcher', () => {
    expect(
      isLauncherVisible(FORM.analysis as never),
      `${FORM.pkg} declares launchable: ${String(FORM.analysis.launchable)}, so the form is ` +
        'registered but has no entry a user can click',
    ).toBe(true)
  })

  // LINK 2 — the OFFER. The picker anchors the whole plan, so a predicate no dataset carries
  // an artifact of leaves a required control with nothing to choose and the form dead at its
  // FIRST field.
  it('the datasets picker offers at least one candidate for EVERY dataset', () => {
    const picker = datasetsPicker()
    const anchorType = (picker.source.subtypes_of ?? picker.source.datatype) as string
    const offered = resolveArtifactRefSource(catalogFor(anchorType), picker.source, {}, { lattice: LATTICE })
    const catalog = catalogFor(anchorType)
    const byId = new Map(catalog.map(a => [a.id, a]))
    const covered = new Set(
      offered.flatMap(c => ((byId.get(c.id) as { source_dataset_ids?: string[] } | undefined)?.source_dataset_ids ?? [])),
    )
    expect(
      [...covered].sort(),
      "the picker's datatype predicate names something one of these datasets carries no " +
        'artifact of, so that dataset is unselectable and cannot take part',
    ).toEqual([...DATASETS].sort())
  })

  it('a dataset carrying no artifact of that type is NOT offered (the negative control)', () => {
    // Without this, the assertion above could pass against a predicate that matches
    // everything — "every dataset is covered" is trivially true of an unfiltered offer.
    const picker = datasetsPicker()
    const anchorType = (picker.source.subtypes_of ?? picker.source.datatype) as string
    const offered = resolveArtifactRefSource(catalogFor(undefined), picker.source, {}, { lattice: LATTICE })
    expect(
      offered,
      'every dataset in this catalog carries columns but no anchor artifact, so the picker ' +
        'must offer nothing — an offer here means the predicate is not narrowing at all',
    ).toEqual([])
  })

  // LINK 3 — the BINDING PLAN, resolved from the view's OWN slice arguments. This is the
  // link the missing axes broke: the resolver refuses rather than guessing, so an omission
  // makes `ready` permanently false and every mount list permanently empty.
  it('the offered candidates resolve to a READY binding plan', () => {
    const picker = datasetsPicker()
    const anchorType = (picker.source.subtypes_of ?? picker.source.datatype) as string
    const catalog = catalogFor(anchorType)
    const offered = resolveArtifactRefSource(catalog, picker.source, {}, { lattice: LATTICE })
    const grid = resolveIntegrationGrid(catalog, FORM.gridArgs, offered.map(c => c.id), [LEVEL_COLUMN])

    expect(grid.blocked, 'a source the plan had to exclude').toEqual([])
    expect(
      grid.ready,
      'the plan is not launchable, so the run would carry no mounts even with every control answered',
    ).toBe(true)
    // The mounts a launch actually carries — `inputs.rows` and the two `inputs_from`
    // families. Asserting `ready` alone would pass over an empty plan if the readiness rule
    // ever loosened.
    expect(grid.rows.length, 'one row index per dataset — the literal `rows` slot').toBe(DATASETS.length)
    expect(grid.entityBindings.length, 'no entity: binding — nothing to join on').toBeGreaterThanOrEqual(
      DATASETS.length,
    )
    expect(grid.levelBindings.length, 'the chosen column is not bound on both datasets').toBe(DATASETS.length)
    // DATASET ids, never the picker's ARTIFACT ids: the detach guard parses these against
    // the datasets table, and an artifact id is a well-formed value that can never match.
    expect(grid.datasetIds.slice().sort()).toEqual([...DATASETS].sort())
    for (const id of grid.rows) expect(Object.keys(grid.contentHashes).length).toBe(DATASETS.length)
  })

  // LINK 4 — the two column offers must speak about the SAME axis. `levelColumns` is chosen
  // from the compatible-column slice and consumed as `level:<i>:<column>` bindings, so an
  // axis disagreement makes every choice a user can make bind nothing — with both sides
  // individually defensible and the surface merely empty.
  it('the fusable-column offer and the level bindings read one axis', () => {
    const compatible = Object.values(FORM.view.data ?? {}).filter(
      d => d?.source !== INTEGRATION_GRID_SOURCE && typeof d?.args?.axis === 'string',
    )
    expect(compatible.length, 'no sibling slice declares a literal axis to compare against').toBeGreaterThan(0)
    for (const slice of compatible) {
      expect(
        slice.args?.axis,
        'a column offer slices one axis while the binding plan fuses another, so nothing a ' +
          'user chooses from it can bind',
      ).toBe(levelAxis)
    }
  })
  // LINK 5 — THE INPUT'S OWN DECLARATION. A dataset is eligible as an integration input only
  // if its row index declares the axis the view names; the resolver string-matches the LABEL
  // (`declaredAxes(...).includes(axis)`) and has nothing else to go on.
  //
  // That is why a PRODUCED dataset must carry its sources' axis KIND through rather than
  // minting a name for its own row space. A virtual (integrated) dataset used to declare a
  // minted `unified_rows`, and this A/B is exactly the difference that made: the two catalogs
  // below differ in ONE STRING, on one artifact, and nothing else.
  it('an input whose row index declares a MINTED axis is refused; the shared kind is accepted', () => {
    const picker = datasetsPicker()
    const anchorType = (picker.source.subtypes_of ?? picker.source.datatype) as string

    // Positive control first: unmodified, this catalog is READY (LINK 3 asserts the same, and
    // it must hold HERE too or the negative below proves nothing).
    const shared = catalogFor(anchorType)
    const offeredShared = resolveArtifactRefSource(shared, picker.source, {}, { lattice: LATTICE })
    const ready = resolveIntegrationGrid(shared, FORM.gridArgs, offeredShared.map(c => c.id), [])
    expect(ready.ready, 'the unmodified fixture must be launchable for the A/B to isolate the label').toBe(true)

    // …now mint an axis for ONE dataset's row index. A name no view declares — derived from
    // the shipped one so it cannot accidentally BE a declared axis.
    const MINTED = `unified_${levelAxis}`
    expect(MINTED).not.toBe(levelAxis)
    const minted = catalogFor(anchorType).map(a =>
      a.id === `art-idx-${DATASETS[0]}`
        ? ({ ...a, structure: { ...(a.structure as object), axis: MINTED } } as ArtifactRow)
        : a,
    )
    const offeredMinted = resolveArtifactRefSource(minted, picker.source, {}, { lattice: LATTICE })
    const grid = resolveIntegrationGrid(minted, FORM.gridArgs, offeredMinted.map(c => c.id), [])

    expect(
      grid.blocked.map(b => b.dataset),
      'a row index under a name the view does not declare matches nothing, so the dataset ' +
        'cannot take part — no matter what the picker offered',
    ).toEqual([DATASETS[0]])
    expect(grid.ready, 'and a partial plan must never launch').toBe(false)
  })
})
