//! Reproducibility readiness checklist (ITEM-21). Each flag is independent and
//! derived from the sidecar run facts + the roots; `ready` is their conjunction.

use crate::modules::provenance::models::ReadinessDto;

/// Per-run reproducibility facts (derived by the graph facade).
#[derive(Debug, Clone, Copy)]
pub struct RunReadiness {
    pub has_seed: bool,
    pub env_pinned: bool,
    pub inputs_checksummed: bool,
    pub code_captured: bool,
    /// **ITEM-4** — the run's SCIENTIFIC params were captured, so a reproduce
    /// capsule can regenerate the `/inputs/params.json` the run actually consumed.
    /// See [`params_captured_flag`].
    pub params_captured: bool,
}

/// **ITEM-4** — the params-fidelity flag: does this run carry the params a capsule
/// needs to replay it *as the science it was*?
///
/// The plan's phrasing ("a run whose processor declares params") is NOT decidable
/// here — `readiness.rs` has no processor-manifest access. The Phase-2 amendment
/// restates it decidably: **a `kind='compute'` run whose `rerun_spec_json` carries
/// no non-empty `params` object**. A compute run that genuinely executed with zero
/// params is then a rare, honest false flag — which is the FAIL-LOUD direction, and
/// exactly the point: a capsule built from a params-less compute run replays the
/// processor on its DEFAULTS and silently produces a different answer, so it must
/// never be reported reproducible-ready.
///
/// Only `kind='compute'` is evaluated. Selection / annotation / group runs record
/// `rerun_spec_json = NULL` **by design** (`interaction.rs`, `dataset/routes.rs`)
/// and MUST keep `ready: true` — a blanket flag would falsely redden every existing
/// interaction run (DEC-9 §5).
///
/// **Effect on PRE-EXISTING runs (intended, per DEC-9 §4):** a compute run recorded
/// before the params were carried reports `params_captured: false` → `ready: false`.
/// There is no backfill migration; that red IS the honest signal, and it is what
/// stops a params-less capsule from claiming reproducibility.
///
/// Pure — the caller supplies the run's stashed spec params (the same
/// `bundle::params_from_rerun` source), mirroring how `env_pinned_flag` takes
/// `obtainable` from the `env_obtain` seam.
pub fn params_captured_flag(kind: &str, rerun_params: Option<&serde_json::Value>) -> bool {
    if kind != "compute" {
        return true; // non-compute runs pin no processor params by design.
    }
    matches!(rerun_params, Some(serde_json::Value::Object(m)) if !m.is_empty())
}

