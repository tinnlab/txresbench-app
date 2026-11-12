# Cross-Part Consistency Audit (P1..P11 FINAL.md)

Blind consistency pass over the 11 consolidated part plans. Focus: ownership
collisions, seam-shape mismatches, unresolved boundaries, dependency cycles.

**Headline:** the five *intended* ownership carve-ups are all correctly honored
(no part re-claims the catalog table, the provenance graph, the datatype
registry, the DSL, or the blob-GC sweep it shouldn't). The remaining problems are
**contract-shape drift and duplicated build items on shared seams** — real, but
localized and fixable without re-architecting.

---

## Ownership collisions

### Intended resolutions — VERIFIED HONORED
| Resolution | Verdict | Evidence |
|---|---|---|
| P1 owns `artifacts`/catalog table | ✅ honored | P1 res#1; P2 DEC-1 + ITEM-23 anti-regression test (`datatype` is `TEXT`, no FK); P4 DEC-OWN ("NO `provenance_*` triple"); P5 baked-res#1 |
| Provenance graph = P1 catalog edges; P4 owns capture+code-blobs+reproduce | ✅ honored | P1 res#2; P4 DEC-OWN + facade (ITEM-1) as sole write path |
| Datatype registry in P2 core; P5 consumes | ✅ honored | P2 DEC-1/DEC-3; P5 baked-res#1 (re-export types only) |
| Cell-set DSL owned by P8; P5 surfaces | ✅ (wording caveat below) | P8 DEC-2; P5 baked-res#2 (import P8→P5) |
| Blob-GC refcount sweep = P1; P10 cascade collects | ✅ honored | P1 res#3/ITEM-14; P10 DEC-5/ITEM-9 ("agreed P1+P10 r3") |

### Residual collisions (unflagged by the FINALs)

- **[MED] SchemaForm renderer double-built by P5 and P6.** P5 ITEM-16 creates
  `src/form/SchemaForm.tsx` + `fields/ArtifactRefField.tsx` + `widgets/registry.ts`;
  P6 ITEM-8 creates `form/SchemaForm.tsx` + `form/fields/*` + `form/widgets/registry.ts`
  — same filenames, two trees, and P6's "Consumes" list does **not** name SchemaForm
  as coming from P5. Both describe building the full 4-tier renderer. Resolution is
  obvious (P5 ships the renderer in the package; P6 consumes) but neither states it.

- **[MED] Registry→MCP tool generator double-owned by P5 and P9.** P5 ITEM-30:
  "P5 owns the generator + safety-mapping." P9 ITEM-5: `build_workbench_catalog(...)`
  is P9's "generator core." P5 puts it in TS (`@txresbench/workbench-api/mcp/project.ts`);
  P9 puts it in Rust (`workbench_mcp/generator.rs`) sourcing a P5 *backend*
  `ContributionCatalog` (P9 ITEM-4). The runtime MCP tools/list must be served
  Rust-side, so a TS package generator cannot be the emitter. Both literally say
  "owns the generator." Needs a split: P5 owns the projection *spec* + safety map;
  P9 owns the Rust runtime generator.

- **[LOW-MED] `switch→registerViewKind` viz refactor double-claimed.** P7 ITEM-3–7
  and P5 ITEM-31 both describe performing the closed-`CellKind`→open-registry rewrite.
  Coordinate which part executes it (P7 owns viz-core; P5 owns the contribution point).

- **[LOW-MED] Catalog/workstore StudyExtension cascade enumerated in both P1 and P10.**
  P1 ITEM-12 (`workstore/study_extension/`) and P10 ITEM-7 (`analysis_catalog/study_extension/`)
  both register the `STUDY_EXTENSIONS` delete/duplicate cascade for catalog rows +
  blob refs. P10 DEC-11 says it "lands with P1," so intent agrees — but the module
  name differs (`workstore` vs `analysis_catalog`) and both count it as their own item.

- **[LOW-MED] CellSetPredicate AST "ownership" wording conflict.** P5 says "P5 owns
  the `CellSetPredicate` AST types"; P8 says "the DSL SCHEMA … is OWNED by P8. P5 …
  does not define the schema," and P8 ITEM-3 *generates* the TS/Rust AST from its
  schema. Both agree the file lives in the workbench-api package and import is P8→P5;
  only the word "own" is applied to the AST by both. Pin: P8 authors schema+codegen;
  P5 hosts/re-exports the generated types.

---

## Seam mismatches

- **[HIGH] Outputs `manifest.json` field vocabulary diverges across P1/P2/P3/P4** —
  the co-owned compute→ingest contract, and the single most load-bearing seam.
  - P1 ITEM-5: top-level **array** `[{output_id, datatype, from, layout?}]`
  - P3 ITEM-15 / DEC-K: object `{ produces: [{id, kind, from}] }`
  - P2 ITEM-15: `{id, type, from}` (under `produces`)
  - P4 ITEM-8: set of `(output_slot, hash)`

  Same intent (slot-name + type + rel-path), but three different key names
  (`output_id`/`id`/`output_slot`, `datatype`/`kind`/`type`) and two container
  shapes (bare array vs `{produces:[…]}`). A literal `serde` struct will not
  cross-deserialize. P1 claims to "write the JSON-schema as the shared contract";
  P4 R1 calls this "the highest interface risk." **Must pin one vocabulary + one
  container shape before P1/P3 implement.**

- **[MED] Catalog-write sync entity name collision.** P1 ITEM-13 adds
  `SyncEntity::Artifact`; P10 ITEM-13 adds `SyncEntity::AnalysisResult` — the *same*
  event (a produced catalog row → notify-and-refetch the study catalog) minted as two
  different variants on the closed `SyncEntity` enum. Inherits the unresolved
  `artifacts` vs `analysis_results` table-name oscillation (P1 itself uses both).
  Pick one entity name.

- **[LOW-MED] Conformance-battery move direction conflict (package-cycle risk).**
  P7 ITEM-8: "**move** conformance/invariants into `@txresbench/workbench-api` and
  re-export." P5 ITEM-31: "**re-export, not re-implement**" (source stays in
  viz-core). P7 DEC-P7-4 also insists viz-core stays `@txresbench/*`-free/standalone and
  runs conformance at register time. If the source truly *moves* to workbench-api,
  viz-core must import P5 to self-validate → the exact package cycle P5's own risk
  list warns against. Resolution both accept: invariants **source stays in viz-core**;
  P5 re-exports; viz-core never imports the workbench-api package.

