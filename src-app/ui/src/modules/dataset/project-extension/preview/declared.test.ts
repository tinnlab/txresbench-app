// The DATA-driven contribution: the template language, and — the part that matters —
// what it does when the producer did not declare the value a template names.
//
// Every fixture id and key here is neutral (`probe/*`, `extents`), because the
// interpreter must work purely off the declaration it is handed. A fixture naming a
// real datatype would be asserting something the code is not allowed to know.

import { describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { DatasetArtifactGroup } from '@/api-client/types'
import {
  contributionOf,
  DECLARED_PREVIEW_API_VERSION,
  pathError,
  phraseContextOf,
  placeholdersOf,
  readPreviewDeclaration,
  renderPhrase,
} from './declared'
import { registerDeclaredPreviews } from './load'
import { DatasetPreviewRegistry } from './registry'
import { describePart, type SummaryDeps } from './summary'

const group = (
  datatype: string,
  decl: { meta?: unknown; structure?: unknown; count?: number } = {},
): DatasetArtifactGroup => ({
  datatype,
  count: decl.count ?? 1,
  logical_bytes: 10,
  representative_output_id: 'primary',
  representative_meta: decl.meta ?? {},
  representative_structure: decl.structure ?? {},
})

/** The title the app resolves for a group, handed to the interpreter. Neutral, like
 *  every other fixture value here. */
const CTX_TITLE = 'Probe matrix'

const ctx = (decl: Parameters<typeof group>[1] = {}, title = CTX_TITLE) =>
  phraseContextOf(group('probe/matrix', decl), title)

/** A well-formed declaration document, in the shipped YAML shape. */
const DOC = `
apiVersion: "${DECLARED_PREVIEW_API_VERSION}"
previews:
  - datatype: probe/matrix
    order: 10
    text: "{structure.extents.0} rows x {structure.extents.1} spans"
  - datatype: probe/column
    order: 20
    text: "{count} probe columns"
    one: "{count} probe column"
`

const TITLES: Record<string, string> = {
  'probe/matrix': 'Probe matrix',
  'probe/column': 'Probe column',
}

const deps = (registry: DatasetPreviewRegistry): SummaryDeps => ({
  lattice: { ancestors: () => [] },
  title: id => TITLES[id] ?? id,
  registry,
})

const registryOf = (doc: string): DatasetPreviewRegistry => {
  const registry = new DatasetPreviewRegistry()
  for (const p of readPreviewDeclaration(parseYaml(doc)).previews) registry.register(contributionOf(p))
  return registry
}

describe('placeholdersOf', () => {
  it('names the paths a template reads, deduped and in order', () => {
    expect(placeholdersOf('{count} then {meta.a} then {count}')).toEqual(['count', 'meta.a'])
    expect(placeholdersOf('{structure.extents.0} x {structure.extents.1}')).toEqual([
      'structure.extents.0',
      'structure.extents.1',
    ])
    expect(placeholdersOf('nothing to read')).toEqual([])
  })
})

describe('pathError — a path that could never resolve is REJECTED, not left to fail silently', () => {
  it.each([
    ['count'],
    ['title'],
    ['meta.n'],
    ['structure.extents.0'],
    ['meta.a.b.0.c'],
  ])('accepts %s', path => {
    expect(pathError(path)).toBeNull()
  })

  it.each([
    ['a bare producer key with no root', 'n_wide'],
    ['a bag with no key inside it', 'meta'],
    ['a sub-path on the count', 'count.0'],
    ['a sub-path on the title', 'title.0'],
    ['an unknown root', 'group.count'],
  ])('rejects %s', (_why, path) => {
    expect(pathError(path)).not.toBeNull()
  })
})

describe('renderPhrase', () => {
  it('reads the app count, both producer bags, and indexes into declared arrays', () => {
    expect(renderPhrase('{count} of them', ctx({ count: 63 }))).toBe('63 of them')
    expect(renderPhrase('{meta.n} wide', ctx({ meta: { n: 32738 } }))).toBe(
      `${(32738).toLocaleString()} wide`,
    )
    expect(
      renderPhrase('{structure.extents.0} x {structure.extents.1}', ctx({ structure: { extents: [3460, 32738] } })),
    ).toBe(`${(3460).toLocaleString()} x ${(32738).toLocaleString()}`)
    expect(renderPhrase('{meta.s} / {meta.b}', ctx({ meta: { s: 'text', b: true } }))).toBe(
      'text / true',
    )
  })

  it('reads the datatype title the caller supplied, and only from {title}', () => {
    expect(renderPhrase('{title}, {count} of them', ctx({ count: 63 }, 'Probe matrix'))).toBe(
      'Probe matrix, 63 of them',
    )
    // It is a scalar root, not a bag: no key inside it resolves, so a phrase naming
    // one is dropped rather than rendered with a hole. (`pathError` refuses such a
    // path at read time; this is the runtime half of the same rule.)
    expect(renderPhrase('{title.0}', ctx({}, 'Probe matrix'))).toBeNull()
    // …and it does NOT leak into either producer bag.
    expect(renderPhrase('{meta.title}', ctx({}, 'Probe matrix'))).toBeNull()
    expect(renderPhrase('{structure.title}', ctx({}, 'Probe matrix'))).toBeNull()
  })

  it('keeps the two bags APART — a key in one is not visible through the other', () => {
    // They really can collide: a producer stamps `nnz` into both. A merged bag would
    // make which one a declaration reads depend on an undocumented precedence.
    const c = ctx({ meta: { n: 1 }, structure: { n: 2 } })
    expect(renderPhrase('{meta.n}', c)).toBe('1')
    expect(renderPhrase('{structure.n}', c)).toBe('2')
  })

  it('DEGRADES: a value the producer never declared drops the whole phrase', () => {
    // The contract is `null` out, which the caller turns into the count-and-title
    // fallback — never a rendered hole. This is the reported defect's shape.
    expect(renderPhrase('{meta.n} wide', ctx())).toBeNull()
    expect(renderPhrase('{meta.a} x {meta.b}', ctx({ meta: { a: 12 } }))).toBeNull()
    // …including an index past the end of a declared list, and a path that walks
    // into a scalar.
    expect(renderPhrase('{structure.extents.2}', ctx({ structure: { extents: [1, 2] } }))).toBeNull()
    expect(renderPhrase('{structure.extents.a}', ctx({ structure: { extents: [1, 2] } }))).toBeNull()
    expect(renderPhrase('{meta.n.deeper}', ctx({ meta: { n: 4 } }))).toBeNull()
  })

  it('DEGRADES on a value the server would already have dropped: null, mapping', () => {
    expect(renderPhrase('{meta.k}', ctx({ meta: { k: null } }))).toBeNull()
    expect(renderPhrase('{meta.k}', ctx({ meta: { k: { nested: 1 } } }))).toBeNull()
    // A whole ARRAY is not a scalar either — only an indexed entry of one is.
    expect(renderPhrase('{structure.extents}', ctx({ structure: { extents: [1, 2] } }))).toBeNull()
  })

  it('never renders the string "undefined" or "NaN", whatever the bag holds', () => {
    for (const meta of [{}, { n: null }, { n: undefined }, { n: {} }, { n: Number.NaN }]) {
      const out = renderPhrase('{meta.n} wide', ctx({ meta }))
      expect(out).toBeNull()
      expect(String(out)).not.toContain('undefined')
    }
  })
})

describe('phraseContextOf', () => {
  it('reads both mappings, and treats every other wire shape as an empty bag', () => {
    expect(
      phraseContextOf(
        group('probe/matrix', { meta: { a: 1 }, structure: { b: 2 }, count: 5 }),
        CTX_TITLE,
      ),
    ).toEqual({
      count: 5,
      title: CTX_TITLE,
      meta: { a: 1 },
      structure: { b: 2 },
    })
    for (const notAnObject of [null, undefined, 4, 'text', [1]]) {
      const c = phraseContextOf(
        group('probe/matrix', { meta: notAnObject, structure: notAnObject }),
        CTX_TITLE,
      )
      expect({ meta: c.meta, structure: c.structure }).toEqual({ meta: {}, structure: {} })
    }
  })

  it('carries the title through VERBATIM — the app never inflects another package\'s word', () => {
    for (const supplied of ['Probe matrix', 'probe matrix', 'Probe matrix (variant)', '']) {
      expect(phraseContextOf(group('probe/matrix'), supplied).title).toBe(supplied)
    }
  })
})

describe('readPreviewDeclaration', () => {
  it('reads a well-formed document', () => {
    const read = readPreviewDeclaration(parseYaml(DOC))
    expect(read.errors).toEqual([])
    expect(read.ok).toBe(true)
    expect(read.previews).toEqual([
      {
        datatype: 'probe/matrix',
        order: 10,
        text: '{structure.extents.0} rows x {structure.extents.1} spans',
      },
      {
        datatype: 'probe/column',
        order: 20,
        text: '{count} probe columns',
        one: '{count} probe column',
      },
    ])
  })

  it.each([
    ['a document that is not a mapping', '- one\n- two\n'],
    ['a document with no previews', `apiVersion: "2.0"\npreviews: []\n`],
    ['a wrong apiVersion', `apiVersion: "1.0"\npreviews: [{datatype: p/x, order: 1, text: "{count}"}]\n`],
    ['a missing apiVersion', `previews: [{datatype: p/x, order: 1, text: "{count}"}]\n`],
    [
      'an unknown top-level key',
      `apiVersion: "2.0"\nextra: 1\npreviews: [{datatype: p/x, order: 1, text: "{count}"}]\n`,
    ],
    [
      'an unknown entry key',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, when: y, text: "{count}"}]\n`,
    ],
    ['an entry with no datatype', `apiVersion: "2.0"\npreviews: [{order: 1, text: "{count}"}]\n`],
    ['an entry with no order', `apiVersion: "2.0"\npreviews: [{datatype: p/x, text: "{count}"}]\n`],
    [
      'a non-numeric order',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: first, text: "{count}"}]\n`,
    ],
    ['an entry with no text', `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1}]\n`],
    [
      'an empty singular form',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{count}", one: ""}]\n`,
    ],
    [
      'a singular form that is broken where the plural is fine',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{count}", one: "one thing"}]\n`,
    ],
    [
      'a duplicate datatype',
      `apiVersion: "2.0"\npreviews:\n  - {datatype: p/x, order: 1, text: "{count}"}\n  - {datatype: p/x, order: 2, text: "{count}"}\n`,
    ],
    [
      'a phrase that ASSERTS instead of reading (no {path})',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "CSC-sparse"}]\n`,
    ],
    [
      'a phrase that only names the datatype — the same assertion wearing a placeholder',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{title}"}]\n`,
    ],
    [
      'a SINGULAR form that only names the datatype where the plural reads a count',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{count} x", one: "{title}"}]\n`,
    ],
    [
      'a brace that is not part of a {path}',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{count} of {meta.n"}]\n`,
    ],
    [
      'a path with no root — the TYPO case',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{n_wide} across"}]\n`,
    ],
    [
      'a path naming a bag with no key in it',
      `apiVersion: "2.0"\npreviews: [{datatype: p/x, order: 1, text: "{structure}"}]\n`,
    ],
  ])('REFUSES %s', (_why, text) => {
    const read = readPreviewDeclaration(parseYaml(text))
    expect(read.ok).toBe(false)
    expect(read.previews).toEqual([])
    expect(read.errors.length).toBeGreaterThan(0)
  })

  it('is FAIL-CLOSED per document: one bad entry drops the good ones too', () => {
    const text = `apiVersion: "2.0"
previews:
  - {datatype: probe/good, order: 1, text: "{count}"}
  - {datatype: probe/bad, order: 2, text: "constant"}
`
    expect(readPreviewDeclaration(parseYaml(text)).previews).toEqual([])
  })
})

