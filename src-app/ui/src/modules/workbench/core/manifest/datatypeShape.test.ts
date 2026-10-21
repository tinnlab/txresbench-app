// TEST-7 (unit) [acceptance] [invariant: INV-7] [covers: ITEM-13]
//
// INV-7 — "Upload formats are opaque. A container that exists to be imported or exported
// is not analysable and declares no internal structure."
// (`docs/design/processor-manifest-ui-separation.md`, AMENDED 2026-08-04.)
//
// ── THE AMENDMENT THIS FILE IS WRITTEN AGAINST ──────────────────────────────────────
//
// Read literally, "declares no internal structure" was taken to include a container's
// `axes`, and removing them broke seven `dataset::supporting_*` integration tests: the
// dataset routes validate a supporting file's axis against the axes of the DATASET's
// datatype, and for an upload that datatype IS the container. Attaching a per-row
// annotation table to an upload therefore 422'd — a real capability that exists precisely
// at upload time, before anything has been parsed. The code was reverted; the design was
// then amended with two explicit tables, and the dividing line was named:
//
//   MAY declare (the BOUNDARY — how it arrives, leaves, and is joined to)
//     `axes` (`name` + `key_label`) · `ingest` · `input_requirements` ·
//     `storage.file_layout` · a dispatch-marker `capability`
//
//   MAY NOT declare (the CONTENTS — untrue until an importer has run)
//     `capabilities` describing contents · a non-`opaque_as_is` `storage.layout` ·
//     `schema` · `arrays`
//
// `.lifecycle/…/TESTS.md`'s original TEST-7 text ("declare no axes") predates that
// amendment and is STALE; it has been corrected in place, with the reason recorded there.
// This file asserts the AMENDED design. Writing it against the pre-amendment wording would
// have re-certified the exact regression the amendment exists to prevent.
//
// ── Why it is written against NEW fixture datatypes ─────────────────────────────────
//
// INV-7 is a rule about ANY opaque container, so the discriminating power lives in
// fixtures the tree has never seen: a compliant one (declaring the whole PERMITTED
// boundary set) must pass, and one variant per forbidden claim must be refused BY NAME.
// Asserting only that today's shipped containers happen to be clean would pass against a
// checker that does nothing.
//
// The shipped arm is then the same predicate applied to every import surface ENUMERATED
// FROM THE TREE — never a written-down id — so a container added later is covered on the
// next run rather than silently skipped. Its subject set is deliberately NOT "the types
// that extend `data/opaque`": see `importSurfaceIds` for the measured reason (that
// selection makes the whole arm vacuous under a re-parent, which is one of the two
// regressions it exists to catch).
//
// ── The one clause that is not fully machine-decidable, stated plainly ──────────────
//
// "`capabilities` describing contents" is given in the design by example
// (contents: sliceable / has-rows-ish claims · boundary: a dispatch marker), with no
// syntactic rule separating them. The mechanical reading used here is derived from the
// design's own dividing line rather than from a spelling list: a capability an opaque
// container declares must NOT also be declared by an ANALYSABLE datatype, because an
// analysable type's capabilities ARE claims about its bytes, while a routing key is
// unique to the thing it routes. That reproduces every may-not example in the design
// without naming one. Its residual gap is real and is asserted nowhere: a brand-new
// contents-claim capability declared ONLY by a container would pass. See the report note.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { DatatypeRegistry } from '@/core/datatypes/registry'
import { BOOTSTRAP_LATTICE } from '@/core/datatypes/builtin'
import type { Datatype } from '@/core/datatypes/types'

// ── the rule, as a predicate over ONE declaration ───────────────────────────────────

/** The lattice root that WITHDRAWS analysability. A container is opaque by extending it —
 *  never by withholding a boundary fact (the amendment's closing sentence). */
const OPAQUE_ROOT = 'data/opaque'

/** The only fields an axis may carry: IDENTITY. Mirrors the `AxisSpec` contract; an axis
 *  carrying anything more is back to forecasting what sits on it. */
const AXIS_IDENTITY_FIELDS = new Set(['name', 'key_label'])

/** A datatype declaration as it is AUTHORED (the manifest/API shape), before the registry
 *  fills the fields `isA` does not read. Deliberately loose: the point is to inspect what
 *  an author WROTE, including keys the rule forbids. */
