# Completeness audit — design corpus vs the 11 part FINALs

Blind coverage audit. Design corpus = `PLATFORM_ARCHITECTURE.md` (§0–§10), `DATA_MODEL.md`,
`WORKBENCH_IA.md`, `BUILD_PLAN.md`. Question: does every MAJOR architectural capability the design
specifies have a real home in some part's FINAL (dropped scope), and does every FINAL trace to the
design (scope creep)?

Legend: **FULL** = a part plans it concretely as owned scope; **PARTIAL** = planned but with a
gap/unowned prerequisite/MVP-noop; **MISSING** = no plan. "Deferred-by-design" = the corpus itself
says build the seam now, populate later (BUILD_PLAN deployment table + DATA_MODEL honest-scope note) —
these are correct omissions, not dropped scope.

## Coverage matrix

| # | Design capability | Source | Part(s) | Coverage |
|---|---|---|---|---|
| 1 | Contribution points / 7–8 registries + versioned `@cyto/workbench-api` | PA §1, §2 | **P5** | FULL |
| 2 | Manifest (declarative, indexed-without-executing, lazy activation, semver gate) | PA §3 | **P5** (14/15) | FULL |
| 3 | Open datatype registry + subtyping lattice + `accepts`/`produces` type-match gating | DATA_MODEL, PA §1/§5 | **P2** | FULL |
| 4 | Capabilities vocab + viewers-keyed-by-datatype dispatch | DATA_MODEL, PA §4.2 | **P2** (5/19) + **P7** (11/12) | FULL |
| 5 | Storage layouts keyed on LAYOUT (dense/sparse/columnar/1d/opaque) | DATA_MODEL | **P1** (4/9) + **P2** (8) | FULL |
| 6 | Zarr/Parquet served + self-indexed genomics/structure as-is; authed byte-Range/206 (Tier-1) | DATA_MODEL storage table | **P1** (8) + **P2** (11) | FULL (near-term single-cell; VCF/BAM/BigWig/mmCIF as-is are seam-open) |
| 7 | Tier-2 server typed-binary slicer (gene-column hot path) | DATA_MODEL Tier-2 | **P1** (9) + **P2** (9) | FULL (P2 `LayoutSlicer` seam; client zarrita is the near-term default) |
| 8 | Tier-3 precompute-as-analysis (pyramid/tabix/downsample of novel format) | DATA_MODEL Tier-3 | **P2** (10 routing), **P1**/P3 (h5ad→Zarr) | PARTIAL — routing/seam only; no discrete precompute deliverable (it IS "an analysis", so mechanism exists via P3/P11) |
| 9 | HDF5→Zarr ingest (convert + kerchunk-virtualize) | DATA_MODEL storage | **P2** (17) host-lite + **P3**/P11 sandbox | FULL |
| 10 | Multi-output run (1 run → N typed artifacts, produce-atomically/consume-individually) | DATA_MODEL | **P1** (5) + **P2** (15) + **P4** (DEC-MULTI-OUTPUT) | FULL |
| 11 | Canonical cell/gene axes + dense view-index alignment | PA §5, DATA_MODEL | **P1** (3) | FULL |
| 12 | Provenance graph = catalog derivation edges; run nodes/edges/content-hash | PA §0.6 | **P1** (owns graph) + **P4** (capture) | FULL |
| 13 | Content-addressed code blobs + path-agnostic `inputs.json` (provenance-for-free) | PA §0.6, §4.1 | **P4** (2/10/11) + **P3** (13/14/16) | FULL |
| 14 | Reproduce-script + templated methods-text + env-pinning + RO-Crate + verify-badge + DOI | PA §0.6, BUILD_PLAN P4 | **P4** (16–24) | FULL |
| 15 | Reference-resource roots (genome/atlas/gene-sets as provenance roots) | PA §0.6 (journals) | **P4** (4/5) | FULL |
| 16 | Cell-set predicate DSL + worked example ("gene ABC > median → label XYZ") | PA §0.4.1 | **P8** | FULL |
| 17 | Selection-as-recipe (predicate + pinned input hash, never materialized) | PA §0.6 | **P8** (13/14) + **P4** (14) | FULL |
| 18 | Shared selection/brush/pick primitives + overlays (interactive-tool substrate §4.4) | PA §4.4 | **P8** (15/16/17) + **P7** (16 overlays) | FULL |
| 19 | AI/MCP: one declaration → UI + MCP tool + API; registry→MCP generator | PA §0.4/§0.4.2 | **P9** (5–10) + **P5** (30) | FULL (generator) — but see gap A |
| 20 | Per-study built-in MCP server + two-level authz + safety→approval + resources/world-model | PA §0.4/§0.5 | **P9** (12/13/14/9) + **P10** (14) | FULL |
| 21 | Human+AI co-drive one shared state via sync | PA §0.4 | **P9** (18) + **P10** (13) | FULL |
| 22 | Study substrate — tenancy/role/sharing/transfer/lifecycle/sync | PA §0.5 | **P10** | FULL |
| 23 | Lifecycle cascade over all data layers + blob-GC seam | PA §0.5/§5.5 | **P10** (7/8/9) + **P1** (12/14 sweep) | FULL |
| 24 | Viewer read-only hand-off (PI/reviewer JTBD) | PA §0.5 | **P10** (15) | FULL |
| 25 | Compute contract (/inputs→/outputs+manifest, bwrap, ExtraMount) | PA §4.1 | **P3** | FULL |
| 26 | Job scheduling: priority class × resource/backend pool × fair-share; Tier-0 not-a-job | PA §4.1.1 | **P3** (18–23) + **P8** (in-proc eval) | FULL (single pool + interactive/batch + per-user fair-share near-term; gpu/highmem/cluster seam-open) |
| 27 | Compute topology: control/data-plane split, `ComputeBackend` seam anywhere | PA §4.1.2 | **P3** (8/9/10) + **P1** (object-store data plane) | FULL (local bwrap only; remote/HPC/cloud seam-open per BUILD_PLAN) |
| 28 | Workbench IA — center hero + L/R/bottom docks, collapse-to-stripe, toolbar, dark chrome | WORKBENCH_IA | **P6** | FULL |
| 29 | Semantic placement + host-rendered panels (form-from-schema, result-from-kind) | PA §4.5, §4.3 | **P6** (6/8/9) + **P5** (16) | FULL |
| 30 | Form tiers 1–4 (scalar / artifact-ref picker / shared widgets / code escape) | PA §4.3 | **P5** (16–19) + **P6** (8) | FULL |
| 31 | Small-multiples + linked brushing (Coordination) | WORKBENCH_IA, PA §4.2 | **P7** (13/15) + **P6** (10) | FULL |
| 32 | Viz view-kind registry (switch→register) + conformance battery published | PA §4.2 | **P7** + **P5** (31) | FULL |
| 33 | Declarative backend §6.5-A: settings / result-kinds / collections(Layer-C) / jobs provisioners | PA §5.5, §6.5-A | **P5** (23/24/25/26) | FULL for settings+result-kind; PARTIAL for collections (lower-pri) + jobs (deferred net-new cron) |
| 34 | Sidecar gateway §6.5-B (`/api/ext/<id>/*` reverse-proxy, bio_mcp model) | PA §6.5-B | **P5** (33) | Deferred-by-design (seam only, BUILD_PLAN Phase 6) |
| 35 | External manifest loader + hub marketplace | PA §7, BUILD_PLAN P5b/6 | **P5** (33) | Deferred-by-design |
| 36 | Three vertical-slice modules (data-io / embedding / clustering) as no-Rust extensions | PA §8.5, BUILD_PLAN P3 | **P11** | FULL |
| 37 | Annotation / lasso→annotate write-back loop | WORKBENCH_IA dec 4, PA §4.4 | **P6** (12) + **P5** (9 `writeAnnotation`) | PARTIAL — wired in shell+facade, but no part builds the annotation artifact write / annotation module (assumed to fall out of `writeResult`+`metadata-column`) |
| 38 | General datatypes (variant/vcf, structure/pdb, genome/bigwig, image/ome-tiff) + non-deck viewers (Mol*/igv.js/Viv) | DATA_MODEL | **P2/P7** seams | Deferred-by-design (honest-scope note) |
| 39 | WASM in-process plugin tier (§6.5-E) | PA §6.5 | — | Deferred-by-design (future) |

