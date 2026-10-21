// @vitest-environment jsdom
//
// The SHIPPED contributions, end to end: the real `packages/*/dataset-preview.yaml`
// files, through the real glob, the real registry and the real picker row.
//
// ── Why nothing here is written down ────────────────────────────────────────────
//
// Not one datatype id, declaration key or word appears in this file. Everything is
// ENUMERATED from the tree — which is both the honest way to test a contribution
// point (a package added later is covered on the next run instead of silently
// skipped) and the only way to test it at all: this file is inside the app surface
// `lint-no-domain-in-builtin` scans, and a written-down domain id here would be
// exactly the leak the seam exists to prevent.
//
// So the assertions are shaped as PROPERTIES over whatever is declared:
//   * every shipped declaration parses clean (the build gate for this file kind);
//   * every datatype it names is really declared, and really PRODUCED, by the tree;
//   * every value it reads is one a shipped PRODUCER really stamps, and every
//     dimension INDEX it reads is inside the axis count the datatype declares —
//     the two checks that are not satisfiable by the declaration alone;
//   * feeding a group those declarations produces the phrase, and the phrase — not
//     an app-composed inventory — is what reaches the picker row's second line;
//   * the row carries NO app storage noun and NO byte size;
//   * the same group with the declarations MISSING falls back to the count and the
//     datatype's title rather than rendering a hole;
//   * a datatype NOBODY declared for renders that same fallback even when its
//     producer bags carry the very same keys (the negative control — without it, a
//     hardcoded special case would pass every assertion above).

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'
import type { DatasetArtifactGroup, DatasetArtifactSummary } from '@/api-client/types'
import { formatBytes } from '@/modules/datasets/lib/format'
import { buildAttachOption } from '../components/attachOptionRow'
import type { AttachCandidate } from '../components/attachOptions'
import {
  PHRASE_COUNT_ROOT,
  PHRASE_TITLE_ROOT,
  placeholdersOf,
  readPreviewDeclaration,
  type DeclaredPreview,
} from './declared'
import { DECLARED_PREVIEW_FILES, registerDeclaredPreviews } from './load'
import { DatasetPreviewRegistry, datasetPreviewRegistry } from './registry'
import { holdingsFor, type SummaryDeps } from './summary'

afterEach(() => {
  cleanup()
})

// ── the tree, read at test time ─────────────────────────────────────────────────

/** Every shipped `manifest.yaml`, read through the SAME build-time channel the
 *  declarations arrive on (and the same one `loadProcessors` uses) — so this file
 *  needs no filesystem access and works under either test environment. */