- **[LOW] P2 ITEM-15 references a stale FK target.** It says `produced_by_run_id`
  "FK targets **P4's run node**," but DEC-OWN relocated the run node into **P1's
  catalog**. Should read: FK → P1 catalog `run_id`. (No P4 run table exists to
  point at.)

- **[LOW] Data-plane endpoint path drift.** P7 ITEM-17 reads `GET /datasets/{id}/…`
  octet payloads; P1 serves `GET /api/artifacts/{id}/data` + `/slice`. P7's `wire.ts`
  was designed against the older `/datasets/` naming; the `PlatformDataSource` adapter
  absorbs it, but confirm the endpoint contract. Also P11 assumes `api.files.upload`,
  which is not in P5's enumerated facade list (data/selection/compute/commands/ui/
  storage/events) — the upload surface owner is unstated.

### Seams verified CONSISTENT
- P8 evaluator ↔ P1 column read: P8 `data.geneColumn → {row:Uint32Array,
  value:Float32Array}` matches P1 `sliceColumn → {row:Uint32Array, value:Float32Array}`
  (CSC gene-column). ✅
- Canonical axis: P8 `system_cell_id` + durable `(sample, local_index)` == P1
  `workstore_cell_axis` identity. ✅ (P9 R4's shared-axis requirement is met.)
- View-kind descriptor single-source: P7 defines in viz-core, P5 re-exports
  (P7 DEC-P7-4). ✅
- P9 role→safety gate: P10 owns `role_max_safety` map (ITEM-14); P9 wires it. ✅

---

## Unresolved boundaries

- **Scatter/matrix view-kind ownership (P7 ↔ P11)** — the intended sole open
  boundary. Both flag it symmetrically: P7 DEC-P7-11 and P11 D10 ("owned/registered
  by P11 vs provided by P7"). ✅ correctly the one openly-marked dispute. (P7 U3's
  view-kind→datatype vs datatype→view-kind direction is effectively closed by P2
  DEC-7 = datatype-declares-viewers; only the ownership of the concrete scatter
  registration remains open.)

- **[additional, LOW] `kmeans` + `repeat-per` (P11 D5 ↔ P5/P6).** P11 leaves kmeans /
  per-embedding `nCluster` open "against whether P6 ships `repeat-per`." P5 ITEM-16
  claims to build `repeat-per` sub-forms; P6 is noncommittal (DEC-P6-9 "don't
  gold-plate Tier-1 conditionals"). So a second small boundary is open, contingent on
  P5-vs-P6 repeat-per ownership. Not flagged as cross-part in any FINAL.

The prompt's premise that scatter is the *only* remaining open boundary is
**mostly true but not strict**: the HIGH manifest-shape drift, the SchemaForm and
MCP-generator duplications, and the `repeat-per`/kmeans question are additional
unreconciled cross-part edges the plans do not flag as open.

---

## Dependency graph

Edges are "X depends on / is blocked-by Y" taken from each `## Dependencies`.

```
P1  → P10(substrate, already-merged)
P2  → P1, P3, P4, P10, P7
P3  → P1, P2, P4, P5
P4  → P1, P2, P3, P8, P10, P6, P7
P5  → P1, P2, P3, P7, P8, P10, (P4 loose)
P6  → P1, P2, P5, P7, P8, P10
P7  → P1, P2, P5, P6, P8, P4
P8  → P1, P2, P4, P5, P6, P7
P9  → P1, P2, P3, P4, P5, P6, P8, P10
P10 → P1, P2, P3, P4, P5, P6, P8, P9
P11 → P1, P2, P3, P4, P5, P6, P7, P8, P9, P10
```

**Acyclic? NO — the naive edge graph is heavily cyclic.** 2-cycles present:
P1↔P10, P2↔P3, P2↔P4, P3↔P4, P3↔P5, P4↔P8, P5↔P7, P5↔P8, P6↔P7, P6↔P8,
P7↔P8, P9↔P10.

**But every cycle is a co-design seam that the FINALs resolve into a single
build-order direction**, so the actual *code-import + land-order* graph is a DAG:

1. **Time-broken by already-merged bases.** P1↔P10: P10's *substrate* is merged
   on-branch (P1 builds on it); P10's *new* GC/cascade items co-land with P1
   (P10 DEC-11). live3-viz and live8 are likewise merged bases, not concurrent work.
2. **Type-owner pinned to one side.** Each co-design pair names a single source of
   truth and a one-way import: DSL types P8→P5 ("never reverse"); ViewKind descriptor
   viz-core→P5 re-export; RunSpec P5→P3-impl; datatype/kind strings P2→P3; recipe
   type P8→P4; catalog run node → P1 (not P4).
3. **No-op seams decouple land order.** P3 ships `ArtifactIngestSink`/`RunRecorder`
   as no-op defaults (ITEM-27/28), wired to P1/P4 only at merge — so P3 lands without
   importing P1/P4.

**Effective build-order DAG:**
```
{P10-substrate, live3-viz, live8}  (merged)
        │
        ▼
       P1 ──► P2 ──► P3 ──► P4        (Phase-0 foundation; P10-new GC co-lands w/ P1)
        │              │
        └──────────────┴──► P5        (contract layer)
                             │
                    ┌────────┼────────┐
                    ▼        ▼        ▼
                   P6       P7       P8   (shell / viz / interaction)
                    └────────┼────────┘
                             ▼
                            P9          (ai-mcp; also needs live1 substrate)
                             ▼
                            P11         (vertical slice — pure consumer)
```
This is acyclic. The **one genuine residual cycle risk** is the conformance-battery
move (P7 ITEM-8 "move into workbench-api" vs viz-core-stays-P5-free) — if built as
P7 ITEM-8 literally reads, it creates a real `viz-core → @txresbench/workbench-api →
viz-core` package cycle. Resolve per the seam-mismatch note above.

Separately: P9's blocking dependency on the **MCP/chat/approval substrate** (P9
ITEM-1/2) is *external* to P1–P11 (owned by live1/SDK Tier-1), not an inter-part
cycle, but it is P9's dominant risk (P9 DEC-1, human-surfaced).

---

## Verdict

**Architecturally COHERENT on the load-bearing decisions** — all five intended
ownership carve-ups (catalog table, provenance graph, datatype registry, cell-set
DSL, blob-GC sweep) are correctly honored across every adjacent plan, and the
part graph, once the co-design seams are read with their pinned type-owner
directions + already-merged bases, is acyclic.

**Not clean, though: 5 must-fix cross-part inconsistencies** (ranked):

1. **[HIGH] Outputs `manifest.json` field/shape drift** across P1
   (`[{output_id,datatype,from}]`) / P3 (`{produces:[{id,kind,from}]}`) /
   P2 (`{id,type,from}`) / P4 (`(output_slot,hash)`). Co-owned P1↔P3 contract, won't
   deserialize as written. Pin one JSON-schema before Phase-0 implements.
2. **[MED] SchemaForm renderer double-built** by P5 ITEM-16 and P6 ITEM-8 (same
   filenames, two trees, no cross-defer). Assign to one owner.
3. **[MED] Registry→MCP generator double-owned** by P5 ITEM-30 ("P5 owns the
   generator") and P9 ITEM-5 (`build_workbench_catalog`). Split spec (P5) vs runtime
   Rust generator (P9).
4. **[MED] Catalog-write `SyncEntity` name collision**: P1 `::Artifact` vs P10
   `::AnalysisResult` for the same event on a closed enum. Pick one.
5. **[MED] Conformance-battery move direction** (P7 ITEM-8 vs P5 ITEM-31) →
   `viz-core ↔ workbench-api` package-cycle risk. Keep source in viz-core, re-export
   from P5.

Plus LOW cleanups: P2 ITEM-15 stale "FK → P4 run node" (should be P1 catalog);
P1↔P10 workstore-StudyExtension module-name unification (`workstore` vs
`analysis_catalog`); P7 `/datasets/` vs P1 `/api/artifacts/` endpoint naming +
undefined `api.files.upload` owner; P11 D5 `repeat-per`/kmeans contingent on
P5-vs-P6 ownership.

**VERDICT: 5 must-fix issues (1 HIGH, 4 MEDIUM) — otherwise coherent.**
