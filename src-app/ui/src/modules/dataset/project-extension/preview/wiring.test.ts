// @vitest-environment jsdom
//
// Does the APP's own module graph reach the registration?
//
// ── Why this file exists, and why it may not import the loader ──────────────────
//
// Every other suite here answers "does registration WORK". None of them answers
// "does the shipped app RUN it", and the difference is not academic — it is the
// whole reported defect. `shipped.test.tsx` and `declared.test.ts` both
// `import … from './load'`, and that import is ITSELF what triggers the
// module-evaluation registration they then observe. So they stay green whether or
// not anything a user can reach ever imports that module.
//
// Measured, on this tree: replace the picker's `from '../preview'` with the two
// deeper imports it actually uses (`../preview/registry` + `../preview/summary`) — an
// ordinary tidy-up, after which the registration is dead code — and the whole
// dataset suite stays green at 111/111 while the shipped picker resolves nothing and
// every row falls back to a count and a title. That is a passing suite certifying a
// path production does not take, and it is why this file may import NOTHING from
// `./load`, `./declared` or the `../preview` barrel.
//
// What it imports instead:
//   * the COMPONENT the app renders (a side-effect import — whatever its own graph
//     pulls in is exactly what a browser pulls in);
//   * `./registry`, which only HOLDS the singleton and registers nothing into it.
//
// So the singleton is populated here if and only if the app's own graph populated it.
//
// The assertions are on the registry's STATE, deliberately, not on the text of any
// file: reaching the loader is a property of the import graph, and a guard that greps
// for a call survives every way of breaking this that leaves the call in place.

import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import '../components/DatasetsPanel'
import { datasetPreviewRegistry } from './registry'

/**
 * How many contributions the shipped files declare, counted WITHOUT the module under
 * test — a plain glob and a YAML parse, no reader and no loader. It is the second
 * half of the question: reaching a loader that registered some of them is still a
 * picker that silently answers for some datatypes and not others.
 */
const DECLARED_COUNT = Object.values(
  import.meta.glob('../../../../../../packages/*/dataset-preview.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>,
).reduce((n, text) => {
  const doc = parseYaml(text) as { previews?: unknown[] }
  return n + (Array.isArray(doc?.previews) ? doc.previews.length : 0)
}, 0)

it('the tree really declares something to register (a zero would make the rest vacuous)', () => {
  expect(DECLARED_COUNT).toBeGreaterThan(0)
})

it("the shipped picker's own import graph populates the app-wide registry", () => {
  expect(datasetPreviewRegistry.size).toBeGreaterThan(0)
})

it('…with every declaration the tree ships, not a subset of them', () => {
  expect(datasetPreviewRegistry.size).toBe(DECLARED_COUNT)
})
