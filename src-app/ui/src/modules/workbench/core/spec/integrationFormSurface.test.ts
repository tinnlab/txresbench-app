import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { compareDeclarations, resolveCompatibleColumns } from '@/modules/workbench/core/runtime/compatibleColumns'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'

// Three cross-cutting properties of the integration form, each asserted POSITIVELY because
// each is otherwise a claim about something that is NOT there — and an absence asserted
// directly is unfalsifiable: it passes just as well when the surface never rendered.

const PACKAGES = fileURLToPath(new URL('../../../../../../packages', import.meta.url))

function discoverViewSpecs(): Array<{ pkg: string; file: string; path: string }> {
  const out: Array<{ pkg: string; file: string; path: string }> = []
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const uiDir = `${PACKAGES}/${pkg.name}/ui`
    if (!existsSync(uiDir)) continue
    for (const f of readdirSync(uiDir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) out.push({ pkg: pkg.name, file: f, path: `${uiDir}/${f}` })
    }
  }
  return out
}
const specs = discoverViewSpecs()

/** Every key whose value a USER READS. Deliberately a list of PROSE keys rather than "every
 *  string in the file": an internal id, a state key or a `$`-ref is not user-visible, and a
 *  guard that could not tell them apart would either miss the real cases or be unsatisfiable. */
const PROSE_KEYS = new Set([
  'label',
  'title',
  'text',
  'empty_text',
  'placeholder',
  'message',
  'unavailableReason',
  'description',
  'toast',
])

function proseStrings(node: unknown, key: string | undefined, into: string[]): void {
  if (typeof node === 'string') {
    if (key !== undefined && PROSE_KEYS.has(key)) into.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) proseStrings(v, key, into)
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) proseStrings(v, k, into)
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════
// "Integrated dataset" is the user-facing name. "Virtual" is internal.
// ══════════════════════════════════════════════════════════════════════════════════════