const MANIFEST_FILES = import.meta.glob('../../../../../../packages/*/manifest.yaml', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/** One datatype declaration as AUTHORED, loose on purpose — only the fields this
 *  file needs are named. */
interface ManifestDatatype {
  id: string
  extends?: string | null
  title?: string
  axes?: Array<{ name?: string }>
}

/** One shipped manifest, loose on purpose — only what this file reads is named. */
interface ManifestDoc {
  contributes?: {
    datatypes?: ManifestDatatype[]
    converters?: Array<{ produces?: Array<string | { datatype?: string }> }>
    analyses?: Array<{ produces?: Array<string | { datatype?: string }> }>
  }
}

const MANIFESTS = Object.values(MANIFEST_FILES).map(text => parseYaml(text) as ManifestDoc)

/** Every datatype every shipped package declares, keyed by id. */
function manifestDatatypes(): Map<string, ManifestDatatype> {
  const out = new Map<string, ManifestDatatype>()
  for (const doc of MANIFESTS) {
    for (const dt of doc?.contributes?.datatypes ?? []) {
      if (dt?.id) out.set(dt.id, dt)
    }
  }
  return out
}

/** Every datatype some shipped package declares it PRODUCES. A converter writes
 *  `{datatype, cardinality}`; an analysis writes a bare id — both shapes here. */
function producedDatatypes(): Set<string> {
  const out = new Set<string>()
  for (const doc of MANIFESTS) {
    const lists = [...(doc?.contributes?.converters ?? []), ...(doc?.contributes?.analyses ?? [])]
    for (const entry of lists) {
      for (const p of entry?.produces ?? []) {
        const id = typeof p === 'string' ? p : p?.datatype
        if (id) out.add(id)
      }
    }
  }
  return out
}

const PRODUCED = producedDatatypes()

const CATALOG = manifestDatatypes()

/**
 * Every shipped PRODUCER source — the compute scripts that stamp the declarations
 * these previews describe.
 *
 * This exists because of a mutation that killed nothing. Every other assertion in
 * this file builds its fixture out of the paths the declaration itself names, so a
 * declaration reading `{meta.n_var}` where the producer writes `n_vars` is internally
 * consistent and passes the lot — while rendering nothing at all in the product,
 * forever, silently (a missing value is DROPPED by design). Self-consistency is not
 * correctness: the declaration has to be checked against the thing it claims to read.
 */
const PRODUCER_SOURCES = Object.entries(
  import.meta.glob('../../../../../../packages/**/*.py', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>,
)
  .filter(([file]) => !file.includes('/tests/'))
  .map(([, text]) => text)

/** Proper supertypes of `id`, nearest first — the same walk `datatypeRegistry`
 *  performs, over the AUTHORED declarations. */
function ancestorsOf(id: string): string[] {
  const out: string[] = []
  let cur: string | undefined = CATALOG.get(id)?.extends ?? undefined
  let guard = 0
  while (cur && guard++ < CATALOG.size) {
    out.push(cur)
    cur = CATALOG.get(cur)?.extends ?? undefined
  }
  return out
}

const titleOf = (id: string): string => CATALOG.get(id)?.title ?? id

/** Every shipped declaration, read through the SAME reader production uses. */
const SHIPPED: Array<{ source: string; preview: DeclaredPreview }> = Object.entries(
  DECLARED_PREVIEW_FILES,
).flatMap(([file, text]) =>
  readPreviewDeclaration(parseYaml(text)).previews.map(preview => ({ source: file, preview })),
)

// ── fixtures built out of whatever was declared ─────────────────────────────────

/** Every path both wordings of a preview read, deduped. */
function pathsOf(preview: DeclaredPreview): string[] {
  const all = [...placeholdersOf(preview.text), ...placeholdersOf(preview.one ?? '')]
  return [...new Set(all)]
}

/** Write `value` at a dotted path inside `root`, creating a list where the next
 *  segment is an index and a mapping otherwise. */
function assignPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let cur: Record<string, unknown> | unknown[] = root
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1
    const key: string | number = /^\d+$/.test(seg) ? Number(seg) : seg
    if (last) {
      ;(cur as Record<string | number, unknown>)[key] = value
      return
    }
    const existing = (cur as Record<string | number, unknown>)[key]
    if (existing === undefined) {
      const next = /^\d+$/.test(segments[i + 1]) ? [] : {}
      ;(cur as Record<string | number, unknown>)[key] = next
      cur = next
    } else {
      cur = existing as Record<string, unknown> | unknown[]
    }
  })
}

/** The group a declaration would render against: distinct values at exactly the
 *  paths it names, so a mixed-up substitution is visible. */
function fixtureFor(
  preview: DeclaredPreview,
  count: number,
): { group: DatasetArtifactGroup; declared: number[] } {
  const meta: Record<string, unknown> = {}
  const structure: Record<string, unknown> = {}
  const declared: number[] = []
  let i = 0
  for (const path of pathsOf(preview)) {
    const [root, ...rest] = path.split('.')
    // Neither is a producer declaration, so neither gets a fixture value: the count
    // is the app's arithmetic and the title is the datatype's own declared word.
    if (root === PHRASE_COUNT_ROOT || root === PHRASE_TITLE_ROOT) continue
    const value = 1_234_567 + i * 1_111_111
    i += 1
    declared.push(value)
    assignPath(root === 'meta' ? meta : structure, rest, value)
  }
  return { group: group(preview.datatype, { meta, structure }, count), declared }
}

const SIZE_BYTES = 41_233_920

const group = (
  datatype: string,
  decl: { meta?: unknown; structure?: unknown },
  count = 1,
): DatasetArtifactGroup => ({
  datatype,
  count,
  logical_bytes: SIZE_BYTES,
  representative_output_id: 'primary',
  representative_meta: decl.meta ?? {},
  representative_structure: decl.structure ?? {},
})

