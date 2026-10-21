// TEST-17 (ITEM-16) — the schema-type discriminators.
//
// REMOVED with the stepped/wizard form + the Tier-4 code-form (deleted as unreachable —
// see the note in `extensions/widgets/form/SchemaForm.tsx`):
//   · TEST-18  — the code-form discriminator + its lazy loader thunk (`ParamsFormRef`).
//   · TEST-401 ×2 — `isSteppedSchema` + `flattenFields` over an additive and a MIXED
//     steps+fields schema, and the `projectParamsForMcp` projection of both.
//   · TEST-402 — `reachableSteps`' live path recomputation.
// Every symbol they exercised is gone. The behaviour that OUTLIVED them — a `when`-hidden
// field is excluded from both the visible set and the submitted params — was never
// step-specific and is covered flat by TEST-408 (`core/datatypes/when.test.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isArtifactRefField, isWidgetField, isScalarField, artifactRefFields } from './schema-types.ts'
import type { ParamsSchema, ParamField } from './schema-types.ts'

test('TEST-17: discriminators classify a representative params schema', () => {
  const fields: ParamField[] = [
    { id: 'resolution', type: 'number', min: 0.1, max: 2, step: 0.1, default: 0.6 },
    { id: 'method', type: 'enum', options: ['louvain', 'leiden'] },
    { id: 'flavor', type: 'boolean', default: true },
    { id: 'name', type: 'string', default: 'Cluster {embedding}' },
    { id: 'embedding', type: 'artifact-ref', accepts: { subtypes_of: 'embedding' }, multiple: true },
    { id: 'group1', type: 'widget', widget: 'cell-set-selector' },
  ]
  const schema: ParamsSchema = { fields }
  assert.equal(fields.filter(isScalarField).length, 4)
  assert.equal(fields.filter(isArtifactRefField).length, 1)
  assert.equal(fields.filter(isWidgetField).length, 1)
  assert.deepEqual(
    artifactRefFields(schema).map(f => f.id),
    ['embedding'],
  )
})