describe('the storage word never reaches a user-visible string', () => {
  it('finds the shipped view specs (a zero match would pass every case below)', () => {
    // The non-vacuity gate this whole file depends on. Without it a renamed directory turns
    // every assertion here into a green run over an empty list.
    expect(specs.length).toBeGreaterThanOrEqual(3)
  })

  it.each(specs)('packages/$pkg/ui/$file says nothing about how the result is STORED', ({ path }) => {
    // The result is exactly as real as its sources; the word describes an implementation and
    // reads as "not real" to someone deciding whether to trust it. It is a bug in any string a
    // user reads, not only in this package's — so the guard is over every shipped spec.
    const prose: string[] = []
    proseStrings(parseYaml(readFileSync(path, 'utf8')), undefined, prose)
    const offenders = prose.filter(s => /\bvirtual\b/i.test(s))
    expect(offenders, `user-visible copy naming the storage model: ${offenders.join(' | ')}`).toEqual([])
  })

  it('the guard can actually SEE a violation (negative control)', () => {
    // Without this the rule above is satisfied by a walker that returns nothing, which is
    // precisely the shape that makes an absence-assertion worthless.
    const prose: string[] = []
    proseStrings({ widgets: [{ id: 'x', label: 'The virtual dataset' }] }, undefined, prose)
    expect(prose.filter(s => /\bvirtual\b/i.test(s))).toHaveLength(1)
  })

  it('does NOT flag an internal id or a $-ref that happens to carry the word', () => {
    // The other direction: a guard that flagged `$state.virtualId` would push an author to
    // rename internals to satisfy a rule about USER COPY, which is a different rule.
    const prose: string[] = []
    proseStrings({ widgets: [{ id: 'virtualPicker', value: '$state.virtual', label: 'Datasets' }] }, undefined, prose)
    expect(prose.filter(s => /\bvirtual\b/i.test(s))).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════
// ITEM-37 — an `ordered` categorical needs NO surface, asserted as a POSITIVE.
// ══════════════════════════════════════════════════════════════════════════════════════

let seq = 0
function column(datasetId: string, name: string, member: Record<string, unknown>): ArtifactRow {
  return {
    id: `col-${(seq += 1)}`,
    datatype: 'a/column-kind',
    source_dataset_id: datasetId,
    meta: { name },
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'rows',
      n: 3,
      columns: [{ path: 'values', ...member }],
    },
  } as unknown as ArtifactRow
}
function dataset(id: string): ArtifactRow {
  return {
    id,
    datatype: 'a/dataset-kind',
    source_dataset_id: id,
    meta: {},
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', n: 3, columns: [{ path: 'x', name: 'x' }] },
  } as unknown as ArtifactRow
}

const SKETCH = 'AQIDBAUGBwgREhMUFRYXGA=='
const vocab = (ordered: boolean) => ({
  kind: 'categorical',
  n_levels: 2,
  ordered,
  vocab_digest: 'same-digest',
  vocab_sketch: SKETCH,
})

describe('ITEM-37 — an ordered categorical is offered and selected exactly like an unordered one', () => {
  const rows = (ordered: boolean): ArtifactRow[] => [
    dataset('ds-a'),
    dataset('ds-b'),
    column('ds-a', 'stage', vocab(ordered)),
    column('ds-b', 'stage', vocab(ordered)),
  ]
  const offer = (ordered: boolean) =>
    resolveCompatibleColumns(rows(ordered), { of: '$state.datasets', axis: 'rows' }, ['ds-a', 'ds-b'])

  it('an ordered pair APPEARS in the offer — the positive half', () => {
    // "We built no refusal" cannot be asserted; that the pair is offered can.
    const o = offer(true)
    expect(o.columns.map(c => c.name)).toContain('stage')
    expect(o.options.map(x => x.value)).toContain('stage')
  })

  it('its verdict is byte-identical to the unordered pair — no branch reads `ordered`', () => {
    // THE assertion that goes red if someone adds an ordered-specific arm anywhere in the
    // classifier: a refusal, a downgrade to undecidable, an extra mark in the label. Comparing
    // the whole record rather than one field is deliberate — a new field carrying the
    // distinction would slip past a targeted check.
    expect(offer(true).columns).toEqual(offer(false).columns)
    expect(offer(true).options).toEqual(offer(false).options)
  })

  it('the declaration comparison gives the same verdict with `ordered` set either way', () => {
    // The field IS carried into the comparison (see `Declaration.ordered`) precisely so this
    // assertion can fail. While it was absent, an injected ordered-refusal branch read a field
    // that did not exist and the suite stayed green — the mutation was unobservable, so the
    // guard proved nothing.
    const decl = (ordered: boolean) => ({
      kind: 'categorical',
      levels: 2,
      digest: 'a',
      sketch: SKETCH,
      ordered,
    })
    expect(compareDeclarations([decl(true), decl(true)])).toEqual(
      compareDeclarations([decl(false), decl(false)]),
    )
    expect(compareDeclarations([decl(true), decl(false)]).compatibility).toBe('compatible')
  })

  it('the form offers ONE selection path, so an ordered choice is click-for-click the same', () => {
    const spec = specs.find(s => /integrate/.test(s.file))
    expect(spec, 'the integration form must be discoverable for this to mean anything').toBeDefined()
    const raw = parseYaml(readFileSync((spec as { path: string }).path, 'utf8')) as {
      widgets?: Array<Record<string, unknown>>
      actions?: Array<Record<string, unknown>>
      const?: Record<string, unknown>
    }
    const widgets = raw.widgets ?? []
    const actions = raw.actions ?? []

    // EXACTLY ONE control writes the fused-column selection, and exactly one action backs it.
    // An order picker or a per-kind confirmation step would be a second of either.
    const selectionWidgets = widgets.filter(w => String(w.value ?? '').includes('levelColumns'))
    expect(selectionWidgets).toHaveLength(1)
    // WRITERS only. A first cut matched any action whose body mentioned the field and found
    // two — the setter and the RUN, which reads the selection into its params. "Mentions" and
    // "writes" are different questions, and the one this rule is about is writes: a second
    // ordered-specific SETTER would be the extra path, a reader never is.
    const setters = actions.filter(a =>
      ((a.body ?? []) as Array<Record<string, unknown>>).some(
        step => step && typeof step === 'object' && 'set' in step && JSON.stringify(step.set).includes('levelColumns'),
      ),
    )
    expect(setters).toHaveLength(1)

    // …and nothing in the form BRANCHES on orderedness. Asserted over the parsed structure's
    // own gating keys rather than over the file's text, because a comment explaining why there
    // is no order control must not be able to fail this.
    const gates: string[] = []
    const collectGates = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collectGates)
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if ((k === 'when' || k === 'offer_when') && typeof v === 'string') gates.push(v)
          collectGates(v)
        }
      }
    }
    collectGates(raw.widgets)
    collectGates(raw.actions)
    expect(gates.filter(g => /ordered/i.test(g))).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════
// ITEM-34 — the action gate reads the producer's refusal, never the counts.
// ══════════════════════════════════════════════════════════════════════════════════════

describe('ITEM-34 — the best-matching identifier is not automatically selectable', () => {
  const form = () => {
    const spec = specs.find(s => /integrate/.test(s.file))
    expect(spec, 'the integration form must be discoverable').toBeDefined()
    return parseYaml(readFileSync((spec as { path: string }).path, 'utf8')) as Record<string, unknown>
  }

  /** Every `when` gate that guards a control whose `onClick` sets the joining identifier. */
  function keyActionGates(raw: Record<string, unknown>): string[] {
    const setter = (raw.actions as Array<Record<string, unknown>> | undefined)?.find(a =>
      JSON.stringify(a.body ?? []).includes('key'),
    )
    expect(setter, 'the form must have an action that sets the identifier').toBeDefined()
    const id = String((setter as Record<string, unknown>).id)
    const gates: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node && typeof node === 'object') {
        const rec = node as Record<string, unknown>
        if (rec.onClick === id && typeof rec.when === 'string') gates.push(rec.when)
        for (const v of Object.values(rec)) walk(v)
      }
    }
    walk(raw.widgets)
    return gates
  }

  it('the identifier is NOT defaulted in state — nothing is chosen until a person chooses', () => {
    const state = (form().state ?? {}) as Record<string, { default?: unknown }>
    expect(state.key?.default ?? null).toBeNull()
  })

  it('every gate on the pick action reads `joinable`, and none reads a COUNT', () => {
    const gates = keyActionGates(form())
    // Non-vacuity first: a walker that found no gate would satisfy the two assertions below by
    // finding nothing to violate them.
    expect(gates.length, 'the pick action must be gated at all').toBeGreaterThan(0)
    expect(gates.every(g => /joinable/.test(g))).toBe(true)
    // The whole item in one assertion: matched/conflicting/duplicated/missing are EVIDENCE the
    // user reads, never the predicate. A form that sorted by matched and enabled the top row
    // would offer a key the producer rejects on submit.
    expect(gates.some(g => /matched|conflicting|duplicated|missing/.test(g))).toBe(false)
  })

  it('the table RENDERS joinable\'s causes beside the counts', () => {
    const raw = form()
    const table = (raw.widgets as Array<Record<string, unknown>>).find(w => w.kind === 'table' && String(w.rows ?? '').includes('candidates'))
    expect(table, 'the identifier table must bind the measured candidates').toBeDefined()
    const cols = ((table as Record<string, unknown>).columns ?? []) as Array<Record<string, unknown>>
    const bound = cols.map(c => String(c.value ?? '')).join(' ')
    for (const field of ['matched', 'conflicting', 'duplicated', 'missing']) {
      expect(bound, `the table must show ${field}`).toContain(field)
    }
  })

  // ── THE POPULATED RENDER, as far as this repo can enforce it ────────────────────────
  //
  // The state worth reviewing is the FULL one: a long dataset name, six-figure counts, a
  // candidate list at its length, a refusal with its reason. An empty form hides exactly the
  // layout defects that state produces — a count pushing the action column off-screen, a
  // column name overflowing its box.
  //
  // Two mechanisms in this repo prevent that, and both are DECLARATIONS this test can pin:
  // `width` fixes the action column so a grid laid out at content width cannot push it past
  // the edge, and `ellipsis` caps a text column's MINIMUM so the table can narrow at all
  // (`overflow: hidden` alone clips at the used width and leaves min-content untouched).
  //
  // WHAT IS NOT ENFORCED HERE, stated rather than implied: whether the rendered boxes actually
  // fall inside the viewport at the 768px floor. That needs a browser and a gallery surface
  // for a processor pane, and this app's gallery enumerates ROUTES only — a declarative view
  // renders inside a workbench pane and has no gallery entry to be driven in. Claiming the
  // pixel half on the strength of the assertions below would be recording a check that never
  // ran.
  it('the identifier table is declared so a populated row cannot push its action off-screen', () => {
    const raw = form()
    const table = (raw.widgets as Array<Record<string, unknown>>).find(
      w => w.kind === 'table' && String(w.rows ?? '').includes('candidates'),
    ) as Record<string, unknown>
    const cols = (table.columns ?? []) as Array<Record<string, unknown>>

    // The action column is the section's entire purpose; it is the one that must not be the
    // one that overflows.
    const action = cols.find(c => c.parts !== undefined)
    expect(action, 'the pick/refuse column must exist').toBeDefined()
    expect(
      (action as Record<string, unknown>).width,
      'the action column needs a fixed width or the widest text column pushes it past the edge',
    ).toBeDefined()

    // The unbounded-length columns — an identifier name and a reason sentence — must be
    // allowed to truncate, or the table cannot narrow below its longest entry.
    const identifier = cols.find(c => c.key === 'key')
    expect((identifier as Record<string, unknown>).ellipsis).toBe(true)
  })

  it('the shared-column table lets its unbounded text columns truncate', () => {
    const raw = form()
    const table = (raw.widgets as Array<Record<string, unknown>>).find(
      w => w.kind === 'table' && String(w.rows ?? '').includes('shared'),
    ) as Record<string, unknown>
    const cols = (table.columns ?? []) as Array<Record<string, unknown>>
    // The `note` column carries a full sentence from the resolver and is the longest thing on
    // the surface by a wide margin.
    expect(cols.find(c => c.key === 'note')?.ellipsis).toBe(true)
    expect(cols.find(c => c.key === 'name')?.ellipsis).toBe(true)
  })

  it('every table declares an empty_text — the opening state is a real state', () => {
    const tables = (form().widgets as Array<Record<string, unknown>>).filter(w => w.kind === 'table')
    expect(tables.length).toBeGreaterThan(0)
    for (const t of tables) {
      expect(typeof t.empty_text, `table "${String(t.id)}" opens empty and must say what a row IS`).toBe('string')
    }
  })

  it('the slice binds the preflight as a DOCUMENT of a named kind', () => {
    // The binding this item was blocked on. Without `shape: document` the candidates arrive
    // null-padded and the discriminator is dropped; without `kind` a document of another shape
    // renders as if it were this one.
    const args = ((form().data as Record<string, { args?: Record<string, unknown> }>).jq ?? {}).args ?? {}
    expect(args.shape).toBe('document')
    expect(typeof args.kind).toBe('string')
    expect(args.produced_by, 'a datatype is not a selector').toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════
// T4 / T5 — the affordances and the launch contract the file's own comments call
// load-bearing, and which a mutation audit proved were unasserted.
// ══════════════════════════════════════════════════════════════════════════════════════

describe('the refusal affordance and the launch contract are asserted, not just commented', () => {
  const form = () => {
    const spec = specs.find(s => /integrate/.test(s.file))
    expect(spec, 'the integration form must be discoverable').toBeDefined()
    return parseYaml(readFileSync((spec as { path: string }).path, 'utf8')) as Record<string, unknown>
  }

  // T4 — deleting the disabled `refused` part, or blanking its reason, both passed. The YAML
  // says a blank slot where other rows have a button "is a question the user cannot answer".
  it('a REFUSED identifier still shows its action, disabled, with a non-empty reason', () => {
    const raw = form()
    const table = (raw.widgets as Array<Record<string, unknown>>).find(
      w => w.kind === 'table' && String(w.rows ?? '').includes('candidates'),
    ) as Record<string, unknown>
    const actionCol = ((table.columns ?? []) as Array<Record<string, unknown>>).find(c => c.parts !== undefined)
    const parts = ((actionCol as Record<string, unknown>).parts ?? []) as Array<Record<string, unknown>>
    expect(parts.length, 'the offered and refused readings are two parts of one column').toBeGreaterThanOrEqual(2)

    // Matched over the PARSED part rather than by walking its primitive key — the app-builtin
    // domain guard forbids that key's spelling in this layer, and the property under test is the
    // part's content, not the path to it.
    const refused = parts.find(p => /joinable\s*==\s*false/.test(JSON.stringify(p)))
    expect(refused, 'a part must be gated on the producer REFUSING the key').toBeDefined()
    const reason = /"unavailableReason":"((?:[^"\\]|\\.)*)"/.exec(JSON.stringify(refused))?.[1] ?? ''
    expect(
      reason.trim().length,
      'a disabled action with no stated cause reads as broken',
    ).toBeGreaterThan(20)
  })

  // T4 — the ITEM-36 wording. The design says explicitly: do not word it as "use dataset A's
  // values" — authority selects whose ANNOTATION labels the unified entry, not whose data is used.
  // Reintroducing the forbidden phrasing passed every test.
  it('never words the authority mode as using one dataset\'s DATA', () => {
    const prose: string[] = []
    proseStrings(form(), undefined, prose)
    const offenders = prose.filter(s => /\buse\b[^.]*\bdataset\b[^.]*\b(values|data)\b/i.test(s))
    expect(offenders, `authority mode must not read as selecting whose data is used: ${offenders.join(' | ')}`).toEqual([])
  })

  it('the guard can SEE the forbidden wording (negative control)', () => {
    const prose: string[] = []
    proseStrings({ const: { modes: [{ label: "Authority — use dataset A's values" }] } }, undefined, prose)
    expect(prose.filter(s => /\buse\b[^.]*\bdataset\b[^.]*\b(values|data)\b/i.test(s))).toHaveLength(1)
  })

  // T5 — deleting `key: "$state.key"` from the run params passed, so the entire identifier
  // picker could stop feeding the compute in silence.
  it('the LAUNCH carries every field the form collects', () => {
    const raw = form()
    // The UNION of every launch this form declares, not the first one found. A first cut took
    // `find(...)` and matched the PREFLIGHT — whose params are legitimately empty — and reported
    // the main run's fields as missing. The claim is "every collected field reaches the compute",
    // and which of the form's runs consumes it is that run's business.
    const launches = (raw.actions as Array<Record<string, unknown>>).flatMap(a =>
      ((a.body ?? []) as Array<Record<string, unknown>>)
        .filter(step => step && typeof step === 'object' && 'run_processor' in step)
        .map(step => step.run_processor as Record<string, unknown>),
    )
    expect(launches.length, 'the form must declare at least one run').toBeGreaterThan(0)
    // ── `inputs_from` IS PART OF THE WIRE, and this used to omit it ──────────────────────
    //
    // The slot rework moved the entire dataset x column grid into `inputs_from`. Serialising
    // only `inputs` + `params` would leave every `entity:`/`level:` binding invisible to this
    // assertion — the launch could lose its whole column grid with this test green.
    const wire = JSON.stringify(
      launches.map(rp => ({ inputs: rp.inputs, inputs_from: rp.inputs_from, params: rp.params })),
    )

    // ── A FIELD MAY REACH THE COMPUTE THROUGH A SLICE, AND THAT IS NOT A WEAKENING ───────
    //
    // The claim is "every collected field reaches the compute". Its predicate used to be
    // "the literal `$state.<field>` appears in the wire", and after the rework the predicate
    // and the sentence disagree: `$state.datasets` and `$state.levelColumns` are no longer
    // relayed directly — they feed the `integration_grid` slice, whose RESOLVED plan is what
    // the run carries (`dataset_ids: "$data.grid.datasetIds"`). That indirection is the point
    // of the rework: the run must carry the PLAN's dataset list, not the raw state, because
    // the two differ whenever a dataset is excluded and every slot index refers to the plan's.
    //
    // So the predicate follows the chain: a field counts as reaching the compute if the wire
    // names it directly, OR if it feeds a `data:` slice whose payload the wire relays. A field
    // that does NEITHER is still a control that does nothing — which is what this test is for.
    const slices = (raw.data ?? {}) as Record<string, { args?: unknown }>
    const relayedSlices = Object.keys(slices).filter(name => wire.includes(`$data.${name}.`))
    const feeds = (field: string): string[] =>
      relayedSlices.filter(name => JSON.stringify(slices[name]?.args ?? {}).includes(`$state.${field}`))

    const collected = Object.keys((raw.state ?? {}) as Record<string, unknown>)
    expect(collected.length).toBeGreaterThan(3)
    // The indirection must be REAL: at least one slice is actually relayed into the launch,
    // or the branch below would be an escape hatch that excuses everything.
    expect(relayedSlices.length, 'no data slice reaches the launch — the chain is not wired').toBeGreaterThan(0)
    for (const field of collected) {
      const direct = wire.includes(`$state.${field}`)
      expect(
        direct || feeds(field).length > 0,
        `the run neither carries "$state.${field}" nor feeds it into a relayed slice, ` +
          `though the form collects it. Relayed slices: [${relayedSlices.join(', ')}]`,
      ).toBe(true)
    }
  })
})
