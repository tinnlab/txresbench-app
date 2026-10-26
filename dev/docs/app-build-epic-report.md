# TxResBench app epic — planning report (reconcile + freeze)

Status: **planned, reconciled, frozen** (epic-lifecycle phases 0–4; `epic-check` 0–4 green).
Artifacts: `.lifecycle/txresbench-app/{GRAPH,RECONCILE,STATUS,OWNER-QUESTIONS}.md` + 17 node
`PLAN.md`/`TESTS.md`/`DECISIONS.md`/`BASE.md`. Plans only — nothing built.

## Unmet contracts: 0

167 contract edges, all verdict MATCH (RECONCILE.md); every `CONS` binds a real provider `PROV`
(in-epic or GRAPH-pinned external: benchmark, oci, host, sqlx, tauri). DAG re-verified acyclic
over the FULL 46-edge set (Kahn): 5 leaves; sinks `ui-history` + `installers-release`; 8 waves.

## Providers grown (13 plans edited — every seam change provider-owned):

- **method-catalogue**: `embeds_training_data`; MethodSummary full-fact set; 3 outcome-availability reason codes; env-image vs layer-ref distinction.
- **sandbox-stacked**: `sink` + live log frames; `&SqlitePool`; registry validation accepts base AND layer prefixes; layer-manifest binding.
- **method-env-images**: `/layer-manifest.json` in every built layer (mount-entry list).
- **execution-engine**: `input_summary.file_names`; `model_ids`; produced `size_bytes`/`own_auc`; `POST …/at-a-time`; `task` enum.
- **history-store**: multi-value `status`; `models_used`; `usage.data_dir`; **model-store**: `marker_count`/`uses_covariates`/`pretrained_catalogue_version`; `models_dir`; path import + `list_pretrained`; engine-truth `source_label`.
- **pretrained-catalogue**: binds grown seams; **ui-list**: `onSectionAction` + 5 reason codes; **ui-intake**: in-memory `validation`; **ui-run**: CONS-UI-RUN-17; **ui-models**: CONS-UM-24; **ui-results**: save-one event + barrel exports; **landing-site**: `downloads[].kind` enum.

No consumer dropped a need; nothing descoped. Two bindings ADDED at reconcile (PROV-MS-8
resolve; PROV-HS-4 keep-copies — neither blind plan consumed seams both providers declared); 8
UI↔UI edges entered GRAPH.md (route-builder/event/store bindings only, no component imports).

## Owner questions: 84

OWNER-QUESTIONS.md, grouped by node, each with the recommended default; 4 reconcile resolutions
to confirm (sandbox sink; H save-one button; engine at-a-time route; intake `validation`
snapshot). None blocks a build — every plan proceeds on its recorded default.

## Risks (ranked)

1. `sqlite-store` is an infra swap (server + SDK + desktop boot + 18 test areas) — highest blast
   radius; build first, gate hardest.
2. Engine complexity (15 routes, SSE, N-lane scheduling, sandbox driving, model hand-off) — the
   slice's seam risk concentrates here.
3. Sandbox/registry reality is only fully proven against real bwrap + a loopback registry; the
   owner's publish namespace must be confirmed before env images are real.
4. Cross-node shape drift at build time: 167 plan-frozen edges — repair path is scoped
   re-reconciliation, but a drift in the engine's DB seams is the costliest; engine builds first,
   its DB seams are the most-bound contract.
5. Owner-gated facts absent (updater keypair, Pages origin, published stats, warn list, 20 MiB
   bundle rule) — all degrade loudly or silently-off; none blocks the slice.
6. The `study`-literal guard is already red on MAIN (pre-existing `EXTENSIBILITY_STUDY` hits in
   `src-app/libs/viz`); recorded, not fixed by this epic (ui-intake OWNER-1 holds the txr scope).

## Recommended build order — first vertical slice (path 2, one method, Linux)

Wave 1 (parallel): `sqlite-store`, `method-catalogue`, `sandbox-stacked`, `method-env-images`
(`landing-site` anytime; NOT in slice) → Wave 2 (parallel): `file-validator`, `ui-list` →
Wave 3: `execution-engine` → Wave 4 (parallel): `ui-intake`, `ui-results`, `model-store` →
Wave 5: `history-store` (only for the E-screen keep-copies preference) → Wave 6: `ui-run`.
**After `ui-run` lands, A→B→C→E→F→G→H works end to end on one method.** Then
`pretrained-catalogue` (w5) → `ui-models` (w7) → `ui-history` (w8); `installers-release` (w6).
Slice = 12 nodes, ≈62 of ≈82 total worker-sessions (STATUS.md estimates are the reconciler's
judgment — plans carried none — re-baseline after the first two nodes land).