/// **F2-16** — the code-fidelity flag: is the run's captured code actually
/// PRESENT, so a capsule built from it computes something?
///
/// The original flag was `row.code_sha256.is_some()` — a hash, not the blob. A run
/// whose `provenance_code_blobs` row is gone (pruned / never written / a foreign
/// hash) therefore reported `code_captured: true`, and the bundle assembler
/// substituted a `# code blob <sha> not found` COMMENT that the capsule still
/// invoked: `Reproduce capsule complete.` / `EXIT=0` / zero files under
/// `work/00/outputs`. A capsule that exits 0 having computed nothing is the exact
/// failure this module's header warns about.
///
/// **ROUND-4b (R4B-10) — the flag is now KIND-AWARE, closing the last kind-blind
/// arm of the same vacuous-truth family F2-17 already closed twice.**
///
/// The `None` arm used to return `true` unconditionally, on the rationale "a manual
/// / provenance-only node captured no code by design". That rationale is REAL, but
/// it describes a NON-COMPUTE run — and the kind-blind predicate handed the same
/// green flag to a `kind='compute'` run that recorded no code at all. That run's
/// capsule step is rendered by `reproduce_script::render_step` as
/// `no captured code (not executed; manual step)` and returns WITHOUT executing
/// anything — so readiness asserted a capture that never happened, over a step that
/// computes nothing, and folded it into `ready`.
///
/// This is the identical defect [`env_pinned_flag_for_kind`] was written to fix one
/// flag over: there, the `None` arm ("an interaction run pins its emitter version")
/// was ALSO taken by a compute run that never resolved a rootfs, whose step renders
/// `no pinned environment (not executed; provenance-only node)`. Same file, adjacent
/// branches of the same `render_step`, same wrong conclusion for a reader of the
/// checklist. `inputs_checksummed_flag` took `kind` for the same reason.
///
/// So: a compute run EXECUTES code by definition; recording none is a gap, not a
/// design choice. Non-compute runs (selection / annotation / group / promote /
/// interaction) legitimately capture no code and keep their green flag — DEC-9 §5's
/// no-false-reddening rule, and exactly what `export_test.rs`'s byte-less-root
/// fixture relies on when it sets `kind = "selection"` to get "no code by design".
///
/// Unlike [`env_pinned_flag`], NO kind-blind twin survives: R4B-08's lesson was that
/// leaving the obvious name callable lets a third caller reintroduce the bug, so
/// `kind` is a required parameter and every call site is forced to supply it.
///
/// `blob_len` is the byte length of the fetched blob (`None` = no row). Pure — the
/// caller supplies it, mirroring how [`env_pinned_flag`] takes `obtainable`.
pub fn code_captured_flag(
    kind: &str,
    code_sha256: Option<&str>,
    blob_len: Option<usize>,
) -> bool {
    match code_sha256 {
        // A hash is recorded → the blob must be present AND non-empty.
        Some(sha) if !sha.trim().is_empty() => blob_len.is_some_and(|n| n > 0),
        // No hash at all. A compute run executes code, so recording none is a gap:
        // its capsule step is emitted as `not executed` and produces nothing.
        _ => kind != "compute",
    }
}

/// **F2-17** — the input-fidelity flag, without the vacuous-truth hole.
///
/// The producing expression used to be `inputs.iter().all(|i| !i.content_hash
/// .is_empty())` over a `Vec` that a MALFORMED `inputs_json` degrades to
/// `Vec::new()`. Both an input-less run AND a corrupt provenance record therefore
/// answered `true` — i.e. the precise state in which provenance is broken made
/// readiness GREENER than a fully-checksummed run.
///
/// `inputs = None` means the recorded `inputs_json` FAILED TO PARSE (not "no
/// inputs"), and is never a satisfied condition. A `kind='compute'` run always
/// consumes something, so an empty input set is a gap for it too; non-compute
/// (selection / annotation / promote) nodes legitimately have none.
pub fn inputs_checksummed_flag(
    kind: &str,
    inputs: Option<&[crate::modules::provenance::models::UsedEdgeDto]>,
) -> bool {
    let Some(inputs) = inputs else {
        return false; // unparseable provenance is NOT a satisfied condition
    };
    if kind == "compute" && inputs.is_empty() {
        return false; // a compute run consumes something; zero edges is a gap
    }
    inputs.iter().all(|i| !i.content_hash.trim().is_empty())
}

/// **F2-17** — [`env_pinned_flag`] with the run KIND, which is what makes the
/// `None` arm correct.
///
/// `env_pinned_flag(None, version, _)` returns true because a digest-less run is
/// assumed to be an in-app interaction/promote node that pins its emitter version.
/// But `env_rootfs_sha256` is ALSO `None` for a COMPUTE run that never resolved a
/// rootfs, and the capsule renders exactly such a step as `no pinned environment
/// (not executed; provenance-only node)` — i.e. readiness said "ready" for a run
/// whose replay is a silent no-op. A compute run must pin an OBTAINABLE rootfs.
pub fn env_pinned_flag_for_kind(
    kind: &str,
    env_rootfs_sha256: Option<&str>,
    generator_version: &str,
    obtainable: bool,
) -> bool {
    if kind == "compute" {
        // A compute run is only env-pinned with a real, still-obtainable digest.
        return env_rootfs_sha256.is_some_and(|d| !d.trim().is_empty()) && obtainable;
    }
    env_pinned_flag(env_rootfs_sha256, generator_version, obtainable)
}