type RawDatatype = Record<string, unknown> & { id: string; extends?: string | null }

const asRecord = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * Every way `dt` — already established to be an opaque container — breaks INV-7, as
 * human-readable reasons NAMING the offending key. Empty ⇒ compliant.
 *
 * `analysableCapabilities` is the union of the capabilities declared by the NON-opaque
 * types of the same lattice; see the header for why that set is the mechanical reading of
 * "a capability describing contents".
 */
function contentsClaims(dt: RawDatatype, analysableCapabilities: ReadonlySet<string>): string[] {
  const out: string[] = []

  if (dt.schema !== undefined) {
    out.push('declares `schema` — the internal dimensions of bytes nothing has parsed yet')
  }

  const layoutKind = asRecord(asRecord(dt.storage).layout).kind
  if (layoutKind !== 'opaque_as_is') {
    out.push(`declares \`storage.layout\` \`${String(layoutKind)}\` — an internal encoding claim`)
  }

  if (asArray(dt.arrays).length > 0) {
    out.push('declares `arrays` — the arrays inside the container')
  }

  for (const cap of asArray(dt.capabilities)) {
    if (typeof cap === 'string' && analysableCapabilities.has(cap)) {
      out.push(`declares \`capabilities\` entry \`${cap}\`, which an ANALYSABLE type also claims`)
    }
  }

  for (const axis of asArray(dt.axes)) {
    const extra = Object.keys(asRecord(axis)).filter(k => !AXIS_IDENTITY_FIELDS.has(k))
    if (extra.length > 0) {
      out.push(`declares an axis carrying more than identity: \`${extra.join('`, `')}\``)
    }
  }

  return out
}

/**
 * The BOUNDARY half of the amendment, as its own predicate: a container a user HANDS OVER
 * (it declares `input_requirements`) must declare the axis VOCABULARY a supporting file
 * aligns to. This is the clause the reverted regression violated — with no axes, every
 * axis is unknown and an annotation table attached to an upload is refused.
 */
function missingBoundaryFacts(dt: RawDatatype): string[] {
  const out: string[] = []
  if (dt.input_requirements !== undefined && asArray(dt.axes).length === 0) {
    out.push(
      'is handed over by a user (`input_requirements`) but declares NO `axes` — a supporting ' +
        'file then has no axis vocabulary to align to, which is resolvable before the bytes are read',
    )
  }
  return out
}

// ── the shipped tree, ENUMERATED (never a written-down id) ──────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `…/ui/src/modules/workbench/core/manifest` → `src-app/packages` (the same depth the
 *  production discovery glob in `runtime/loadProcessors.ts` walks). */
const PROCESSORS = path.resolve(HERE, '../../../../../../packages')

interface ShippedTree {
  datatypes: RawDatatype[]
  /** every `subtypes_of` any shipped analysis selects on — the bases an import surface
   *  must never fall under, or it would be OFFERED for analysis. */
  analysisSubtypeBases: string[]
  /**
   * Every datatype a CONVERTER accepts as a PRIMARY input (an `accepts` entry with no
   * `role: supporting`) — i.e. every type that exists to be IMPORTED.
   *
   * This is read from the CONVERTERS, not from the lattice, and that is the whole point.
   * Selecting the subject set by "extends `data/opaque`" makes every assertion below
   * vacuous under exactly the regression they exist to catch: re-parent a container back
   * into the analysable subtree and it silently leaves the set, so nothing checks it and
   * the suite stays green. (Measured — that mutation passed until this was added.) A
   * converter's `accepts` is independent of the `extends` edge, so it still names the
   * container after somebody moves it.
   */
  importSurfaceIds: string[]
}

