// ITEM-16 / DEC-14 (TEST-20 companion) — the upload wizard's convertible-type catalog
// is DATA: derived from the datatype registry (every type declaring
// `input_requirements`), never a hardcoded `CONVERTIBLE_TYPES` domain-id list. This
// covers the pure derivation `deriveConvertibleTypes` against a registry-shaped
// datatype list (the component just feeds it `datatypeRegistry.all()`). Pure → the
// node runner (no DOM).

import { describe, expect, it } from 'vitest'
import type { Datatype } from '@/core/datatypes'
import { deriveConvertibleTypes } from './UploadPanel'

/** A minimal wire `Datatype` (only the fields the derivation reads matter). */
function dt(partial: Partial<Datatype> & { id: string }): Datatype {
  return {
    extends: null,
    title: partial.id,
    description: '',
    storage: {
      layout: { kind: 'opaque_as_is' },
      format: 'any',
      selector_map: {},
      file_layout: 'single',
      tiers: ['tier1_range_client_decode'],
    },
    capabilities: [],
    viewers: [],
    converters: [],
    is_abstract: false,
    ...partial,
  }
}

// The two contributed uploadable single-cell types (mirrors the manifest) + a
// non-uploadable derivative (no `input_requirements`) that must be excluded.
const REGISTRY: Datatype[] = [
  dt({
    id: 'single-cell/anndata',
    title: 'AnnData',
    ingest: { extensions: ['h5ad', 'zarr'], magic_hex: [] },
    input_requirements: { requires: 'single' },
    axes: [
      { name: 'cells', key_label: 'barcode' },
      { name: 'genes', key_label: 'gene_id' },
    ],
  }),
  dt({
    id: 'single-cell/matrix-mtx',
    title: '10x matrix (MTX trio)',
    input_requirements: {
      requires: 'manifest',
      members: ['matrix.mtx', 'barcodes.tsv', 'features.tsv'],
      allow_archive: true,
    },
    axes: [
      { name: 'cells', key_label: 'barcode' },
      { name: 'genes', key_label: 'gene_id' },
    ],
  }),
  // A produced (non-uploadable) type — no input_requirements → never offered.
  dt({ id: 'embedding', title: 'Embedding' }),
]