describe('contributionOf — a declaration behaving as a contribution', () => {
  it('renders the phrase whose declarations the producer wrote', () => {
    const registry = registryOf(DOC)
    const part = describePart(
      group('probe/matrix', { structure: { extents: [3460, 32738] } }),
      deps(registry),
    )
    expect(part.text).toBe(`${(3460).toLocaleString()} rows x ${(32738).toLocaleString()} spans`)
    expect(part.contributed).toBe(true)
    expect(part.order).toBe(10)
  })

  it('accepts {title} ALONGSIDE something read, and renders both', () => {
    const registry = registryOf(`apiVersion: "2.0"
previews: [{datatype: probe/matrix, order: 1, text: "{title} — {structure.extents.0} rows"}]
`)
    const part = describePart(
      group('probe/matrix', { structure: { extents: [3460] } }),
      deps(registry),
    )
    expect(part.text).toBe(`Probe matrix — ${(3460).toLocaleString()} rows`)
    expect(part.contributed).toBe(true)
  })

  it('states the SUBTYPE\'s own title when a SUPERTYPE\'s declaration answers for it', () => {
    // The reason `{title}` is a root at all. One declaration covers a whole branch
    // through the lattice, so the name has to be resolved per GROUP — a word written
    // into the template would label a subtype with its ancestor's name.
    const registry = registryOf(`apiVersion: "2.0"
previews: [{datatype: probe/matrix, order: 1, text: "{title} — {structure.extents.0} rows"}]
`)
    const subtypeDeps: SummaryDeps = {
      lattice: { ancestors: id => (id === 'probe/matrix/narrow' ? ['probe/matrix'] : []) },
      title: id => (id === 'probe/matrix/narrow' ? 'Narrow probe matrix' : TITLES[id] ?? id),
      registry,
    }
    const part = describePart(
      group('probe/matrix/narrow', { structure: { extents: [12] } }),
      subtypeDeps,
    )
    expect(part.text).toBe(`Narrow probe matrix — ${(12).toLocaleString()} rows`)
    expect(part.text).not.toContain(TITLES['probe/matrix'])
  })

  it('picks the SINGULAR wording by cardinality, and never inflects either string', () => {
    const registry = registryOf(DOC)
    const at = (count: number) =>
      describePart(group('probe/column', { count }), deps(registry)).text
    expect(at(1)).toBe('1 probe column')
    expect(at(63)).toBe('63 probe columns')
    // Zero takes the general form: the app's rule is "exactly one", not "few".
    expect(at(0)).toBe('0 probe columns')
  })

  it('falls back to the general wording when no singular was declared', () => {
    const registry = registryOf(`apiVersion: "2.0"
previews: [{datatype: probe/column, order: 1, text: "{count} probe columns"}]
`)
    expect(describePart(group('probe/column', { count: 1 }), deps(registry)).text).toBe(
      '1 probe columns',
    )
  })

  it('DEGRADES to the count-and-title fallback when the declaration is absent', () => {
    const registry = registryOf(DOC)
    // Partial: one of the two indices is there, the other is not — a phrase is
    // all-or-nothing, so this is still the fallback and never a half-sentence.
    const partial = describePart(group('probe/matrix', { structure: { extents: [12] } }), deps(registry))
    expect(partial.text).toBe('1 Probe matrix')
    expect(partial.contributed).toBe(false)

    const none = describePart(group('probe/matrix', { structure: { other: 1 } }), deps(registry))
    expect(none.text).toBe('1 Probe matrix')
    expect(none.text).not.toContain('undefined')
    // …but it keeps the position the contribution declared.
    expect(none.order).toBe(10)
  })
})

describe('registerDeclaredPreviews', () => {
  it('registers each declared datatype, and reports the count', () => {
    const registry = new DatasetPreviewRegistry()
    expect(registerDeclaredPreviews({ 'a/packages/p/dataset-preview.yaml': DOC }, registry)).toBe(2)
    expect(registry.size).toBe(2)
  })

  it('CONTAINS a broken file: it contributes nothing, says so, and the others still land', () => {
    const registry = new DatasetPreviewRegistry()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const n = registerDeclaredPreviews(
      {
        'a/packages/broken/dataset-preview.yaml': 'apiVersion: "2.0"\npreviews: [{datatype: p/x}]\n',
        'a/packages/unparseable/dataset-preview.yaml': '{ this: [is: not: yaml\n',
        'a/packages/good/dataset-preview.yaml': DOC,
      },
      registry,
    )
    expect(n).toBe(2)
    expect(registry.size).toBe(2)
    // Contained, but not invisible — and the message names the file to fix.
    const logged = spy.mock.calls.map(c => String(c[0])).join('\n')
    expect(logged).toContain('packages/broken/dataset-preview.yaml')
    expect(logged).toContain('packages/unparseable/dataset-preview.yaml')
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})