function readShippedTree(): ShippedTree {
  const datatypes: RawDatatype[] = []
  const bases = new Set<string>()
  const imported = new Set<string>()
  const dirs = existsSync(PROCESSORS)
    ? readdirSync(PROCESSORS, { withFileTypes: true }).filter(e => e.isDirectory())
    : []
  for (const dir of dirs) {
    const file = path.join(PROCESSORS, dir.name, 'manifest.yaml')
    if (!existsSync(file)) continue
    const manifest = asRecord(parseYaml(readFileSync(file, 'utf8')))
    const contributes = asRecord(manifest.contributes)
    for (const dt of asArray(contributes.datatypes)) {
      const rec = asRecord(dt)
      if (typeof rec.id === 'string') datatypes.push(rec as RawDatatype)
    }
    for (const analysis of asArray(contributes.analyses)) {
      for (const sel of asArray(asRecord(analysis).appliesTo)) {
        const base = asRecord(sel).subtypes_of
        if (typeof base === 'string') bases.add(base)
      }
    }
    for (const converter of asArray(contributes.converters)) {
      for (const accept of asArray(asRecord(converter).accepts)) {
        const rec = asRecord(accept)
        if (rec.role === 'supporting') continue
        if (typeof rec.type_id === 'string') imported.add(rec.type_id)
      }
    }
  }
  return {
    datatypes,
    analysisSubtypeBases: [...bases].sort(),
    importSurfaceIds: [...imported].sort(),
  }
}

// ── the REAL registry, over roots + declarations ────────────────────────────────────

/** Fill the fields the REGISTRY needs but the rule does not inspect, so `isA` / `matches`
 *  are the shipped implementations run over the shipped declarations. Only `id`,
 *  `extends` and `capabilities` are load-bearing here. */
function toDatatype(raw: RawDatatype): Datatype {
  return {
    id: raw.id,
    extends: (raw.extends as string | null | undefined) ?? null,
    title: String(raw.title ?? raw.id),
    description: '',
    storage: {
      layout: (asRecord(asRecord(raw.storage).layout) as Datatype['storage']['layout']) ?? {
        kind: 'opaque_as_is',
      },
      format: String(asRecord(raw.storage).format ?? ''),
      selector_map: {},
      file_layout: 'single',
      tiers: ['tier1_range_client_decode'],
    },
    capabilities: asArray(raw.capabilities).filter((c): c is string => typeof c === 'string'),
    viewers: [],
    converters: [],
    is_abstract: raw.is_abstract === true,
  }
}

/** A registry holding the six universal ROOTS plus `declarations` — the same composition
 *  the app holds after `GET /api/datatypes` populates it. */
function registryOver(declarations: RawDatatype[]): DatatypeRegistry {
  const reg = new DatatypeRegistry()
  reg.replaceAll([...BOOTSTRAP_LATTICE, ...declarations.map(toDatatype)])
  return reg
}

/** The opaque CONTAINERS among `declarations` (the root itself excluded). */
function opaqueContainers(reg: DatatypeRegistry, declarations: RawDatatype[]): RawDatatype[] {
  return declarations.filter(d => d.id !== OPAQUE_ROOT && reg.isA(d.id, OPAQUE_ROOT))
}

/** The capabilities the ANALYSABLE (non-opaque) declarations claim. */
function analysableCapabilities(reg: DatatypeRegistry, declarations: RawDatatype[]): Set<string> {
  const out = new Set<string>()
  for (const d of declarations) {
    if (reg.isA(d.id, OPAQUE_ROOT)) continue
    for (const cap of asArray(d.capabilities)) if (typeof cap === 'string') out.add(cap)
  }
  return out
}

// ── ARM 1 — a NEW fixture lattice (the discriminating half) ─────────────────────────

/** An ANALYSABLE fixture type. Its capabilities are what make a container's copy of one a
 *  CONTENTS claim. */
const FIXTURE_ANALYSABLE: RawDatatype = {
  id: 'probe/frame',
  extends: 'matrix',
  title: 'Probe frame',
  capabilities: ['probe-sliceable', 'probe-has-rows'],
  storage: { layout: { kind: 'chunked_sparse', orientation: 'csc' }, format: 'zarr' },
  schema: { type: 'object' },
  axes: [{ name: 'rows', key_label: 'row_key' }],
}

/** A COMPLIANT fixture container: the whole PERMITTED boundary set and nothing else. */
const FIXTURE_CONTAINER: RawDatatype = {
  id: 'probe/bundle',
  extends: OPAQUE_ROOT,
  title: 'Probe bundle',
  storage: { layout: { kind: 'opaque_as_is' }, format: 'bundle', file_layout: 'manifest' },
  ingest: { extensions: ['bundle'], magic: [] },
  input_requirements: { requires: 'single' },
  capabilities: ['probe-bundle-target'],
  axes: [
    { name: 'rows', key_label: 'row_key' },
    { name: 'cols', key_label: 'col_key' },
  ],
}

