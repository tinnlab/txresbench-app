// The TS half of the shared criteria-coercion parity corpus — reader 3, plus a
// delegation guard on the shared `categoricalMatches` comparator.
//
// `src-app/testdata/criteria-coercion-corpus.json` is read by THREE readers, in three
// languages, and the feature's whole promise is that they agree cell-for-cell:
//
//   1. `provenance/criteria_script.rs::CRITERIA_PRELUDE` — the emitted replay script
//      whose sha256 is the run's attested reproducibility claim. Gated by
//      `cargo test … the_emitted_replay_matches_the_shared_coercion_corpus`.
//   2. `packages/cell-filter/compute/cell-filter.py::criteria_keep_mask` — the kernel
//      that decides the COMMITTED mask. Gated by `test_coercion_corpus.py`
//      (→ `just check-py`), in BOTH obs dtype flavours.
//   3. `primitives.ts::keep_mask` — the live preview. Gated HERE, and exhaustively by
//      `just check-coercion` (`scripts/coercion-parity.mjs`).
//
// ── ITEM-4: there was a FOURTH reader, and it is retired ──────────────────────────
//
// Reader 4 was `criteriaPredicate.ts::criteriaToPredicate` evaluated through
// `dsl/eval.ts` — the criteria lifted into a DSL predicate, i.e. a SECOND ENCODING of
// the filter this corpus pins. That encoding is deleted (`criteria` is the single
// encoding), so reader 4 has no subject. It cost the gate no cell-coercion coverage: its
// evaluation ctx was built with reader 3's own `parseValue` (ROUND-6 / B6), so it could
// never contradict reader 3 about a cell. See `README-coercion-corpus.md`.
//
// ── What the per-case delegation guard below IS (R4A-03) ─────────────────────────
//
// It is DELIBERATELY narrow and must not be described as an independent reader:
// `categoricalMatches` is byte-identical to the expression `keep_mask` already delegates
// its categorical branch to, so comparing it against `c.expect` compares an
// implementation to itself. It is kept purely as a DELEGATION GUARD — if `keep_mask` ever
// stops delegating to it, a comparator-only divergence still fails here. Calling that a
// second-reader comparison is precisely the inflated-coverage claim R4A-03 was raised for.
// (`categoricalMatches` is part of the SURVIVING criteria vocabulary, `core/criteria/`.)
//
// This file is the cheap local gate so a PREVIEW regression fails `npm run check` on its
// own. See the README for the ONE coercion rule and why each divergence was a real,
// silent, rc=0 defect.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  categoricalMatches,
  criterionColumn,
  CRITERIA_COERCION_VERSION,
  isCategoricalCriterion,
} from '@/modules/workbench/core'
import { describe, expect, it } from 'vitest'

import { keep_mask, type KeepCriterion } from './primitives'

interface CorpusCase {
  id: string
  why: string
  criteria: KeepCriterion[]
  obs: Record<string, unknown[]>
  expect: boolean[]
}

// …/ui/src/modules/workbench/core/runtime → …/src-app
const CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../testdata/criteria-coercion-corpus.json',
)

const SPECIALS: Record<string, number> = {
  inf: Number.POSITIVE_INFINITY,
  '-inf': Number.NEGATIVE_INFINITY,
  nan: Number.NaN,
}

/** The corpus' `{"$special": …}` escape → the real JS value. JSON cannot carry a
 *  non-finite number, and a non-finite obs cell is ordinary in a QC metric column. */
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object)
    if (keys.length === 1 && keys[0] === '$special') {
      return SPECIALS[(v as { $special: string }).$special]
    }
  }
  return v
}

// NOT a `try`/skip: the corpus is what makes the attested replay, the committed mask and
// this preview ONE rule, so a missing or unreadable corpus is a failure to verify.
const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as { version?: number; cases: CorpusCase[] }
const cases: CorpusCase[] = corpus.cases

describe('criteria-coercion parity corpus (reader 3 + a comparator delegation guard)', () => {
  // ROUND-6 (B2): an EXACT count, not `>= 80`. A one-directional floor let a case be
  // DELETED to hide a divergence (proven by deleting `H16` while reintroducing the
  // `_cat_hit` container defect it guards — the whole gate stayed at rc 0). The
  // authoritative guard is the case-ID list in `predicate_script.rs::CORPUS_CASE_IDS`;
  // this is its cheap local twin so `npm run check` alone reddens on a shrink.
  // C1/C2 (DOMAIN_AUDIT): the coercion rules are a SPEC with four conforming readers, and
  // `core/criteria` — not any one processor's compute script — is where it is written down.
  // The corpus has carried a `version` since it was written and nothing compared it to the
  // code, so a rule could drift away from the cases meant to pin it with no signal but
  // whichever case happened to cover it. Changing a rule now means bumping
  // `CRITERIA_COERCION_VERSION` and the corpus together, which is the point: every reader
  // is re-run against the corpus in the same change.
  it('the corpus pins the SAME spec version the code implements', () => {
    expect(corpus.version).toBe(CRITERIA_COERCION_VERSION)
  })

  it('keeps its breadth', () => {
    expect(cases.length).toBe(127)
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
  })

  for (const c of cases) {
    const obs = Object.fromEntries(
      Object.entries(c.obs).map(([k, v]) => [k, (v as unknown[]).map(decode)]),
    )

    it(`${c.id} — live preview: ${c.why}`, () => {
      expect(keep_mask(c.criteria, obs)).toEqual(c.expect)
    })

    // A DELEGATION GUARD, not an independent reader (R4A-03 — see the header).
    // `categoricalMatches` is what `keep_mask` already delegates its categorical branch
    // to, so asserting it against `c.expect` re-checks the same expression; it cannot
    // detect a divergence today. It earns its place only for the day `keep_mask` stops
    // delegating — then a comparator-only change still fails here.
    if (c.criteria.length === 1 && isCategoricalCriterion(c.criteria[0])) {
      const only = c.criteria[0]
      const col = obs[criterionColumn(only)]
      const keep = Array.isArray(only.keep) ? only.keep : []
      if (Array.isArray(col) && keep.length > 0) {
        it(`${c.id} — categoricalMatches (the shared comparator) agrees`, () => {
          expect(col.map(v => categoricalMatches(v, keep))).toEqual(c.expect)
        })
      }
    }
  }
})
