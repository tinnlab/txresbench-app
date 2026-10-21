// THE DERIVATION IS CONNECTED TO THE SHIPPED CONTAINER DECLARATION (issue #361) — the
// `container_members` source must offer what the SHIPPED container ACTUALLY declares,
// not a copy of it.
//
// The unit suite (`containerMembers.test.ts`) proves the pure resolver against neutral
// fixtures. This file proves the OTHER half: that the resolver, fed the REAL members the
// SHIPPED container declares, produces exactly the options that declaration implies.
//
// What each test proves, precisely:
//   · "offers exactly the bins the shipped container declares" catches DRIFT between the
//     declaration and the offer: the expectation is COMPUTED from the parsed members —
//     never written down — so a fourth declared bin, or a literal list that no longer
//     matches the declaration, fails here. It does NOT catch a resolver that returns a
//     literal equal to today's declaration: such a resolver matches the computed
//     expectation and this test stays green.
//   · "the resolver reads its INPUT, not a constant" catches exactly that: fed a SYNTHETIC
//     declaration deliberately different from the shipped one, the resolver must track the
//     input — a resolver that ignores its argument and returns a constant cannot pass.
//
// The container is found STRUCTURALLY, never by name: the manifest container whose members
// carry the MOST path segments (the HD bundle's `square_NNNum/…` members are the deepest in
// the package) — the same shape-based selection `hd_bundle_group_test.rs` makes over the
// live registry. The derived id is then CROSS-CHECKED against the shipped view
// (`import-hd.yaml`) and the analysis manifest (`spatial-import-visium-hd/manifest.yaml`),
// so a divergence between the view's declared datatype and the container's declaration
// fails here rather than drifting.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { InputRequirements } from '@/core/datatypes/types'
import { resolveContainerMembers, type ContainerMemberOption } from './containerMembers'

const SPATIAL_TYPES_MANIFEST = fileURLToPath(
  new URL('../../../../../../packages/spatial-types/manifest.yaml', import.meta.url),
)
const HD_UI = fileURLToPath(
  new URL('../../../../../../packages/spatial-import-visium-hd/ui/import-hd.yaml', import.meta.url),
)
const HD_MANIFEST = fileURLToPath(
  new URL('../../../../../../packages/spatial-import-visium-hd/manifest.yaml', import.meta.url),
)

interface RawDatatype {
  id: string
  input_requirements?: { requires?: string; members?: string[]; allow_archive?: boolean }
}

const manifest = parseYaml(readFileSync(SPATIAL_TYPES_MANIFEST, 'utf8')) as {
  contributes: { datatypes: RawDatatype[] }
}

/** The number of path segments in the DEEPEST declared member — the shape key the
 *  derivation selects on, exactly as `hd_bundle_group_test.rs`'s `Container::depth` does. */
function containerDepth(d: RawDatatype): number {
  return (d.input_requirements?.members ?? []).reduce(
    (max, m) => Math.max(max, m.split('/').length),
    0,
  )
}

/** The SHIPPED container's id, derived STRUCTURALLY — the manifest container whose members
 *  carry the MOST path segments. The HD bundle's `square_NNNum/…` members are the deepest in
 *  the package, so this is the same shape-based selection `hd_bundle_group_test.rs` makes
 *  over the live registry; nothing here names a contributed id. */
function shippedContainerId(): string {
  const containers = manifest.contributes.datatypes.filter(
    d =>
      d.input_requirements?.requires === 'manifest' &&
      (d.input_requirements.members?.length ?? 0) > 0,
  )
  if (containers.length === 0) {
    throw new Error(
      'the shipped manifest declares no manifest container — the derivation would be vacuous',
    )
  }
  const deepest = containers.reduce((a, b) => (containerDepth(b) > containerDepth(a) ? b : a))
  if (containerDepth(deepest) < 2) {
    throw new Error(
      'no shipped container declares a path-segment member — the derivation would be vacuous',
    )
  }
  return deepest.id
}