/** One broken variant per forbidden claim, each naming the substring its refusal must
 *  carry. Built from the COMPLIANT container so exactly one thing differs. */
const BROKEN_CONTAINERS: ReadonlyArray<[label: string, patch: Partial<RawDatatype>, names: string]> = [
  ['a `schema`', { schema: { rows: 'n', cols: 'm' } }, 'schema'],
  [
    'a non-opaque `storage.layout`',
    { storage: { layout: { kind: 'chunked_sparse', orientation: 'csc' }, format: 'zarr' } },
    'storage.layout',
  ],
  [
    '`arrays`',
    { arrays: [{ name: 'values', kind: 'sparse', dims: [{ axis: 'rows' }], attrs: [], layout: { kind: 'chunked_sparse', orientation: 'csc' }, selector_map: {} }] },
    'arrays',
  ],
  [
    'a contents `capabilities` entry',
    { capabilities: ['probe-bundle-target', 'probe-sliceable'] },
    'probe-sliceable',
  ],
  [
    'an axis carrying more than identity',
    { axes: [{ name: 'rows', key_label: 'row_key', annotations: [{ name: 'score' }] }] },
    'annotations',
  ],
]

describe('INV-7 (TEST-7): a fixture opaque container — the boundary is permitted', () => {
  const declarations = [FIXTURE_ANALYSABLE, FIXTURE_CONTAINER]
  const reg = registryOver(declarations)
  const caps = analysableCapabilities(reg, declarations)

  it('resolves as a subtype of the opaque root and NOT of the analysable base', () => {
    expect(reg.isA(FIXTURE_CONTAINER.id, OPAQUE_ROOT)).toBe(true)
    expect(reg.isA(FIXTURE_CONTAINER.id, FIXTURE_ANALYSABLE.id)).toBe(false)
    // …and it is not in the analysable subtree at all, which is the property that keeps it
    // out of every `subtypes_of` selector rooted there.
    expect(reg.isA(FIXTURE_CONTAINER.id, 'matrix')).toBe(false)
    // the positive control — the analysable fixture IS, so the two `false`s above are not
    // an artifact of a lattice that answers `false` to everything.
    expect(reg.isA(FIXTURE_ANALYSABLE.id, 'matrix')).toBe(true)
  })

  it('is therefore NOT offered by an analysis whose `appliesTo` selects the analysable base', () => {
    const selector = { subtypes_of: 'matrix' }
    expect(reg.matches(FIXTURE_CONTAINER.id, selector)).toBe(false)
    expect(reg.matches(FIXTURE_ANALYSABLE.id, selector)).toBe(true)
  })

  it('DECLARES its axes, ingest, input_requirements, file_layout and dispatch marker — all clean', () => {
    // Every one of these is in the design's MAY-declare table. A checker that refused any
    // of them would be the reverted regression wearing a test.
    expect(FIXTURE_CONTAINER.axes).toBeDefined()
    expect(FIXTURE_CONTAINER.ingest).toBeDefined()
    expect(FIXTURE_CONTAINER.input_requirements).toBeDefined()
    expect(asRecord(FIXTURE_CONTAINER.storage).file_layout).toBeDefined()
    expect(FIXTURE_CONTAINER.capabilities).toEqual(['probe-bundle-target'])

    expect(contentsClaims(FIXTURE_CONTAINER, caps)).toEqual([])
    expect(missingBoundaryFacts(FIXTURE_CONTAINER)).toEqual([])
  })

  it.each(BROKEN_CONTAINERS)('REFUSES a container declaring %s, naming the key', (_label, patch, names) => {
    const broken = { ...FIXTURE_CONTAINER, ...patch } as RawDatatype
    const violations = contentsClaims(broken, caps)
    expect(violations.length, `no violation reported for ${JSON.stringify(patch)}`).toBeGreaterThan(0)
    expect(violations.join(' | ')).toContain(names)
  })

  it('REFUSES an uploadable container that declares NO axes (the reverted regression)', () => {
    // The literal shape of the bug the amendment records: axes removed from an upload
    // container "because an opaque container has no internal structure".
    const noAxes = { ...FIXTURE_CONTAINER, axes: [] } as RawDatatype
    expect(missingBoundaryFacts(noAxes).join(' | ')).toContain('`axes`')
    // …and it is the UPLOADABILITY that makes it a violation, not the absence itself: a
    // container nobody hands over may legitimately declare none.
    const notUploaded = { ...noAxes }
    delete (notUploaded as Record<string, unknown>).input_requirements
    expect(missingBoundaryFacts(notUploaded)).toEqual([])
  })
})

