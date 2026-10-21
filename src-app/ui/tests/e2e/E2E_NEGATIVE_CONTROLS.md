# E2E negative controls & coverage ledger

What the e2e specs in this tree **actually measure**, and — the point of this file — what they
**do not**. An entry lands here when a spec's name or header claims more than the default suite
run proves, so that the gap is a written fact instead of something a future reader has to
re-derive by mutating production code.

Two rules this file exists to enforce:

- A spec that never RUNS in the default suite provides **zero** coverage, however good its
  assertions are. `skipped` is not `passed`.
- A spec whose only failing mode is "the app threw" is a health check, not a behavioural pin.
  Say so in its header rather than letting the section title carry the claim.

---

## UNCOVERED in the default suite

### `14-declarative-qc/multimodal-joint-drop.spec.ts` — env-gated, does NOT run by default

**Status: UNCOVERED by a default `npm run test:e2e`.**

The whole `test.describe` is gated by

```ts
const MULTIMODAL = !!process.env.CYTO_E2E_MULTIMODAL
test.skip(!MULTIMODAL, 'needs the real CITE-seq multimodal seed fixture — set CYTO_E2E_MULTIMODAL=1 to run')
```

so on a normal run the spec is COLLECTED and reported as **skipped**. Its four determinate
assertions — the ones ITEM-39 added precisely because every earlier assertion in the file was a
canvas attribute, a picker state, or `consoleErrors === []` — therefore never execute:

1. `prot:total_counts` with `max = -1` drives the AFTER pane to **0** rows (the joint drop across
   paired modalities);
2. the BEFORE pane stays at `seed.n_cells` (the control that makes it a comparison);
3. a second, permissive criterion on `rna:total_counts` **ANDs** rather than replaces — the AFTER
   pane stays at 0;
4. removing the protein criterion **restores** `seed.n_cells` (the leg that proves the earlier 0
   was the criterion and not a pane stuck at zero).

The gate itself is the right shape (a describe-level `test.skip`, so a run without the fixture
reports the spec and names the env var, rather than an `if (MULTIMODAL) { … }` wrapper that would
vanish silently). This entry is about the consequence, not the gate: **the behaviour the file is
named for is unmeasured on every default run.**

**What would have to be seeded to make it run:**

- `CYTO_E2E_MULTIMODAL=1` in the environment (this is what tier 7 in the root `README.md` already
  exports; outside tier 7 nothing sets it).
- A backend reachable by the spec with the `/_debug/seed` debug seeding surface enabled (the tier
  runs a freshly spawned backend with `CI=1` so the seam is actually present).
- The `modality-split` seed driver on that backend, running the production `multimodal.py` reader
  (`split_by_feature_types` + `modality_prefixed` + `modality_datatype` + `align_barcodes` +
  `detect_isotype_controls`) — this is what `seedMultimodalDataset` in
  `14-declarative-qc/_seed.ts` posts a seed plan against.
- The CITE-seq fixture the driver reads:
  `src-app/ui/tests/e2e/14-declarative-qc/fixtures/multimodal_citeseq.h5ad` — this one is already
  **committed in-repo**, so it is not the blocker; the env var and the debug-seed backend are.

**Not fixed here, deliberately.** Un-skipping it blindly in the default suite would trade a
skipped spec for a failing or flaky one; weakening its assertions to make it run everywhere would
throw away the only determinate measurements the file has. Recorded instead.