## Dropped scope (design capabilities without a full home)

1. **AI/MCP host substrate (gap A — the one material gap).** The design treats "one declaration →
   three surfaces" as a *headline* property (PA §0.4). The registry→MCP **generator** is fully
   planned (P9 G-stratum + P5 ITEM-30). BUT P9 grounds that CytoAnalyst has **no chat / LLM / MCP-host
   / tool-approval substrate at all** — only `{app,dataset,file,health,jobs,rootfs,sandbox,study,sync,
   user}`. The substrate (`ziee-mcp` + `ziee-ai-providers` + a minimal `chat` module + approval flow)
   is P9 ITEM-1/2, explicitly **"owned jointly with the platform bootstrap / live1 — P9 depends on it,
   does not own it."** So the largest AI dependency is assigned *outside* the 11 parts. The design
   capability is planned; its foundation is a co-owned, unbuilt, XL prerequisite. Flag to the human
   (P9 DEC-1 does).

2. **Annotation write-back loop (minor).** WORKBENCH_IA decision 4 + PA §4.4 make lasso→assign-
   annotation-→new-metadata a first-class loop. P6 (right dock) and P5 (`data.writeAnnotation` facade)
   reference it, but **no part owns the annotation artifact write / an annotation module** — it's
   assumed to compose from P1 `writeResult` + P2 `metadata-column`. Thin but unowned; the annotation
   *module* is (correctly) a future module 4+, yet the write-back affordance the shell renders needs a
   concrete producer. Confirm P1/P6 own the generic `writeAnnotation` endpoint.

