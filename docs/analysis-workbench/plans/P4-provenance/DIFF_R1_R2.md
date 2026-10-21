# P4 — Provenance · convergence diff (r1 vs r2)

## Substantively new in r2 (not in r1)
- **`provenance_settings` singleton (ITEM-13)** — a whole settings vertical slice (table + migration +
  read-at-use cache + REST `GET/PUT /api/provenance/settings` gated `provenance::settings::{read,manage}` +
  SyncEntity + admin card + bounds validation; fields = verification toggle, re-run time/size budget,
  bundle/certificate retention, Zenodo creds). r1 has no settings table at all.
- **Graph-ownership boundary as an unresolved decision/risk (DEC-P4-1).** r2 explicitly raises that P1's
  catalog rows may ALREADY be the artifact/run/derivation-edge store, so P4 should *extend* rather than fork —
  "resolve with P1's owner before ITEM-2/3." This directly OPPOSES r1's stance (r1 keeps a fully
  provenance-owned, decoupled run/artifact/edge triple per DEC-GRAPH, decoupled from the not-yet-built catalog).
  A genuine conflict on who owns the base triple.
- **Verification badge planned + specified (ITEM-16, DEC-P4-6)** — in-sandbox headless re-run with
  tolerance-diff semantics (statistical equivalence: ARI≈1 on labels, `allclose` on embeddings, NOT bit-exact),
  set-valued output-signature check. r1 explicitly DEFERS the badge (seam only, no build).
- **WRROC RO-Crate emitter (ITEM-14) + Zenodo/DataCite DOI push (ITEM-15) as built phase-2 items**, incl. the
  concrete 4-call Zenodo REST flow + `relatedIdentifiers` semantics and the "only external-service dependency"
  call-out. r1 defers WRROC + DOI/Zenodo as declared seams only.
- **Full rootfs sha256 work item (ITEM-6, DEC-ROOTFS-DIGEST)** — surfaces that today only a 12-char prefix is
  exposed at `/sandbox/status`; needs an additive `full_content_hash()` accessor on `RootfsStatus`. r1 assumes
  the rootfs sha256 is "already present in code" with no change needed.
- **Methods richness + citation reuse (ITEM-10)** — Key Resources Table + DAS/Code-Availability statements
  (Nature + STAR styles) + citations via the existing `citations`/`lit_search` CSL path. r1's methods item is
  the templated `methodsText(params)` assembly only.
- **`fetch.txt` hole for large `.h5ad` + AnnData export-codec reuse** in the bundle (ITEM-11), plus
  `REPRODUCING.md` / `manifest-sha256.txt`. r1's bundle omits the large-object escape hatch.
- **Reuse of `mcp/resource_link.rs` `persist_links` + `ziee://` guards + `confine_under_roots`** for ingesting
  `/outputs/*` into the file store. r1 does not cite this ingest primitive.

## Substantively new in r1 (not in r2)
- **Reference-resource as a first-class schema table (P4-5, `provenance_reference_resources`)** with explicit
  columns. r2 folds reference roots into ITEM-5 prose (registered as root artifact nodes) without a dedicated
  table spec.
- **Firmly decoupled provenance-owned schema as a hard decision (DEC-P4-1/DEC-GRAPH)** — authorable now against
  decoupled tables independent of the catalog. (This is the other side of the r2 boundary conflict above.)
- **Explicit `on_study_duplicated` graph deep-copy risk (R5)** flagged as nontrivial (re-point storage refs),
  MVP-may-no-op-behind-a-flag + SDK-gap note. r2 lists duplicate-copy as a one-line hook without the risk.

## Shared substance
Both derive an identical core spine: the lineage graph as a zero-effort byproduct of the compute contract, with
the same table set (`provenance_runs` / `_artifacts` / `_edges` / `_code_blobs`, content-addressed code in
Postgres keyed by sha256), the append-only "generate → hash → store blob → run → record" ordering so a failed
run still captures code, path-agnostic `inputs.json` (slots→paths, params/seed baked into the script body →
byte-identical export), the closure invariant enforced at the chokepoint (reject inputs not a known
upload/artifact/reference), multi-output run→N-`generated`-edges fan-out (produce-atomically/consume-
individually), selection-as-recipe (predicate + pinned input hash, freehand = small id-list, bitmask
runtime-only), the two capture chokepoints (compute decorator + interaction/record-selection API with an OPEN
action registry), env digest = rootfs sha256 (+ dockerfile/lockfile), a Postgres `WITH RECURSIVE` backward walk
for export scoping (analysis = provenance unit), a BagIt/RO-Crate-SHAPED bundle (`run.sh` + per-step blobs in
topo order + `data/` + methods.md + shaped `manifest.json` upgradeable to WRROC in place), deterministic
templated methods with LLM-polish off by default, registration as a `STUDY_EXTENSIONS` study-extension with
`on_study_deleted` cascade + owner-scoped `sync:provenance*`, an FE Reproducibility panel (lineage graph +
figure→run stamp + Export) + `provenance::{read/export}` grants, and a hard block on P1/P3 with the
schema/scaffolding authorable standalone. Both adopt live8's design-only `feat/provenance` spec verbatim.

## Verdict
VERDICT: DIVERGED — needs r3