/** The SHIPPED container's declaration, read from disk by the id derived above. */
const hdBundleId = shippedContainerId()
const hdBundle = manifest.contributes.datatypes.find(d => d.id === hdBundleId)

/** The id the SHIPPED view and the SHIPPED analysis manifest declare for the container the
 *  `container_members` slice reads — the `data:` slice's `args.datatype`, the artifact_ref
 *  widget's `source.datatype`, and the analysis' `appliesTo[].type_id`. Reading all three
 *  makes the cross-check STRICTER: the derived id must agree with every declaration, so a
 *  divergence between the view's declared datatype and the container's declaration fails
 *  here rather than drifting. */
function shippedDeclaredIds(): string[] {
  const view = parseYaml(readFileSync(HD_UI, 'utf8')) as {
    data?: Record<string, { args?: { datatype?: string } }>
    widgets?: Array<{ kind?: string; source?: { datatype?: string } }>
  }
  const analysis = parseYaml(readFileSync(HD_MANIFEST, 'utf8')) as {
    contributes: {
      analyses: Array<{ ui?: string[]; appliesTo?: Array<{ type_id?: string }> }>
    }
  }
  // The analysis is found BY NAME, never by position: the manifest's `ui:` list names the
  // view file this test loads, so the analysis whose list contains that file name is the
  // one whose declaration is under test — whatever order the contributor wrote it in.
  const viewFileName = path.basename(HD_UI)
  const shippedAnalysis = analysis.contributes.analyses.find(a =>
    (a.ui ?? []).some(entry => path.basename(entry) === viewFileName),
  )
  if (!shippedAnalysis) {
    throw new Error(
      'the shipped analysis manifest must declare an analysis whose ui: list names the shipped view file — the cross-check would be vacuous',
    )
  }
  // The `appliesTo` entry is matched by its `type_id` against the container id derived
  // STRUCTURALLY above — strictly stronger than element 0, because a mismatch between the
  // analysis' declared container and the derived one now fails here.
  const appliesTo = shippedAnalysis.appliesTo?.find(a => a.type_id === hdBundleId)
  if (!appliesTo) {
    throw new Error(
      `the shipped analysis must declare appliesTo for the derived container id ${hdBundleId} — the cross-check would be vacuous`,
    )
  }
  const declared = [
    view.data?.bins?.args?.datatype,
    view.widgets?.find(w => w.kind === 'artifact_ref')?.source?.datatype,
    appliesTo.type_id,
  ]
  for (const id of declared) {
    if (!id) {
      throw new Error(
        'the shipped view/analysis must declare the container datatype — the cross-check would be vacuous',
      )
    }
  }
  return declared as string[]
}

/** The SHIPPED manifest container's `input_requirements`, or a loud failure naming what is
 *  missing — a test that silently derived from nothing would be a test that asserts nothing.
 *  Returns the NARROWED manifest variant, so callers can read `members` without re-narrowing
 *  the `InputRequirements` union. */
function shippedRequirements(): Extract<InputRequirements, { requires: 'manifest' }> {
  if (!hdBundle) {
    throw new Error(
      `the shipped manifest must declare the derived container id ${hdBundleId}`,
    )
  }
  const requirements = hdBundle.input_requirements
  if (!requirements || requirements.requires !== 'manifest' || !requirements.members?.length) {
    throw new Error(
      `the derived container ${hdBundleId} must declare a manifest input_requirements with a non-empty member list`,
    )
  }
  return requirements as Extract<InputRequirements, { requires: 'manifest' }>
}

/** The offer the SHIPPED member list implies, derived IN THE TEST — distinct leading path
 *  segments, each carrying its single embedded integer, ascending by that integer.
 *  Deliberately a re-derivation rather than a copy of `resolveContainerMembers`, so the two
 *  implementations must agree on the real declaration. */