const summaryOf = (id: string, groups: DatasetArtifactGroup[]): DatasetArtifactSummary => ({
  dataset_id: id,
  artifact_count: groups.reduce((n, g) => n + g.count, 0),
  total_logical_bytes: groups.reduce((n, g) => n + g.logical_bytes, 0),
  groups,
})

/** The dependencies the panel resolves through, but backed by the AUTHORED
 *  declarations instead of a live `/api/datatypes` mirror. */
function depsWith(registry: DatasetPreviewRegistry): SummaryDeps {
  return { lattice: { ancestors: ancestorsOf }, title: titleOf, registry }
}

/** A registry holding ONLY what the shipped files declare. */
function shippedRegistry(): DatasetPreviewRegistry {
  const registry = new DatasetPreviewRegistry()
  registerDeclaredPreviews(DECLARED_PREVIEW_FILES, registry)
  return registry
}

const candidate = (id: string): AttachCandidate => ({
  id,
  name: 'Donor A',
  datatype: 'probe/whatever',
  source: 'owned',
})

/** Render one picker option and return the text of its holdings line — the second
 *  line of the row the user actually reads. `null` when the row shows none. */
function holdingsLineOf(
  id: string,
  holdings: { text: string; detail: string } | null,
): string | null {
  const option = buildAttachOption(candidate(id), { typeLabel: 'Probe', holdings })
  render(<>{option.label}</>)
  return screen.queryByTestId(`project-attach-opt-holdings-${id}`)?.textContent ?? null
}

/** The one-group summary for `g`, rendered into the row. */
function lineFor(
  registry: DatasetPreviewRegistry,
  rowId: string,
  g: DatasetArtifactGroup,
): string | null {
  const summary = summaryOf(rowId, [g])
  const holdings = holdingsFor(new Map([[summary.dataset_id, summary]]), rowId, depsWith(registry))
  return holdingsLineOf(rowId, holdings)
}

// ── the assertions ──────────────────────────────────────────────────────────────