describe('deriveConvertibleTypes (ITEM-16 / DEC-14)', () => {
  it('offers exactly the datatypes declaring input_requirements — value/label from id/title', () => {
    const catalog = deriveConvertibleTypes(REGISTRY)
    expect(catalog.map(c => c.value)).toEqual(['single-cell/anndata', 'single-cell/matrix-mtx'])
    // Label is the DECLARED title (DATA), not a hardcoded string.
    expect(catalog.find(c => c.value === 'single-cell/anndata')!.label).toBe('AnnData')
    // The produced type without input_requirements is excluded.
    expect(catalog.some(c => c.value === 'embedding')).toBe(false)
  })

  it('single requirements → one dropzone with accept globs from ingest.extensions', () => {
    const anndata = deriveConvertibleTypes(REGISTRY).find(c => c.value === 'single-cell/anndata')!
    expect(anndata.requirements.kind).toBe('single')
    if (anndata.requirements.kind !== 'single') throw new Error('expected single')
    expect(anndata.requirements.accept).toBe('.h5ad,.zarr')
  })

  it('manifest requirements → one slot per declared member, member accept from its own ext + archive toggle', () => {
    const mtx = deriveConvertibleTypes(REGISTRY).find(c => c.value === 'single-cell/matrix-mtx')!
    expect(mtx.requirements.kind).toBe('manifest')
    if (mtx.requirements.kind !== 'manifest') throw new Error('expected manifest')
    expect(mtx.requirements.members.map(m => m.id)).toEqual(['matrix', 'barcodes', 'features'])
    expect(mtx.requirements.members.map(m => m.label)).toEqual([
      'matrix.mtx',
      'barcodes.tsv',
      'features.tsv',
    ])
    // Accept globs derive from the member's own filename extension (no format list).
    expect(mtx.requirements.members[0].accept).toBe('.mtx,.mtx.gz,.gz')
    expect(mtx.requirements.members[1].accept).toBe('.tsv,.tsv.gz,.gz')
    // The 3-file OR single-archive alternative is offered (allow_archive: true).
    expect(mtx.requirements.allowArchive).toBe(true)
    expect(mtx.requirements.archiveAccept).toContain('.zip')
  })

  // The `|`-ALTERNATION regression. A declared member may list interchangeable
  // spellings separated by `|`, and the core accepts any of them
  // (`dataset/repository.rs::matches_member` splits on `|` too). The separator is
  // WIRE syntax: deriving the slot off the RAW string cut at the LAST dot — which
  // sits inside the SECOND alternative — so the slot id kept the separator, which
  // made its `dataset-upload-slot-<id>-input` testid unaddressable and printed the
  // raw declaration to the user as the field label.
  //
  // Deliberately fixtured on NEUTRAL names: the real declaration lives as DATA in a
  // processor manifest, and `lint-no-domain-in-builtin` is what keeps it out of the
  // app surface (this file included). The derivation is what is under test.
  describe('a `|`-alternation member', () => {
    /** A one-member-list manifest type, returning its derived requirements. */
    const altType = (members: string[]) => {
      const req = deriveConvertibleTypes([
        dt({
          id: 'x/alt',
          title: 'Alt',
          input_requirements: { requires: 'manifest', members, allow_archive: true },
        }),
      ])[0].requirements
      if (req.kind !== 'manifest') throw new Error('expected manifest')
      return req
    }

    it('the slot id is the FIRST (canonical) spelling — never a fragment of the raw declaration', () => {
      const m = altType(['primary.tsv|legacy.tsv']).members[0]
      expect(m.id).toBe('primary')
      // The literal defect: the id carries no wire syntax at all (it is both the
      // `dataset-upload-slot-<id>-input` testid and the `slots` map key).
      expect(m.id).not.toContain('|')
      expect(m.id).not.toContain('.')
    })

    it('no user-visible string leaks the separator — label, hint, or archive hint', () => {
      const req = altType(['one.bin', 'primary.tsv|legacy.tsv'])
      expect(req.members[1].label).toBe('primary.tsv or legacy.tsv')
      expect(req.members[1].hint).toBe('primary.tsv[.gz] or legacy.tsv[.gz].')
      expect(req.archiveHint).toBe(
        'A single .zip/.tar containing one.bin, primary.tsv or legacy.tsv.',
      )
      for (const s of [req.members[1].label, req.members[1].hint, req.archiveHint])
        expect(s).not.toContain('|')
    })

    it('accept globs are the UNION over every spelling (alternatives may differ in extension)', () => {
      // Same extension on both → the single-spelling globs, deduped (not repeated).
      expect(altType(['primary.tsv|legacy.tsv']).members[0].accept).toBe('.tsv,.tsv.gz,.gz')
      // Differing extensions → both are accepted.
      expect(altType(['primary.tsv|primary.csv']).members[0].accept).toBe(
        '.tsv,.tsv.gz,.gz,.csv,.csv.gz',
      )
    })

    it('whitespace around the separator is tolerated (the core trims each alternative too)', () => {
      const m = altType(['primary.tsv | legacy.tsv']).members[0]
      expect(m.id).toBe('primary')
      expect(m.label).toBe('primary.tsv or legacy.tsv')
    })
  })

  it('C1 / DEC-14: the archive alternative is gated on the declared allow_archive flag', () => {
    // A manifest type with allow_archive: FALSE must NOT offer the archive path.
    const noArchive = deriveConvertibleTypes([
      dt({
        id: 'x/trio-strict',
        title: 'Strict trio',
        input_requirements: {
          requires: 'manifest',
          members: ['a.mtx', 'b.tsv'],
          allow_archive: false,
        },
      }),
    ])[0]
    expect(noArchive.requirements.kind).toBe('manifest')
    if (noArchive.requirements.kind !== 'manifest') throw new Error('expected manifest')
    expect(noArchive.requirements.allowArchive).toBe(false)
    // Members still derive; the flag is what the wizard reads to hide the archive toggle.
    expect(noArchive.requirements.members.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('supporting dropzones derive from the declared axes (name + key_label)', () => {
    const anndata = deriveConvertibleTypes(REGISTRY).find(c => c.value === 'single-cell/anndata')!
    expect(anndata.supportingAxes?.map(a => a.axis)).toEqual(['cells', 'genes'])
    const cells = anndata.supportingAxes!.find(a => a.axis === 'cells')!
    expect(cells.label).toBe('Cell annotations (CSV/TSV)')
    expect(cells.hint).toContain('barcode')
  })

  it('a type with no axes declares no supporting dropzones', () => {
    const noAxes = deriveConvertibleTypes([
      dt({ id: 'x/plain', title: 'Plain', input_requirements: { requires: 'single' } }),
    ])
    expect(noAxes[0].supportingAxes).toBeUndefined()
  })
})

// ── TEST-13 [covers ITEM-5] — the slot derivation becomes PATH-AWARE ──────────
//
// A container may declare a member that carries its own directory (#160, DEC-2: the
// core matches as many TRAILING path segments as the member declares). The derivation
// used to reduce a member to the stem of its declaration, which is unique only while
// every member is a bare basename — three members sharing one directory-relative name
// under three different directories all collapsed to ONE id, and that id is the React
// key, the `dataset-upload-slot-<id>-input` selector AND the slot-map key, so two of
// the three picked files were silently dropped before anything was transferred.
//
// The regression half is the load-bearing one and it is asserted against the SHIPPED
// declarations, read out of the contributed package manifests at test time rather than
// copied here: every member that carries no separator must derive BYTE-IDENTICALLY to
// the pre-#160 formula, so no existing selector, slot-map key or gallery seed key
// moves. Reading them keeps this honest in both directions — a hand-copied list would
// go stale the moment a package changed, and spelling the declarations out in the app
// tree is exactly what `scripts/lint-no-domain-in-builtin.mjs` exists to prevent.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = path.resolve(HERE, '../../../../../packages')

/** Every declared member list contributed by an in-tree package, as
 *  `[datatype id, members]`. Read, never written down. */
function declaredContainers(): [string, string[]][] {
  const out: [string, string[]][] = []
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const manifest = path.join(PACKAGES_DIR, pkg, 'manifest.yaml')
    if (!existsSync(manifest)) continue
    const doc = parseYaml(readFileSync(manifest, 'utf8')) as {
      contributes?: { datatypes?: { id: string; input_requirements?: { members?: string[] } }[] }
    }
    for (const dt of doc?.contributes?.datatypes ?? []) {
      const members = dt.input_requirements?.members
      if (Array.isArray(members) && members.length > 0) out.push([dt.id, members])
    }
  }
  return out
}

/** The derivation EXACTLY as it stood before #160 — the oracle the depth-1 case is
 *  held to. Deliberately a second copy: asserting the new code against itself would
 *  prove nothing. */
function preChangeSlot(member: string): { id: string; label: string; accept: string; hint: string } {
  const alternatives = member.split('|').map(a => a.trim()).filter(a => a.length > 0)
  const spellings = alternatives.length > 0 ? alternatives : [member]
  const stem = (n: string) => (n.lastIndexOf('.') > 0 ? n.slice(0, n.lastIndexOf('.')) : n)
  const ext = (n: string) =>
    n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : ''
  const accept: string[] = []
  for (const spelling of spellings) {
    const e = ext(spelling)
    if (!e) continue
    for (const glob of [`.${e}`, `.${e}.gz`, '.gz']) if (!accept.includes(glob)) accept.push(glob)
  }
  return {
    id: stem(spellings[0]).toLowerCase(),
    label: spellings.join(' or '),
    accept: accept.join(','),
    hint: `${spellings.map(s => `${s}[.gz]`).join(' or ')}.`,
  }
}

/** Derive the member slots for one declared member list. */
function slotsFor(members: string[]) {
  const req = deriveConvertibleTypes([
    dt({
      id: 'x/container',
      title: 'Container',
      input_requirements: { requires: 'manifest', members, allow_archive: true },
    }),
  ])[0].requirements
  if (req.kind !== 'manifest') throw new Error('expected manifest')
  return req.members
}

// A NESTED declaration of the shape the depth rule exists for: three sibling
// directories, each holding the same four names, at the two depths such a container
// really has (one beside the directory, three under a sub-directory of it). Neutral
// by construction — the real one is DATA in a contributed manifest.
const BINS = ['grid_002', 'grid_008', 'grid_016']
const PER_BIN = ['counts.h5', 'geo/positions.parquet', 'geo/scale.json', 'geo/preview.png']
const NESTED_MEMBERS = BINS.flatMap(b => PER_BIN.map(n => `${b}/${n}`))

describe('TEST-13 — memberSlot is path-aware (ITEM-5, #160)', () => {
  it('a twelve-member nested declaration derives TWELVE distinct, SLUG-shaped ids', () => {
    const ids = slotsFor(NESTED_MEMBERS).map(m => m.id)
    expect(ids).toHaveLength(12)
    expect(new Set(ids).size).toBe(12)
    // What the pre-#160 derivation produced for the same declaration: the stem of the
    // WHOLE raw string, separators and all. Distinct, but not an id — it is the
    // `slots` map key and the `dataset-upload-slot-<id>-input` selector segment, so it
    // put the wire path inside a DOM attribute value.
    for (const m of NESTED_MEMBERS) expect(preChangeSlot(m).id).toContain('/')
    for (const id of ids) expect(id).not.toContain('/')
  })

  it('the pre-#160 stem-of-the-raw-string COLLIDES where the new id does not', () => {
    // Two members in one directory differing only in extension: the old formula cut at
    // the last dot and produced ONE id for both — duplicate React keys, one selector
    // answering for two inputs, and a slot map that keeps whichever was written last.
    const clashing = ['bin/table.tsv', 'bin/table.csv']
    expect(new Set(clashing.map(m => preChangeSlot(m).id)).size).toBe(1)
    expect(new Set(slotsFor(clashing).map(m => m.id)).size).toBe(2)
  })

  it('the id spells the WHOLE canonical path, with the DIRECTORY separator encoded distinctly', () => {
    const ids = slotsFor(NESTED_MEMBERS).map(m => m.id)
    expect(ids.slice(0, 4)).toEqual([
      'grid-002--counts-h5',
      'grid-002--geo--positions-parquet',
      'grid-002--geo--scale-json',
      'grid-002--geo--preview-png',
    ])
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-{1,2}[a-z0-9]+)*$/)

    // A separator is `--` and anything INSIDE a segment is `-`, so two declarations that
    // differ only in where the boundary falls do not collapse onto one id. Collapsing
    // both to a single dash is exactly the defect this function exists to prevent, and
    // the pre-#160 derivation is the control: it produced one id for these two.
    const boundary = ['bin/a_b.h5', 'bin/a/b.h5']
    expect(new Set(slotsFor(boundary).map(m => m.id)).size).toBe(2)

    // A leading or trailing separator must not leak into the id — it would leak into a
    // `data-testid` with it.
    expect(slotsFor(['/counts.h5'])[0].id).toBe('counts')
    for (const id of slotsFor(['/counts.h5', 'trailing/']).map(m => m.id)) {
      expect(id).not.toContain('/')
    }
  })

  it('the label and hint show the DISTINGUISHING path, not just the name', () => {
    const slots = slotsFor(NESTED_MEMBERS)
    expect(slots[1].label).toBe('grid_002/geo/positions.parquet')
    expect(slots[5].label).toBe('grid_008/geo/positions.parquet')
    expect(slots[1].hint).toContain('grid_002/geo/positions.parquet')
    // Same basename, different rows — the whole point.
    expect(slots[1].label).not.toBe(slots[5].label)
  })

  it('accept globs come from the LAST segment, so a dotted directory is not an extension', () => {
    const slots = slotsFor(['bundle.d/inner/table.tsv'])
    expect(slots[0].accept).toBe('.tsv,.tsv.gz,.gz')
    expect(slots[0].id).toBe('bundle-d--inner--table-tsv')
  })

  it('the raw declaration is carried through verbatim (what the matcher reads)', () => {
    const slots = slotsFor(['primary.tsv|legacy.tsv', 'grid_002/counts.h5'])
    expect(slots.map(m => m.declaration)).toEqual(['primary.tsv|legacy.tsv', 'grid_002/counts.h5'])
  })

  describe('the REGRESSION half — the shipped depth-1 declarations must not move', () => {
    const containers = declaredContainers()

    it('reads a real, non-trivial set of shipped declarations', () => {
      // A floor, so this suite cannot pass by finding nothing to check.
      expect(containers.length).toBeGreaterThanOrEqual(3)
      const flat = containers.flatMap(([, ms]) => ms).filter(m => !m.includes('/'))
      expect(flat.length).toBeGreaterThanOrEqual(10)
    })

    it.each(declaredContainers().filter(([, ms]) => ms.some(m => !/[/\\]/.test(m))))(
      '%s — every separator-free member derives byte-identically to the pre-#160 formula',
      (id, members) => {
        // The filter above is what keeps this from being coverage inflation: a container
        // whose members ALL carry a directory (the HD one does) would otherwise contribute
        // a green, named test row that asserts literally nothing, because the loop body
        // `continue`s on every member.
        const flat = members.filter(m => !/[/\\]/.test(m))
        expect(flat.length, `${id} was selected as having flat members`).toBeGreaterThan(0)
        for (const m of flat) {
          const [got] = slotsFor([m])
          const want = preChangeSlot(m)
          expect({ id: got.id, label: got.label, accept: got.accept, hint: got.hint }).toEqual(want)
        }
      },
    )

    it('two members sharing a canonical spelling still get distinct ids', () => {
      // `slotId` derives from the FIRST alternative, so a declaration whose members share
      // one derives the same id twice — duplicate React keys, one `data-testid` answering
      // for two inputs, and a slot map that keeps the last write. The declaration cannot
      // group (a file matching one matches the other), but the panel must still RENDER it
      // without a duplicate-key error. Found by the gallery's runtime-health gate.
      const clashing = ['a/x.h5', 'a/x.h5|a/y.h5']
      const ids = slotsFor(clashing).map(m => m.id)
      expect(new Set(ids).size).toBe(2)
      // …and the FIRST one keeps the id it would have had alone, so no existing selector
      // or gallery seed key moves.
      expect(ids[0]).toBe(slotsFor(['a/x.h5'])[0].id)
    })

    it.each(declaredContainers())('%s — its slot ids are unique within the container', (_id, members) => {
      const ids = slotsFor(members).map(m => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('a shipped container that DOES declare depth exists, and its ids are now slugs', () => {
      const nested = containers.filter(([, ms]) => ms.some(m => m.includes('/')))
      expect(nested.length).toBeGreaterThanOrEqual(1)
      for (const [, members] of nested) {
        const deep = members.filter(m => m.includes('/'))
        // Before: the id carried the declaration's own separators.
        for (const m of deep) expect(preChangeSlot(m).id).toContain('/')
        // After: one slug-shaped id per member, all distinct.
        const ids = slotsFor(members).map(m => m.id)
        expect(new Set(ids).size).toBe(members.length)
        for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-{1,2}[a-z0-9]+)*$/)
      }
    })
  })
})
