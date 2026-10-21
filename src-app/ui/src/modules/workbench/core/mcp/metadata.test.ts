// TEST-19 (ITEM-18) — the ContributionCatalog projection P9's generator ingests.
// ITEM-35 removed the second projected kind (`command`) with the commands registry
// (zero contributors), so `analyses` is the ONE projected kind.
// TEST-410 (ITEM-37 → re-expressed for ITEM-4) — what an agent needs to CALL an analysis.
// It used to be the `params` FORM SCHEMA, projected with its steps flattened and its
// dependent-options RESOLVER FUNCTIONS stripped. `params` is off the manifest (INV-1: a
// form is a UI concern), so that projection has no subject; the input contract is now
// `appliesTo`, projected verbatim. See the case below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContributionCatalog } from './metadata.ts'
import { workbenchRegistry, resetWorkbenchRegistry } from '../contributions/workbenchRegistry.ts'
import { fakeLattice } from '../__testutil__/fakes.ts'
import { WORKBENCH_API_VERSION } from '../version.ts'

test('TEST-19: projects analyses with LLM metadata + availability', () => {
  resetWorkbenchRegistry()
  const base = { extensionId: 'ext', apiVersion: '^1.0' }
  workbenchRegistry.analyses.register({
    ...base,
    id: 'grouping.simple',
    title: 'Grouping',
    category: 'grouping',
    description: 'Group entries on the projection graph',
    whenHint: 'find populations',
    examples: ['group the entries'],
    appliesTo: [{ slot: 'projection', subtypes_of: 'projection' }],
    produces: ['grouping'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'l.py' },
  })
  workbenchRegistry.analyses.register({
    ...base,
    id: 'secret.op',
    title: 'Secret',
    category: 'x',
    ai: false,
    appliesTo: [],
    produces: [],
    run: { kind: 'builtin', fn: 'noop' },
  })
  // With a projection present, the analysis is available; without, gated.
  const withProj = buildContributionCatalog(
    workbenchRegistry,
    { producedTypeIds: ['projection'], version: WORKBENCH_API_VERSION },
    fakeLattice,
  )
  const grouping = withProj.entries.find(e => e.id === 'grouping.simple')!
  assert.equal(grouping.kind, 'analysis')
  assert.equal(grouping.description, 'Group entries on the projection graph')
  assert.deepEqual(grouping.examples, ['group the entries'])
  assert.equal(grouping.safety, 'read-run')
  assert.equal(grouping.available, true)
  // The tool INPUT contract: `appliesTo`, verbatim — the slot an agent binds plus the type
  // constraint it must satisfy. Not `assert.ok` on a truthy `[]`: an empty array is truthy,
  // so the old shape of this assertion passed for an analysis projecting no inputs at all.
  assert.deepEqual(grouping.appliesTo, [{ slot: 'projection', subtypes_of: 'projection' }])

  const secret = withProj.entries.find(e => e.id === 'secret.op')!
  assert.equal(secret.ai, false, 'ai:false flagged for the generator to hide')

  const gated = buildContributionCatalog(
    workbenchRegistry,
    { producedTypeIds: [], version: WORKBENCH_API_VERSION },
    fakeLattice,
  )
  assert.equal(gated.entries.find(e => e.id === 'grouping.simple')!.available, false)
  assert.equal(gated.version, WORKBENCH_API_VERSION)
  // ONE projected kind: every entry is an analysis. ITEM-9 took `selection-action` with
  // the selection feature; ITEM-35 took `command` with the commands registry. Both had
  // assertions here that are deleted WITH their subject rather than re-pointed.
  assert.ok(gated.entries.every(e => e.kind === 'analysis'))
  assert.equal(gated.entries.length, 2, 'only the two registered analyses project')
  resetWorkbenchRegistry()
})

// REPLACES 'TEST-410: buildContributionCatalog projects function-valued options/accepts to
// a JSON-serializable static fallback; a stepped schema flattens'. That test's SUBJECT is
// gone: `params` — a stepped form schema whose fields carried `optionsResolver` /
// `acceptsResolver` functions — was removed from the manifest by INV-1, so there is no
// stepped schema to flatten and no resolver to strip. Renaming its assertions from
// `entry.params` to `entry.appliesTo` (the mechanical migration) would have asserted that
// a TYPE-SELECTOR LIST has `.fields` — i.e. nothing true. The claim it protected —
// "whatever an agent is told it can call this analysis with is STATIC and
// JSON-serializable" — survives against the new input contract, and is asserted here.
test('TEST-410 (re-expressed, ITEM-4): the catalog projects `appliesTo` as the tool input contract — no form schema, no functions, JSON-round-trippable', () => {
  resetWorkbenchRegistry()
  const base = { extensionId: 'ext', apiVersion: '^1.0' }
  workbenchRegistry.analyses.register({
    ...base,
    id: 'dep.analysis',
    title: 'Dependent',
    category: 'x',
    // The input contract: one entry per SLOT the caller binds, each a type selector.
    appliesTo: [
      { slot: 'matrix', subtypes_of: 'matrix' },
      { slot: 'reference', type_id: 'clustering' },
    ],
    produces: [],
    // A REMOVED key, still carried by a (hypothetical) unmigrated contribution, holding a
    // resolver FUNCTION. `loadProcessors` refuses such a manifest outright (ITEM-25); this
    // asserts the projector is the second line of defence — it names the fields it emits,
    // so an unremoved key cannot ride through into the LLM tool surface.
    params: { fields: [{ id: 'ref', type: 'artifact-ref', acceptsResolver: () => ({ type_id: 'matrix' }) }] },
    run: { kind: 'builtin', fn: 'noop' },
  } as never)

  const cat = buildContributionCatalog(
    workbenchRegistry,
    { producedTypeIds: [], version: WORKBENCH_API_VERSION },
    fakeLattice,
  )
  const entry = cat.entries.find(e => e.id === 'dep.analysis')!

  // projected VERBATIM — no flattening, no re-shaping, no separate `accepts` list.
  assert.deepEqual(entry.appliesTo, [
    { slot: 'matrix', subtypes_of: 'matrix' },
    { slot: 'reference', type_id: 'clustering' },
  ])
  // the removed form schema does not reach the agent-facing surface at all.
  assert.equal('params' in entry, false, 'a removed manifest key leaked into the MCP projection')

  // NO function survives anywhere in the projected catalog — it round-trips through JSON.
  const roundTrip = JSON.parse(JSON.stringify(cat))
  assert.deepEqual(
    roundTrip.entries.find((e: { id: string }) => e.id === 'dep.analysis').appliesTo,
    entry.appliesTo,
  )
  const noFunctions = (o: unknown): boolean =>
    o === null || typeof o !== 'object'
      ? typeof o !== 'function'
      : Object.values(o as Record<string, unknown>).every(noFunctions)
  assert.equal(noFunctions(entry), true, 'a resolver function leaked into the MCP schema')
  resetWorkbenchRegistry()
})