function expectedOptions(members: string[]): ContainerMemberOption[] {
  const segments = [...new Set(members.map(m => m.split('/')[0]))]
  const options = segments.map(segment => {
    const runs = segment.match(/\d+/g)
    const value = runs && runs.length === 1 ? Number(runs[0]) : segment
    return { value, label: segment }
  })
  const allNumeric = options.every(o => typeof o.value === 'number')
  if (allNumeric) {
    options.sort(
      (a, b) => (a.value as number) - (b.value as number) || a.label.localeCompare(b.label),
    )
  } else {
    options.sort((a, b) => a.label.localeCompare(b.label))
  }
  return options
}

describe('container_members — derived from the SHIPPED container declaration, not enumerated', () => {
  it('the derived container id is the one the shipped view and the analysis manifest declare', () => {
    // NON-VACUITY: a derivation that silently returned `undefined` would make every other
    // assertion pass trivially. The id must be a non-empty string that the SHIPPED view
    // declares (the `container_members` slice args and the bundle picker's source) and that
    // the analysis manifest declares (`appliesTo[].type_id`) — and all three must agree with
    // the container the members were read from.
    expect(hdBundleId).toBeTruthy()
    expect(typeof hdBundleId).toBe('string')
    for (const declared of shippedDeclaredIds()) {
      expect(declared).toBe(hdBundleId)
    }
  })

  it('offers exactly the bins the shipped container declares', () => {
    // The defect this catches: DRIFT between the declaration and the offer — a derivation
    // that reads a different source than the container's own declaration, or a literal list
    // that no longer matches it. The expectation is computed from the parsed members, so a
    // fourth declared bin changes the expectation and a stale literal `[2,8,16]` stops
    // matching it. It does NOT catch a literal equal to today's declaration — that is the
    // synthetic-input test below.
    const requirements = shippedRequirements()
    const got = resolveContainerMembers(requirements)
    expect(got).toEqual(expectedOptions(requirements.members))
  })

  it('the resolver reads its INPUT, not a constant', () => {
    // The defect this catches: `resolveContainerMembers` replaced by a literal list equal to
    // today's shipped answer. The shipped-offer test above compares the resolver against the
    // expectation COMPUTED from the shipped members — and a literal equal to that expectation
    // passes it, because the expectation and the literal agree. So this test feeds the SAME
    // pure function a SYNTHETIC manifest declaration deliberately different from the shipped
    // one — different grouped leading segments carrying different embedded integers — and
    // requires the output to track THAT input, and to differ from the shipped offer. A
    // resolver that ignores its argument cannot pass.
    const synthetic: InputRequirements = {
      requires: 'manifest',
      members: ['tile_004/a.csv', 'tile_004/b.csv', 'tile_032/c.csv', 'tile_064/d.csv'],
      allow_archive: true,
    }
    const shippedOffer = resolveContainerMembers(shippedRequirements())
    const got = resolveContainerMembers(synthetic)
    expect(got).toEqual([
      { value: 4, label: 'tile_004' },
      { value: 32, label: 'tile_032' },
      { value: 64, label: 'tile_064' },
    ])
    expect(got).not.toEqual(shippedOffer)
  })

  it('the derived offer is non-vacuous: at least three bins, every value a NUMBER, ascending', () => {
    // The defect this catches: a derivation that returns nothing (an empty offer would pass a
    // test that only compared against itself), or one that returns the segments as STRINGS —
    // which would break the compute's `select_bin` contract (it refuses a non-int/float).
    const requirements = shippedRequirements()
    const got = resolveContainerMembers(requirements)
    expect(got.length, 'an empty offer would pass a test that asserts nothing').toBeGreaterThanOrEqual(3)
    for (const option of got) {
      expect(typeof option.value, `bin "${option.label}" must carry a numeric value`).toBe('number')
    }
    const values = got.map(o => o.value as number)
    for (let i = 1; i < values.length; i++) {
      expect(values[i], 'the offer must be ascending by embedded integer').toBeGreaterThan(values[i - 1])
    }
  })
})
