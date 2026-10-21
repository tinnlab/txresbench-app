# P8 Interaction DSL — r1 vs r2 convergence diff

## Substantively new in r2 (not in r1)
- **A second, server-side Rust evaluator as a first-class in-scope deliverable** (r2 PI-4), plus a **TS↔Rust golden parity corpus test** (r2 PI-5, DEC-A) asserting byte-identical bitmasks across ≥20 predicates as a load-bearing CI gate. This directly **contradicts** r1's central decision: r1 (DEC-1 + Risk R4) makes the canonical evaluator a *single* in-process TS implementation, has the server only validate+hash-pin+persist, and explicitly **defers** any Rust evaluator ("No Rust re-evaluator in scope … a Rust mirror is a follow-on"). Two evaluators + a parity harness is a large work item and a consequential architecture decision present in r2 and rejected in r1.
- **Generate the DSL type into BOTH TS and Rust from one JSON-schema with an `emit_ts.rs`-style golden-parity test** (r2 PI-2 / DEC-C). r1 publishes `predicate.schema.json` but generates only the TS AST type — no Rust type generation, no cross-language golden.
- **Canonical polygon-boundary inclusion rule as an explicit DSL-spec decision** (r2 Risk: d3 vs Rust edge determinism) — needed only because of the two-evaluator design; absent from r1.

## Substantively new in r1 (not in r2)
- **Explicit `api.brush` / `api.pick` service items and Coordination.store field additions** (r1 ITEM-12/13). r2 folds brush/pick into PI-1 but adds the same `brushRange`/`setBrush` field, so this is granularity, not substance.
- **`evaluatorVersion` recipe-versioning / migration-compat concern** (r1 Risk R6, stamped now). r2 does not raise DSL semantic versioning.
- **Selection-origin tag vocabulary** (`ai`/`widget`/`lasso`/`panel:<id>`) for self-echo/fan-out (r1 ITEM-16) — r2 covers wiring to one shared store (PI-10) but not the origin-tag taxonomy explicitly.

## Shared substance
Both plans converge on: promote live3's `IndexMask` (packed Uint32 bitmask + set-ops) as the canonical `CellSet` over the dense view-index axis with durable-id round-trip; a bounded, typed JSON predicate DSL (gene/obs/col/clustering/embedding leaves, median/mean/quantile/mad reductions, gt/lt/between/in comparisons, and/or/not set-ops, geometric pointInPolygon/inBox lasso node, idList escape hatch) authored as one JSON-schema source of truth; a column resolver over the P1 data API (sparse gene column, obs, clustering) with sparse-absent=0 / NA-outside-axis semantics; O(n) reduction kernels; geometry→predicate compilation reusing live3 `selectInPolygon`/`selectInBox`/`SelectionController`; **selection persisted as a recipe (predicate + pinned input content-hashes), never a materialized mask** (freehand idList the sole exception); `api.selection`/`brush`/`pick` wrapping Coordination.store as the one shared substrate (no per-module selection model); a `selection.setByPredicate` MCP tool with `read-run` safety (select can't harm, assign is the separately-gated mutation); a `cell-set-selector` widget core with a live cell-count preview generalizing legacy `getCellIds` include/exclude; predicate→methods-text; and a brute-force parity oracle for evaluator correctness. Same hard deps (P1 data API + catalog content-hashes, P4 provenance recipe sink, P5 workbench-api home, P7 Coordination adoption, P9 MCP generation).

## Verdict
VERDICT: DIVERGED — needs r3