describe('the shipped dataset-preview declarations', () => {
  it('are DISCOVERED by the production glob (a zero match would make everything below vacuous)', () => {
    expect(Object.keys(DECLARED_PREVIEW_FILES).length).toBeGreaterThanOrEqual(1)
    // A committed FLOOR, in the house style of the tree's other scan floors: every
    // assertion below is per-declaration, so removing one entry would otherwise
    // shrink the suite silently rather than fail it. Raise it when a package adds a
    // declaration; lowering it takes a deliberate, reviewable edit.
    expect(SHIPPED.length).toBeGreaterThanOrEqual(3)
  })

  it('describe datatypes something in the tree actually PRODUCES', () => {
    // A preview for a datatype no converter and no analysis emits can never render.
    // This is the reverse of the check below: that one says the id is DECLARED,
    // this one says artifacts of it get MADE.
    expect(PRODUCED.size).toBeGreaterThan(0)
    for (const { preview } of SHIPPED) {
      expect({ datatype: preview.datatype, produced: PRODUCED.has(preview.datatype) }).toEqual({
        datatype: preview.datatype,
        produced: true,
      })
    }
  })

  it('each parse LOUD-clean through the production reader (the build gate for this file kind)', () => {
    for (const [file, text] of Object.entries(DECLARED_PREVIEW_FILES)) {
      const read = readPreviewDeclaration(parseYaml(text))
      expect({ file, errors: read.errors }).toEqual({ file, errors: [] })
      expect(read.ok).toBe(true)
    }
  })

  it('name only datatypes a shipped manifest really declares', () => {
    // A declaration for an id nothing declares would resolve for nothing, forever,
    // and look identical to a datatype nobody contributed for.
    expect(CATALOG.size).toBeGreaterThan(0)
    for (const { preview } of SHIPPED) {
      expect({ datatype: preview.datatype, declared: CATALOG.has(preview.datatype) }).toEqual({
        datatype: preview.datatype,
        declared: true,
      })
    }
  })

  it('take a DISTINCT position in the line, so the composed order is deterministic', () => {
    const orders = SHIPPED.map(s => s.preview.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('read only keys a shipped PRODUCER really stamps', () => {
    // The anti-tautology check. A key is matched as a dict-key spelling (`"key":`),
    // not as a substring, so a truncated or pluralised typo of a real key fails —
    // which is the whole failure mode this guards, because the product's response to
    // a key nobody writes is to render nothing rather than to complain.
    expect(PRODUCER_SOURCES.length).toBeGreaterThan(0)
    const stamped = (key: string) => PRODUCER_SOURCES.some(src => src.includes(`"${key}":`))
    for (const { preview } of SHIPPED) {
      for (const path of pathsOf(preview)) {
        const [root, key] = path.split('.')
        // The count is the app's own arithmetic over real rows and the title is the
        // datatype's own declared word — neither is a producer declaration.
        if (root === PHRASE_COUNT_ROOT || root === PHRASE_TITLE_ROOT) continue
        expect({ datatype: preview.datatype, path, stamped: stamped(key) }).toEqual({
          datatype: preview.datatype,
          path,
          stamped: true,
        })
      }
    }
  })

  it('index a producer dimension list only INSIDE the axis count its datatype declares', () => {
    // The second anti-tautology check, and the one that guards the reported defect
    // directly. A path ending in a number reads the Nth entry of a producer-declared
    // list — i.e. it claims the datatype has at least N+1 dimensions. The datatype's
    // OWN manifest declares its axes, so that claim is checkable against something
    // the declaration does not control. An off-by-one index renders nothing, forever,
    // silently; this is what fails instead.
    const indexed = SHIPPED.flatMap(({ preview }) =>
      pathsOf(preview)
        .map(path => ({ preview, path, segments: path.split('.') }))
        .filter(x => /^\d+$/.test(x.segments[x.segments.length - 1])),
    )
    // Not skipped when empty: a shipped tree with no indexed path means this check
    // must be re-derived rather than silently passing on zero cases.
    expect(indexed.length).toBeGreaterThan(0)
    for (const { preview, path, segments } of indexed) {
      const index = Number(segments[segments.length - 1])
      const axes = CATALOG.get(preview.datatype)?.axes ?? []
      expect({ datatype: preview.datatype, path, withinDeclaredAxes: index < axes.length }).toEqual({
        datatype: preview.datatype,
        path,
        withinDeclaredAxes: true,
      })
    }
  })

  it('are the ONLY contributions the app-wide registry holds — nothing is registered from app code', () => {
    // Both halves: the singleton is POPULATED (importing the seam is what registers
    // them), and it holds NOTHING the files did not declare.
    expect(datasetPreviewRegistry.size).toBeGreaterThan(0)
    expect(datasetPreviewRegistry.size).toBe(SHIPPED.length)
  })
})

describe('a dataset holding a declared datatype states the PACKAGE\'s sentence, in the picker row', () => {
  for (const { preview } of SHIPPED) {
    const readsADeclaration = pathsOf(preview).some(p => !p.startsWith('count'))

    it(`${preview.datatype} → its phrase IS the row's line`, () => {
      const registry = shippedRegistry()
      const { group: g, declared } = fixtureFor(preview, 63)

      const resolved = registry.phraseFor(g, { ancestors: ancestorsOf }, titleOf(preview.datatype))
      expect(resolved?.text).not.toBeNull()

      const line = lineFor(registry, 'd1', g)
      // EXACT: the phrase is the whole line, not a suffix on something the app wrote.
      expect(line).toBe(resolved?.text)
      // Every declared number is rendered, and no template survives unresolved.
      for (const n of declared) expect(line).toContain(n.toLocaleString())
      expect(line).not.toContain('undefined')
      expect(line).not.toContain('{')
    })

    it(`${preview.datatype} → the row carries NO app storage noun and NO byte size`, () => {
      // The reported defect, on the shipped path: the line used to open with a count
      // of "artifacts" and a formatted size, in front of whatever the package said.
      const registry = shippedRegistry()
      const { group: g } = fixtureFor(preview, 63)
      const line = lineFor(registry, 'd6', g) ?? ''
      expect(line).not.toContain('artifact')
      expect(line).not.toContain(formatBytes(SIZE_BYTES))
      expect(line).not.toContain('MB')
      expect(line).not.toContain('KB')
    })

    it(`${preview.datatype} → carries the byte size into the row's hover instead`, () => {
      const registry = shippedRegistry()
      const { group: g } = fixtureFor(preview, 63)
      const summary = summaryOf('d7', [g])
      const holdings = holdingsFor(new Map([['d7', summary]]), 'd7', depsWith(registry))
      expect(holdings?.detail).toContain(formatBytes(SIZE_BYTES))
    })

    it(`${preview.datatype} → ${
      readsADeclaration
        ? 'DEGRADES to the count-and-title line when the producer declared none of it'
        : 'speaks from the COUNT alone, so it never needs a producer declaration'
    }`, () => {
      // A dataset imported by a different path: the datatype is the same, the
      // declarations are not. Nothing may be invented, and nothing may be rendered as
      // a hole. The assertion is EXACT, so an extra clause of any shape fails it.
      const registry = shippedRegistry()
      const bare = group(preview.datatype, { meta: { unrelated: 'value' } }, 3)
      const line = lineFor(registry, 'd2', bare)
      if (readsADeclaration) {
        expect(line).toBe(`3 ${titleOf(preview.datatype)}`)
      } else {
        expect(line).not.toBe(`3 ${titleOf(preview.datatype)}`)
        expect(line).toContain('3')
      }
    })

    if (readsADeclaration) {
      it(`${preview.datatype} → drops the WHOLE phrase when any one value went missing`, () => {
        // A phrase is all-or-nothing: half a sentence about a matrix is worse than
        // the plain count. Withhold ONE path at a time and the row must be exactly
        // the fallback each time — a renderer that emitted a hole, or that kept the
        // half it could read, fails a different line each way.
        const registry = shippedRegistry()
        // PRODUCER paths only. The count is the app's arithmetic and the title is
        // resolved from the datatype registry (which falls back to the raw id, so it
        // is never absent) — neither lives in a bag, so neither can be withheld from
        // one. Same exclusion `fixtureFor` makes, for the same reason.
        const paths = pathsOf(preview).filter(
          p => !p.startsWith(PHRASE_COUNT_ROOT) && !p.startsWith(PHRASE_TITLE_ROOT),
        )
        paths.forEach((withheld, i) => {
          const { group: full } = fixtureFor(preview, 3)
          const meta = full.representative_meta as Record<string, unknown>
          const structure = full.representative_structure as Record<string, unknown>
          const [root, ...rest] = withheld.split('.')
          const bag = root === 'meta' ? meta : structure
          delete (bag as Record<string, unknown>)[rest[0]]
          const line = lineFor(registry, `d5-${i}`, group(preview.datatype, { meta, structure }, 3))
          expect({ withheld, line }).toEqual({
            withheld,
            line: `3 ${titleOf(preview.datatype)}`,
          })
        })
      })
    }
  }
})

describe('resolution up the lattice, on the shipped declarations', () => {
  /** A shipped datatype with no declaration of its own whose ancestor chain reaches
   *  one — the case a supertype contribution is supposed to cover. */
  const inherited = [...CATALOG.keys()]
    .filter(id => !SHIPPED.some(s => s.preview.datatype === id))
    .map(id => ({ id, from: ancestorsOf(id).find(a => SHIPPED.some(s => s.preview.datatype === a)) }))
    .filter((x): x is { id: string; from: string } => x.from != null)

  it('a subtype with no declaration of its own inherits its nearest declared ancestor', () => {
    // Not skipped when empty: if the shipped lattice ever stops having such a pair,
    // this test must be re-derived rather than silently passing on zero cases.
    expect(inherited.length).toBeGreaterThan(0)
    const registry = shippedRegistry()
    for (const { id, from } of inherited) {
      const ancestor = SHIPPED.find(s => s.preview.datatype === from)
      if (!ancestor) throw new Error(`no shipped declaration for ${from}`)
      const { group: g, declared } = fixtureFor(ancestor.preview, 63)
      const resolved = registry.phraseFor(group(id, {
        meta: g.representative_meta,
        structure: g.representative_structure,
      }, 63), { ancestors: ancestorsOf }, titleOf(id))
      expect({ id, spoke: resolved?.text != null }).toEqual({ id, spoke: true })
      for (const n of declared) expect(resolved?.text).toContain(n.toLocaleString())
    }
  })

  it('and states the SUBTYPE\'s own name, never the ancestor\'s, when the phrase names one', () => {
    // The reason `{title}` is a template root rather than a word written into the
    // declaration. ONE contribution answers for every subtype on its branch, so a
    // literal noun there would print the ANCESTOR's name over a subtype's artifacts —
    // a confident wrong label on the one line whose job is to tell two arrays apart.
    // Only meaningful for a phrase that names the thing at all; the rest are skipped
    // by declaration, not by exception.
    const registry = shippedRegistry()
    const naming = inherited.filter(({ from }) => {
      const a = SHIPPED.find(s => s.preview.datatype === from)
      return a != null && pathsOf(a.preview).includes(PHRASE_TITLE_ROOT)
    })
    expect(naming.length).toBeGreaterThan(0)
    for (const { id, from } of naming) {
      const ancestor = SHIPPED.find(s => s.preview.datatype === from)
      if (!ancestor) throw new Error(`no shipped declaration for ${from}`)
      // Only run where the two names really differ — otherwise the assertion below
      // could not distinguish them and would pass on nothing.
      if (titleOf(id) === titleOf(from)) continue
      const { group: g } = fixtureFor(ancestor.preview, 63)
      const resolved = registry.phraseFor(
        group(id, { meta: g.representative_meta, structure: g.representative_structure }, 63),
        { ancestors: ancestorsOf },
        titleOf(id),
      )
      // Asserted POSITIVELY only. A subtype title may legitimately contain its
      // ancestor's as a prefix, so "does not contain the ancestor's" is not a
      // property the tree supports — while "states its OWN" already fails a literal
      // noun, which is the mutation this exists for.
      expect({ id, said: resolved?.text?.includes(titleOf(id)) }).toEqual({ id, said: true })
    }
  })
})

describe('NEGATIVE CONTROL — an UNCONTRIBUTED datatype', () => {
  it('renders the generic fallback and NOT a contributed phrase, carrying identical declarations', () => {
    const registry = shippedRegistry()
    // Same declarations as a contributed datatype's, DIFFERENT datatype, and one
    // nothing declares for anywhere in the tree. A "contribution" that were really a
    // hardcoded read of these keys would light up here.
    const { group: seed, declared } = fixtureFor(SHIPPED[0].preview, 7)
    const uncontributed = 'probe/uncontributed'
    expect(registry.resolve(uncontributed, { ancestors: ancestorsOf })).toBeUndefined()

    const g = group(
      uncontributed,
      { meta: seed.representative_meta, structure: seed.representative_structure },
      7,
    )
    const line = lineFor(registry, 'd3', g)
    expect(line).toBe(`7 ${uncontributed}`)
    for (const n of declared) expect(line).not.toContain(n.toLocaleString())

    // The positive control, side by side, so the assertion above is not passing
    // because the whole mechanism is inert.
    const contributedLine = lineFor(registry, 'd4', { ...seed, count: 7 })
    expect(contributedLine).not.toBe(`7 ${titleOf(SHIPPED[0].preview.datatype)}`)
  })
})

// ── the reported defect: a line that says HOW BIG but never WHAT ────────────────
//
// A phrase built only out of producer-declared extents states a size and no identity.
// On a dataset holding ONE array that is merely terse; on a dataset holding two of
// the same rank — the normal shape of a multi-modal import, and the case this
// branch's five declared subtypes exist for — it is two bare number pairs and the
// reader cannot tell which array is which.
//
// The assertions below are shaped as properties over whatever is declared, in this
// file's house style — nothing here names a datatype, a key or a word:
//   * a declaration that states EXTENTS must also state the thing's NAME;
//   * the composed line for a realistic dataset (an extent-bearing group beside a
//     counted one) really carries both, with every number formatted for a reader;
//   * neither part is the app's count-and-title fallback — the failure mode that
//     produced the report, and the one an "it renders something" assertion misses.

/** Previews that read a producer's DIMENSION list — a path ending in an index. */
const DIMENSIONAL = SHIPPED.filter(({ preview }) => pathsOf(preview).some(p => /\.\d+$/.test(p)))

/** Previews that speak from the app's own count alone. */
const COUNTED = SHIPPED.filter(({ preview }) =>
  pathsOf(preview).every(p => p === PHRASE_COUNT_ROOT || p === PHRASE_TITLE_ROOT),
)

describe('a phrase that states a SIZE also states what the thing IS', () => {
  it('there is such a declaration to check (a zero would make the rest vacuous)', () => {
    expect(DIMENSIONAL.length).toBeGreaterThan(0)
    expect(COUNTED.length).toBeGreaterThan(0)
  })

  it('every extent-reading declaration names the datatype as well', () => {
    // Declared, not rendered: the rule is about what the FILE says, so it holds even
    // for a dataset whose producer stamped nothing and which therefore falls back.
    for (const { source, preview } of DIMENSIONAL) {
      expect({ source, datatype: preview.datatype, names: pathsOf(preview) }).toEqual({
        source,
        datatype: preview.datatype,
        names: expect.arrayContaining([PHRASE_TITLE_ROOT]),
      })
    }
  })

  it("names it from the datatype's OWN declared title, never a word this file invented", () => {
    // `{title}` resolves to whatever the app hands over for THAT group. Handing over a
    // value nothing else in the fixture could produce proves the rendered word arrived
    // through that channel rather than from a literal baked into the template.
    const registry = shippedRegistry()
    for (const { preview } of DIMENSIONAL) {
      const { group: g } = fixtureFor(preview, 1)
      const supplied = 'A title supplied by the caller'
      const text = registry.phraseFor(g, { ancestors: ancestorsOf }, supplied)?.text
      expect({ datatype: preview.datatype, text }).toEqual({
        datatype: preview.datatype,
        text: expect.stringContaining(supplied),
      })
    }
  })
})

describe('the composed line for a dataset holding an extent-bearing group and a counted one', () => {
  /** The two-group summary a realistic import produces, and the line it renders to. */
  function composed(): { line: string; dimensional: DeclaredPreview; declared: number[] } {
    const registry = shippedRegistry()
    const dimensional = DIMENSIONAL[0].preview
    const counted = COUNTED[0].preview
    const { group: big, declared } = fixtureFor(dimensional, 1)
    const { group: many } = fixtureFor(counted, 4)
    const summary = summaryOf('d8', [big, many])
    const holdings = holdingsFor(new Map([['d8', summary]]), 'd8', depsWith(registry))
    const line = holdingsLineOf('d8', holdings)
    if (line == null) throw new Error('the picker row rendered no holdings line at all')
    return { line, dimensional, declared }
  }

  it('states WHAT the extent-bearing group is', () => {
    const { line, dimensional } = composed()
    expect(line).toContain(titleOf(dimensional.datatype))
  })

  it('states HOW BIG it is, in the same line', () => {
    const { line, declared } = composed()
    expect(declared.length).toBeGreaterThan(0)
    for (const n of declared) expect(line).toContain(n.toLocaleString())
  })

  it('formats every number for a reader, not as raw digits', () => {
    // `toLocaleString` is the interpreter's own formatter (`declared.ts`), so this
    // pins the shipped behaviour rather than a second implementation of it. Asserted
    // only where the two spellings actually differ.
    const { line, declared } = composed()
    const grouped = declared.filter(n => n.toLocaleString() !== String(n))
    expect(grouped.length).toBeGreaterThan(0)
    for (const n of grouped) expect(line).not.toContain(String(n))
  })

  it('carries BOTH groups, joined — neither is dropped to make room', () => {
    const { line } = composed()
    expect(line).toContain(' · ')
    const counted = COUNTED[0].preview
    const registry = shippedRegistry()
    const { group: many } = fixtureFor(counted, 4)
    // Reproduced THROUGH the interpreter rather than spelt out here.
    const expected = registry.phraseFor(many, { ancestors: ancestorsOf }, titleOf(counted.datatype))
    expect(expected?.text).not.toBeNull()
    expect(line).toContain(expected?.text as string)
  })

  it("and NEITHER part is the app's count-and-title fallback", () => {
    // The negative the assertions above cannot make on their own: a fallback reads
    // `<count> <title>`, so it contains the title too, and a line made entirely of
    // fallbacks would satisfy "states what it is".
    const { line, dimensional } = composed()
    const counted = COUNTED[0].preview
    expect(line).not.toContain(`1 ${titleOf(dimensional.datatype)}`)
    expect(line).not.toContain(`4 ${titleOf(counted.datatype)}`)
  })
})