3. **Tier-3 precompute (routing-only).** DATA_MODEL Tier-3 (a precompute emitting a Zarr pyramid /
   tabix index / downsample) is a routing concept in P2 ITEM-10 with no discrete deliverable; it
   relies on "it's just an analysis" (P3/P11). Acceptable near-term (single-cell doesn't need it), but
   no part exercises a real Tier-3 precompute.

4. **`on_study_duplicated` provenance deep-copy (MVP no-op).** P4 ITEM-26/R11 allows duplicate to
   no-op the provenance graph copy behind a flag (re-pointing storage refs is nontrivial). Study-
   duplicate therefore may not carry lineage in the MVP.

*Everything else the design defers itself* (general datatypes + non-deck viewers, external loader +
sidecar gateway, jobs/cron provisioner, WASM, remote/HPC/GPU backends) is seam-open by BUILD_PLAN's
deployment table + DATA_MODEL's honest-scope note — correct omissions, not dropped scope.

## Scope creep (FINAL items with no design basis)

None material. All 11 FINALs trace to the corpus. Minor additions, each justified:
- **P3 cgroup-v2 live metric read-back (ITEM-24/25/26)** — not named in the corpus but is a concrete
  implementation of the §4.1.1 resource-caps/enforcement requirement, grounded in the existing
  `job_metrics` surface. Legitimate.
- **P4 DOI deposit + per-figure capsule (ITEM-24/31)** — DOI is explicit in PA §0.6; the per-figure
  capsule is a bounded extension of the figure→run stamp. In scope.
- **P8 two evaluators (client TS + server Rust) + golden parity** — PA §0.4.1 says "in-process
  (host/client)"; the server evaluator is *required* by the design's own claim that `setByPredicate`
  is a headless MCP tool. Not creep.
- **P6 mobile/responsive (ITEM-16)** — beyond WORKBENCH_IA (desktop-first), but explicitly optional/
  desktop-first-accepted. Trivial.

## Verdict

The 11 FINALs **collectively cover the full design surface** with disciplined cross-part ownership
(P1 owns the table/graph; P2 the type meaning; P4 capture/repro; P8 the DSL; P10 the scoping;
generators/facades sit above). The corpus's own deferrals (general datatypes, external extensibility,
remote compute, WASM) are consistently carried as open seams, not dropped.

**Two genuine gaps**, both flagged inside the plans themselves:
- **A (significant): the AI/MCP host substrate** (chat + mcp-host + approval + ai-providers) is a
  hard, XL prerequisite for a headline capability, and is assigned to live1/platform-bootstrap
  **outside the 11 parts** — the one place a "complete" plan leans on unowned work.
- **B (minor): the annotation write-back loop** is wired in the shell/facade but its concrete
  producer is unowned.
Plus two minor MVP-noops (Tier-3 precompute is routing-only; `on_study_duplicated` provenance copy).

**VERDICT: 2 gaps** (1 significant AI-substrate seam owned outside the parts + 1 minor annotation
write-back; 2 further minor MVP-noops). No dropped major capability, no material scope creep.