/// Whether a run's environment is pinned AND obtainable (ITEM-22 / DEC-32). A
/// run that pins a rootfs content digest is only "env-pinned" for reproducibility
/// if that digest is still **obtainable** (present in the digest-keyed rootfs
/// cache / servable) — an archived-away (GC'd) digest flips this false so
/// `readiness.ready` is false BEFORE an export can claim success (TEST-70). A run
/// with no rootfs digest (an in-app interaction / promote node) instead pins the
/// emitter version, so a non-empty `generator_version` suffices.
///
/// Pure — the caller supplies `obtainable` (resolved via the `env_obtain` seam),
/// so this stays unit-testable without a rootfs.
///
/// **Prefer [`env_pinned_flag_for_kind`]** — this kind-blind form treats a COMPUTE
/// run with no rootfs digest as pinned (see F2-17), so it is correct ONLY for a
/// caller that has already excluded `kind == "compute"`. It survives as the
/// non-compute arm OF `env_pinned_flag_for_kind` and has no other caller: ROUND-3
/// (F3-1) moved the in-app graph facade onto the kind-aware form, which is what
/// makes `GET /provenance/graph` and the exported `readiness.json` agree about the
/// same run. Do not re-introduce a direct call.
pub fn env_pinned_flag(
    env_rootfs_sha256: Option<&str>,
    generator_version: &str,
    obtainable: bool,
) -> bool {
    match env_rootfs_sha256 {
        // A rootfs-pinned (compute) run: pinned iff its digest is still obtainable.
        Some(_) => obtainable,
        // An interaction/promote run pins the emitter version, not a rootfs.
        None => !generator_version.is_empty(),
    }
}

