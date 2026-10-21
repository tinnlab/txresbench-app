// Reader 3 of the criteria-coercion parity runner: the TS LIVE PREVIEW mask
// (`ui/src/modules/workbench/core/runtime/primitives.ts::keep_mask`).
//
// Prints one JSON document to stdout:
//
//   {"<case id>": {"preview": [bool,…]}, …}
//
// `preview` is the mask the user watches while tuning the filter.
//
// ## ITEM-4 — this file used to be readers 3 AND 4
//
// Reader 4 was the TS DSL BUILDER (`core/dsl/criteriaPredicate.ts`): the criteria lifted
// into a `CellSetPredicate` and EVALUATED through `dsl/eval.ts`, i.e. the RECORDED
// predicate a saved filter run stored. That was a SECOND encoding of the same filter, and
// the gate existed largely because the two could disagree. The lift is deleted — `criteria`
// is the single encoding — so reader 4 has no subject and is gone with it.
//
// What the gate still protects is unchanged and is the reason it survives: readers 1-3
// (the emitted Rust→python replay script, the committed python kernel, and this preview)
// are three INDEPENDENT implementations of the ONE criteria coercion, and they must agree
// cell-for-cell. Round 3 measured 12 disagreements out of 80 by hand.
//
// Note reader 4 was never an independent CELL coercion anyway (ROUND-6/B6): its evaluation
// ctx was built with reader 3's own `parseValue`, so flipping a cell rule moved readers 3
// and 4 identically. The cell rule's genuinely independent checks are readers 1 + 2 (two
// separate python implementations) plus `coercion-parity-ws-check.mjs` — all of which
// survive. Retiring reader 4 therefore costs the gate no cell-coercion coverage.
//
// Run standalone:
//   node --experimental-strip-types \
//        --import ./src-app/ui/scripts/ts-resolve.mjs \
//        scripts/coercion-parity-ts.mjs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { keep_mask } from '../src-app/ui/src/modules/workbench/core/runtime/primitives.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = resolve(ROOT, 'src-app/testdata/criteria-coercion-corpus.json')

const SPECIALS = {
  inf: Number.POSITIVE_INFINITY,
  '-inf': Number.NEGATIVE_INFINITY,
  nan: Number.NaN,
}

/** The corpus' `{"$special": …}` escape → the real JS value (JSON cannot carry a
 *  non-finite number, and a non-finite obs cell is ordinary in a QC column). */
function decode(v) {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object' && Object.keys(v).length === 1 && '$special' in v) {
    return SPECIALS[v.$special]
  }
  return v
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'))
const out = {}
for (const c of corpus.cases) {
  const obs = Object.fromEntries(Object.entries(c.obs).map(([k, v]) => [k, v.map(decode)]))
  out[c.id] = { preview: keep_mask(c.criteria, obs) }
}
process.stdout.write(JSON.stringify(out))