// ── ARM 2 — every SHIPPED container, enumerated from the tree ───────────────────────

describe('INV-7 (TEST-7): every shipped import surface obeys the same rule', () => {
  const tree = readShippedTree()
  const reg = registryOver(tree.datatypes)
  const caps = analysableCapabilities(reg, tree.datatypes)

  /** The SUBJECT SET: everything that is opaque-by-declaration, UNION everything a
   *  converter imports. The union is what survives a re-parent — see `importSurfaceIds`. */
  const byId = new Map(tree.datatypes.map(d => [d.id, d]))
  const subjects: RawDatatype[] = [
    ...new Set([
      ...opaqueContainers(reg, tree.datatypes).map(d => d.id),
      ...tree.importSurfaceIds.filter(id => byId.has(id)),
    ]),
  ]
    .sort()
    .map(id => byId.get(id) as RawDatatype)

  it('the enumeration is non-vacuous (subjects, uploadables, import surfaces, capabilities)', () => {
    // Every assertion below iterates one of these. A collapsed walk (wrong path, renamed
    // key) would otherwise iterate nothing and report green.
    expect(tree.datatypes.length).toBeGreaterThan(0)
    expect(opaqueContainers(reg, tree.datatypes).length).toBeGreaterThan(0)
    expect(tree.importSurfaceIds.length).toBeGreaterThan(0)
    expect(subjects.length).toBeGreaterThan(0)
    expect(subjects.filter(c => c.input_requirements !== undefined).length).toBeGreaterThan(0)
    expect(caps.size).toBeGreaterThan(0)
    expect(tree.analysisSubtypeBases.length).toBeGreaterThan(0)
    // Every id a converter imports must actually EXIST as a declaration, or the union
    // above would silently drop the very subjects it was added to retain.
    expect(tree.importSurfaceIds.filter(id => !byId.has(id))).toEqual([])
  })

  it('declares no contents claim', () => {
    const offenders = subjects
      .map(c => [c.id, contentsClaims(c, caps)] as const)
      .filter(([, v]) => v.length > 0)
      .map(([id, v]) => `${id}: ${v.join('; ')}`)
    expect(offenders).toEqual([])
  })

  it('declares the boundary facts an uploaded container needs', () => {
    const offenders = subjects
      .map(c => [c.id, missingBoundaryFacts(c)] as const)
      .filter(([, v]) => v.length > 0)
      .map(([id, v]) => `${id}: ${v.join('; ')}`)
    expect(offenders).toEqual([])
  })

  it('falls under NO analysable base any shipped analysis selects with `subtypes_of`', () => {
    // The design's own words for the regression this catches: putting a raw upload
    // container in the analysable subtree means "anything accepting `subtypes_of: <base>`
    // would offer to run on a raw upload container". Importers take it by exact `type_id`
    // instead, which is why an import surface can be excluded from every subtype selector
    // without losing its importers.
    const offenders: string[] = []
    for (const subject of subjects) {
      for (const base of tree.analysisSubtypeBases) {
        if (reg.isA(subject.id, base)) offenders.push(`${subject.id} isA ${base}`)
      }
    }
    expect(offenders).toEqual([])
    // The positive control: at least one SHIPPED datatype does fall under one of those
    // bases, or "no subject matches" would be true of a lattice that matches nothing.
    const matched = tree.datatypes.filter(d =>
      tree.analysisSubtypeBases.some(base => reg.isA(d.id, base)),
    )
    expect(matched.length).toBeGreaterThan(0)
  })
})