/// Fold per-run facts into the project/closure-level checklist.
///
/// **ROUND-4b (R4B-08) — the EMPTY-closure case is handled HERE, in the function,
/// not at its call sites.**
///
/// Round 3 filed the vacuous-truth hole (five `.all()`s over an empty slice are all
/// true, so a closure with no captured run folded to `ready: true` and the export
/// shipped REPRODUCING.md's "passes every condition" over a zip with no runs and no
/// data). Round 4 fixed it in a WRAPPER — `graph::evaluate_closure` — and moved the
/// two known callers onto it, leaving this function `pub` and still vacuous with a
/// unit test that PINNED the defective result. A third caller reintroduces the bug by
/// simply calling the obvious name.
///
/// So the guard lives here now, and `evaluate` is no longer `pub`: the only entry
/// point outside this module is `graph::evaluate_closure`, which delegates. An empty
/// closure has no EVIDENCE for the five run-derived conditions, so reporting them
/// satisfied is the error; reporting them false is what lets both surfaces render a
/// coherent, causal "not ready" (the badge's "⚠ 5 issues", and a gap list with a
/// cause in every line — see `bundle::readiness_gap_lines`). `roots_have_provenance`
/// is NOT run-derived and passes through unchanged.
pub(in crate::modules::provenance) fn evaluate(
    runs: &[RunReadiness],
    roots_have_provenance: bool,
) -> ReadinessDto {
    if runs.is_empty() {
        return ReadinessDto {
            seeds_set: false,
            env_pinned: false,
            inputs_checksummed: false,
            code_captured: false,
            params_captured: false,
            roots_have_provenance,
            ready: false,
        };
    }
    let seeds_set = runs.iter().all(|r| r.has_seed);
    let env_pinned = runs.iter().all(|r| r.env_pinned);
    let inputs_checksummed = runs.iter().all(|r| r.inputs_checksummed);
    let code_captured = runs.iter().all(|r| r.code_captured);
    let params_captured = runs.iter().all(|r| r.params_captured);
    let ready = seeds_set
        && env_pinned
        && inputs_checksummed
        && code_captured
        && params_captured
        && roots_have_provenance;
    ReadinessDto {
        seeds_set,
        env_pinned,
        inputs_checksummed,
        code_captured,
        params_captured,
        roots_have_provenance,
        ready,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> RunReadiness {
        RunReadiness {
            has_seed: true,
            env_pinned: true,
            inputs_checksummed: true,
            code_captured: true,
            params_captured: true,
        }
    }

    /// ROUND-4b / R4B-08 — **this test was REWRITTEN, and the expectation deliberately
    /// FLIPPED.** It is the successor to `an_empty_closure_still_reports_ready_known_
    /// open_defect`, which round 3 wrote to PIN the defect (`assert!(r.ready)`) with the
    /// instruction: "when the real fix lands, this assertion is expected to fail and
    /// must be rewritten, not deleted."
    ///
    /// The fix landed. Round 4 supplied the "distinct empty-closure state rendered by
    /// both surfaces" that round 3 asked for — but it built it in a WRAPPER
    /// (`graph::evaluate_closure`) and left `evaluate` itself `pub` and vacuous, so the
    /// pin still passed and any third caller of the obvious name reintroduced the bug.
    /// Round 4b moved the guard into `evaluate` and narrowed its visibility, which is
    /// precisely the condition round 3 named for rewriting this test.
    ///
    /// The new expectation: an empty closure is NOT ready, and the five RUN-DERIVED
    /// flags are false because there is no evidence for them (leaving them vacuously
    /// true is what rendered the badge's "⚠ 0 issues" and an empty gap list).
    /// `roots_have_provenance` is not run-derived, so it stays honest.
    #[test]
    fn an_empty_closure_is_not_ready_and_has_no_satisfied_run_conditions() {
        let r = evaluate(&[], true);
        assert!(
            !r.ready,
            "a closure with no captured run cannot be 'reproducible' — there is nothing to re-run"
        );
        assert!(
            !r.seeds_set
                && !r.env_pinned
                && !r.inputs_checksummed
                && !r.code_captured
                && !r.params_captured,
            "the five run-derived conditions have no evidence, so none is satisfied"
        );
        assert!(r.roots_have_provenance, "the roots fact is not run-derived and stays honest");
        assert!(!evaluate(&[], false).roots_have_provenance);

        // The non-empty behaviour is untouched.
        assert!(evaluate(&[ok()], true).ready, "one complete run is ready");
    }

    // TEST-12: each gap flags independently; ready only when all pass.
    #[test]
    fn all_pass_is_ready() {
        let r = evaluate(&[ok(), ok()], true);
        assert!(r.ready);
        assert!(r.seeds_set && r.env_pinned && r.inputs_checksummed && r.code_captured);
    }

    #[test]
    fn each_gap_is_independent() {
        let missing_seed = RunReadiness { has_seed: false, ..ok() };
        let r = evaluate(&[missing_seed], true);
        assert!(!r.seeds_set && !r.ready);
        assert!(r.env_pinned && r.inputs_checksummed && r.code_captured, "other flags unaffected");

        let unpinned = RunReadiness { env_pinned: false, ..ok() };
        assert!(!evaluate(&[unpinned], true).env_pinned);

        let unchecksummed = RunReadiness { inputs_checksummed: false, ..ok() };
        assert!(!evaluate(&[unchecksummed], true).inputs_checksummed);

        let uncaptured = RunReadiness { code_captured: false, ..ok() };
        assert!(!evaluate(&[uncaptured], true).code_captured);

        let no_params = RunReadiness { params_captured: false, ..ok() };
        let r = evaluate(&[no_params], true);
        assert!(!r.params_captured && !r.ready);
        assert!(r.seeds_set && r.env_pinned && r.code_captured, "other flags unaffected");

        // A root without provenance fails only that flag + ready.
        let r = evaluate(&[ok()], false);
        assert!(!r.roots_have_provenance && !r.ready);
        assert!(r.seeds_set && r.code_captured);
    }

    // TEST-70 (pure obtainability leg) [ITEM-21/22]: a run that pins a rootfs
    // digest is env-pinned ONLY while that digest is obtainable; a GC'd
    // (unobtainable) digest flips env_pinned false → not ready. A digest-less
    // interaction/promote run pins the emitter version instead.
    #[test]
    fn env_pinned_requires_obtainable_pinned_digest() {
        // Pinned + obtainable → env-pinned.
        assert!(env_pinned_flag(Some("deadbeef"), "1.2.3", true));
        // Pinned but GC'd / unobtainable → NOT env-pinned (the negative case).
        assert!(!env_pinned_flag(Some("deadbeef"), "1.2.3", false));
        // No rootfs digest → the emitter version pins it (obtainable is moot).
        assert!(env_pinned_flag(None, "1.2.3", false));
        assert!(env_pinned_flag(None, "1.2.3", true));
        // No rootfs AND no emitter version → not pinned at all.
        assert!(!env_pinned_flag(None, "", true));

        // Folded into the checklist: an unobtainable env makes the closure not ready.
        let gcd = RunReadiness {
            env_pinned: env_pinned_flag(Some("deadbeef"), "1.2.3", false),
            ..ok()
        };
        let r = evaluate(&[gcd], true);
        assert!(!r.env_pinned && !r.ready, "a GC'd env fails readiness before export");
        assert!(r.seeds_set && r.code_captured && r.inputs_checksummed, "other flags unaffected");
    }

    // TEST-5 [ITEM-4]: the params-fidelity flag, in its DECIDABLE restatement — a
    // `kind='compute'` run whose rerun spec carries no non-empty `params` object is
    // NOT reproducible-ready (fail loud, so a params-less capsule never claims
    // reproducibility); a compute run that DOES carry params is; and non-compute
    // runs are untouched and keep `ready: true` (DEC-9 §5 — no false reddening of
    // every existing interaction run).
    #[test]
    fn params_captured_flags_only_params_less_compute_runs() {
        let real = serde_json::json!({ "criteria": [{ "column": "total_counts", "min": 1500 }] });

        // A compute run carrying real science → captured.
        assert!(params_captured_flag("compute", Some(&real)));

        // A compute run with NO params / an empty object / a non-object / no spec
        // at all → NOT captured (each is a capsule that would replay on defaults).
        assert!(!params_captured_flag("compute", None));
        assert!(!params_captured_flag("compute", Some(&serde_json::json!({}))));
        assert!(!params_captured_flag("compute", Some(&serde_json::Value::Null)));
        assert!(!params_captured_flag("compute", Some(&serde_json::json!("thresholds"))));

        // NON-compute runs record `rerun_spec_json = NULL` by design and MUST stay
        // ready — this is the regression guard on the Phase-2 warning.
        for kind in ["selection", "annotation", "group", "promote", "interaction"] {
            assert!(params_captured_flag(kind, None), "{kind} runs must not be reddened");
            assert!(params_captured_flag(kind, Some(&serde_json::json!({}))));
        }

        // Folded into the checklist: a params-less compute run makes the closure
        // not ready; a project of pre-existing selection runs stays ready.
        let paramless = RunReadiness { params_captured: params_captured_flag("compute", None), ..ok() };
        assert!(!evaluate(&[paramless], true).ready);
        let selection = RunReadiness { params_captured: params_captured_flag("selection", None), ..ok() };
        assert!(evaluate(&[selection, selection], true).ready);
    }

    fn edge(hash: &str) -> crate::modules::provenance::models::UsedEdgeDto {
        crate::modules::provenance::models::UsedEdgeDto {
            slot: "expression".into(),
            kind: "artifact".into(),
            ref_id: None,
            content_hash: hash.into(),
            bound_by: None,
        }
    }

    // F2-16 / F2-17 (LEDGER reproducibility-4/-10/-11): the three readiness holes
    // that reported `ready: true` over provenance that CANNOT reproduce. Each was
    // constructed against this same code by the auditor and answered green.
    #[test]
    fn readiness_is_not_vacuously_true_over_broken_provenance() {
        // (1) code_captured used to mean "a hash is recorded", not "the blob is
        //     there". A GHOST blob yields a capsule that exits 0 computing nothing.
        assert!(code_captured_flag("compute", Some("deadbeef"), Some(120)), "a real blob is captured code");
        assert!(!code_captured_flag("compute", Some("deadbeef"), None), "a MISSING blob is NOT captured code");
        assert!(!code_captured_flag("compute", Some("deadbeef"), Some(0)), "an EMPTY blob is NOT captured code");

        // ROUND-4b (R4B-10): the `None` arm is KIND-AWARE. A non-compute node
        // captured no code BY DESIGN and keeps its green flag (DEC-9 §5 — no false
        // reddening of every existing interaction run)…
        for kind in ["selection", "annotation", "group", "promote", "interaction"] {
            assert!(code_captured_flag(kind, None, None), "{kind} captured no code BY DESIGN");
            assert!(code_captured_flag(kind, None, Some(0)), "{kind} is green regardless of blob evidence");
        }
        // …but a COMPUTE run executes code, so recording NONE is a gap, not a design
        // choice: `render_step` emits that step as `no captured code (not executed;
        // manual step)` and it computes nothing. Reporting `code_captured: true`
        // there asserts a capture that never happened — the same shape as the
        // env_pinned `None` arm F2-17 fixed one flag over.
        assert!(!code_captured_flag("compute", None, None), "a compute run with NO recorded code is a gap");
        assert!(!code_captured_flag("compute", Some("   "), None), "a blank hash on a compute run is a gap");
        // A blank hash on a non-compute run falls through to the by-design arm.
        assert!(code_captured_flag("selection", Some("   "), None));

        // (2) inputs_checksummed was `[].iter().all(..) == true`, and a MALFORMED
        //     inputs_json took the SAME path — corrupt provenance scored greener
        //     than complete provenance.
        assert!(!inputs_checksummed_flag("compute", None), "unparseable inputs_json is NOT satisfied");
        assert!(!inputs_checksummed_flag("compute", Some(&[])), "a compute run with zero used-edges is a gap");
        assert!(!inputs_checksummed_flag("compute", Some(&[edge("sha256:aa"), edge("  ")])), "a blank hash fails");
        assert!(inputs_checksummed_flag("compute", Some(&[edge("sha256:aa")])), "a checksummed input passes");
        // Non-compute nodes legitimately consume nothing (DEC-9 §5 — no false reddening).
        assert!(inputs_checksummed_flag("selection", Some(&[])));
        assert!(!inputs_checksummed_flag("selection", None), "…but corruption still fails");

        // (3) env_pinned_flag(None, version, _) said "pinned" for a COMPUTE run whose
        //     replay the capsule renders as `no pinned environment (not executed)`.
        assert!(!env_pinned_flag_for_kind("compute", None, "1.2.3", true), "unpinned compute is NOT pinned");
        assert!(!env_pinned_flag_for_kind("compute", Some("   "), "1.2.3", true), "a blank digest is not a pin");
        assert!(!env_pinned_flag_for_kind("compute", Some("deadbeef"), "1.2.3", false), "GC'd → not pinned");
        assert!(env_pinned_flag_for_kind("compute", Some("deadbeef"), "1.2.3", true));
        // The interaction/promote arm is unchanged (it pins the emitter version).
        assert!(env_pinned_flag_for_kind("selection", None, "1.2.3", false));
        assert!(!env_pinned_flag_for_kind("selection", None, "", true));

        // Folded: each of the three alone makes the closure NOT ready.
        for broken in [
            RunReadiness { code_captured: code_captured_flag("compute", Some("deadbeef"), None), ..ok() },
            RunReadiness { code_captured: code_captured_flag("compute", None, None), ..ok() },
            RunReadiness { inputs_checksummed: inputs_checksummed_flag("compute", Some(&[])), ..ok() },
            RunReadiness { env_pinned: env_pinned_flag_for_kind("compute", None, "1.0", true), ..ok() },
        ] {
            assert!(!evaluate(&[broken], true).ready, "broken provenance must not be ready");
        }
    }
}
