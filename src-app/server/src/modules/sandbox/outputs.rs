//! The canonical `/outputs/manifest.json` contract — **P3 OWNS this type (A1 /
//! DEC-K)**.
//!
//! One serde-serializable struct. The sandbox analysis job writes it to
//! `/outputs/manifest.json`; P1 (`workstore::ingest`, catalog ingest), P2
//! (datatype typing), and P4 (provenance) IMPORT this type — they never redefine
//! it. Field names (`id`, `datatype`, `path`, `layout`, `role`) are the wire
//! contract and MUST NOT change once published.
//!
//! Every field of an entry except `label`/`axis`/`hidden` is REQUIRED with no serde
//! default (INV-2). `role` was the last exception: it carried `#[serde(default)]`,
//! and `role_or_default` mapped the resulting blank to `artifact` — the PROMOTABLE
//! tier — so a manifest that simply omitted `role` silently produced an artifact the
//! promote gate (`dataset/routes.rs`) would export. That is absence resolving to the
//! MORE privileged of two tiers, which is the one shape INV-2 exists to forbid; it is
//! now a deserialize error, on the same contract `structure`/`meta` took.

use std::path::{Path, PathBuf};

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;
use ziee_core::AppError;

// ─────────────────────── where a run's outputs are staged (ITEM-17) ──────────

/// Root of the per-run OUTPUT STAGING trees: `<data_root>/run-staging/`.
///
/// A SIBLING of the sandbox workspace root (`<data_root>/sandboxes/`), never a
/// subdirectory of a workspace. The two have different lifetimes and that is the
/// whole reason they are different trees:
///
/// * a workspace is scratch — `/home`, `/inputs`, `/code`, the progress FIFO —
///   and dies with the run;
/// * outputs must survive until INGEST has consumed them, which happens after the
///   child has exited and (on a crash) possibly after a restart.
///
/// While they were one tree, anything that reclaimed a workspace also destroyed
/// outputs that were still needed. That was not hypothetical: the boot task runs
/// `reconcile_orphaned_running` — which finalizes a recovered run and dispatches a
/// verification — and then the stale sweep, in the SAME task, so a sweep could
/// delete a live run's bytes out from under it. Separating the trees is what makes
/// "reclaim the workspace" unable to mean "destroy the outputs".
///
/// A sibling of the workspace root (rather than, say, a dir inside it named so the
/// sweep skips it) is deliberate: the per-run dirs under it are UUID-named, so the
/// EXISTING [`crate::modules::jobs::scheduler::sweep_stale_workspaces`] reclaims a
/// crashed run's staging with no second reclamation idiom — the same function, the
/// same live-run register, pointed at a second root.
pub fn staging_root() -> PathBuf {
    crate::modules::rootfs::data_root().join("run-staging")
}

/// One run's output staging dir: `<staging_root>/<job_id>/`.
///
/// Takes the root rather than calling [`staging_root`] so the boot reconcile and
/// the tests can be driven against an explicit pair of roots (the same shape the
/// workspace root already has).
pub fn staging_dir(staging_root: &Path, job_id: Uuid) -> PathBuf {
    staging_root.join(job_id.to_string())
}

/// The host directory bound READ-WRITE at `/outputs` for a run whose staging dir is
/// `staging_dir`. The ONE definition of that subdirectory name: the mkdir, the bind
/// mount, and [`load_produced_outputs`] all go through here, so the sandbox path and
/// the host path cannot drift apart.
pub fn outputs_dir(staging_dir: &Path) -> PathBuf {
    staging_dir.join("outputs")
}

/// Remove a run's output staging tree. Called after a successful ingest, and
/// immediately on every error path that ends the run.
///
/// An already-absent tree is success (cleanup is idempotent — the co-located
/// fixture configuration removes the same dir twice, and the boot sweep may have
/// got there first). Any OTHER failure is logged at `warn` with the path: it leaks
/// disk until the next boot sweep reclaims it, and a silent `let _ =` is how three
/// separate defects on this branch went unnoticed.
pub async fn discard_staging(staging_dir: &Path) {
    match tokio::fs::remove_dir_all(staging_dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!(
            dir = %staging_dir.display(),
            error = %e,
            "output staging cleanup failed; the boot sweep will reclaim it"
        ),
    }
}

/// The whole manifest a run writes at `/outputs/manifest.json`.
///
/// (No `Eq`: `OutputEntry.meta` is a `serde_json::Value`, which is only
/// `PartialEq`, so this transitively cannot be `Eq`.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputsManifest {
    pub outputs: Vec<OutputEntry>,
}

/// One declared output. `path` is relative to `/outputs` (validated to stay
/// under it — no escape). `datatype`/`layout`/`role` come from P2's vocabulary
/// (referenced, not defined here).
///
/// (No `Eq`: `meta` is a `serde_json::Value`, which is only `PartialEq`.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputEntry {
    pub id: String,
    pub datatype: String,
    pub path: String,
    pub layout: String,
    /// Producer-declared: the TIER this output belongs to (DEC-8) —
    /// [`ROLE_ARTIFACT`] = promotable/exportable, [`ROLE_INTERMEDIATE`] = produced
    /// for visualization, not export.
    ///
    /// **Required, with no serde default and no blank fallback (INV-2).** This is
    /// the field `POST /datasets/promote` gates on, so the two tiers are not
    /// symmetric: one of them is more privileged. It used to carry
    /// `#[serde(default)]`, and a blank was mapped to `artifact` — meaning a
    /// manifest that said nothing at all about tier produced an artifact the
    /// promote gate would export. "If absent, assume the privileged value" is the
    /// exact fallback the design forbids, so both spellings of saying nothing are
    /// refused: an OMITTED key fails as `missing field \`role\``, and a present-but-
    /// blank one fails through [`deserialize_declared_role`]. A producer states its
    /// tier, always.
    #[serde(deserialize_with = "deserialize_declared_role")]
    pub role: String,
    /// Optional human-facing label for this output (ITEM-11). Carried into the
    /// artifact `params` bag when present.
    #[serde(default)]
    pub label: Option<String>,
    /// Producer-declared: HOW TO DECODE the bytes this output holds — the array
    /// members, their dtypes, chunk geometry, the axis each dimension binds to.
    /// The server stores and serves it and never interprets it.
    ///
    /// **Required, with no serde default (artifact-model ITEM-5 / INV-2).** A
    /// default here would mean an omitted declaration silently becomes `{}`, and
    /// every reader downstream would have to guess whether that means "nothing to
    /// declare" or "the producer forgot" — which is the exact fallback the design
    /// forbids. A manifest without it fails to deserialize, at ingest, loudly.
    pub structure: serde_json::Value,
    /// Producer-declared: what this output MEANS, for display.
    ///
    /// **Required (ITEM-6 / INV-2)** — it previously carried a serde default and
    /// was folded into the `params` bag; it is now a first-class declaration
    /// alongside `structure`, on the same no-default contract.
    pub meta: serde_json::Value,
    /// ITEM-7: the entity AXIS a `metadata-column` output annotates (an OPEN
    /// string, e.g. `cells`/`genes`/`variants`/`samples`) — one column shape
    /// shared across domains. Absent for non-axis outputs; readers default when
    /// missing, so an existing manifest without it deserializes (back-compat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis: Option<String>,
    /// ITEM-20: hide this output from the catalog listing (a byproduct the user
    /// shouldn't see as a first-class artifact — e.g. the `dataset-metadata` JSON
    /// that is harvested into `datasets.metadata`). Still persisted + fetchable by
    /// id; only filtered from the catalog list. Defaults visible.
    #[serde(default)]
    pub hidden: bool,
}

/// The `artifact` (promotable/export) role (DEC-8) — the tier
/// `POST /datasets/promote` requires.
pub const ROLE_ARTIFACT: &str = "artifact";
/// The `intermediate` (viz/fast-rw, NOT promotable) role (DEC-8).
pub const ROLE_INTERMEDIATE: &str = "intermediate";

/// Deserialize [`OutputEntry::role`], refusing a blank/whitespace-only value.
///
/// Presence alone would not close the INV-2 hole this field had. Dropping
/// `#[serde(default)]` makes an OMITTED `role` an error, but the old
/// `role_or_default` would still have turned a present `""` into `artifact` — so a
/// producer (or a mechanical migration adding `"role": ""` to satisfy the new
/// requirement) would land back on the privileged tier having declared nothing. An
/// empty string is not one of the two tiers; it is the absence of a tier wearing a
/// present key, and it is refused the same way.
///
/// The message names `role` because that is what makes a refusal ATTRIBUTABLE:
/// `BAD_MANIFEST` / `OUTPUTS_MANIFEST_INVALID` is the shared code for every manifest
/// defect, and serde does not prefix a `deserialize_with` failure with the field it
/// was deserializing. This mirrors `parse_manifest`'s existing empty-`id` refusal.
fn deserialize_declared_role<'de, D>(de: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(de)?;
    if raw.trim().is_empty() {
        return Err(D::Error::custom(format!(
            "blank field `role`: an output must DECLARE its tier \
             (`{ROLE_ARTIFACT}` = promotable/exportable, `{ROLE_INTERMEDIATE}` = \
             produced for visualization, not export) — a blank role is not a declaration"
        )));
    }
    Ok(raw)
}

/// Caps on a manifest (defense against a runaway/hostile script). A manifest
/// exceeding these on exit-0 is a contract violation → the job fails.
pub const MAX_OUTPUTS: usize = 512;
/// Max serialized manifest size read from disk (1 MiB — a manifest is metadata,
/// not data).
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// A parsed + validated output whose `path` has been resolved to an absolute
/// host path under `<output_dir>` (handed to the ingest sink).
///
/// (No `Eq`: `meta` is a `serde_json::Value`, which is only `PartialEq`.)
#[derive(Debug, Clone, PartialEq)]
pub struct ProducedOutput {
    pub id: String,
    pub datatype: String,
    /// The declared `/outputs`-relative path (as written to the catalog).
    pub rel_path: String,
    pub layout: String,
    /// The DECLARED tier (DEC-8), carried verbatim from `OutputEntry.role`. Never
    /// blank — the manifest contract refuses both an omitted and a blank `role`
    /// (INV-2), so there is no "effective role" to derive and no default to apply:
    /// the value here is the producer's, and the promote gate reads exactly it.
    pub role: String,
    /// Optional human-facing label (ITEM-11), carried verbatim from
    /// `OutputEntry.label`.
    pub label: Option<String>,
    /// Free-form per-output metadata (ITEM-11), carried verbatim from
    /// `OutputEntry.meta`. REQUIRED on the wire (ITEM-6 / INV-2), so "nothing to
    /// say" arrives as an explicit `null` — never as an omission.
    pub meta: serde_json::Value,
    /// ITEM-20: hide this artifact from the catalog listing, carried verbatim from
    /// `OutputEntry.hidden` (default visible).
    pub hidden: bool,
    /// Absolute host path (`<output_dir>/<rel_path>`), guaranteed under the dir.
    pub host_path: PathBuf,
}

fn violation(msg: impl Into<String>) -> AppError {
    AppError::bad_request("OUTPUTS_MANIFEST_INVALID", msg.into())
}

/// Deserialize + structurally validate a manifest (no filesystem access) — pure,
/// unit-testable. Rejects: >[`MAX_OUTPUTS`] entries; an empty `id`; a `path`
/// that is absolute or contains a `..`/`.` component or is empty (escape guard).
pub fn parse_manifest(bytes: &[u8]) -> Result<OutputsManifest, AppError> {
    let manifest: OutputsManifest = serde_json::from_slice(bytes)
        .map_err(|e| violation(format!("malformed outputs manifest: {e}")))?;
    if manifest.outputs.len() > MAX_OUTPUTS {
        return Err(violation(format!(
            "manifest declares {} outputs (max {MAX_OUTPUTS})",
            manifest.outputs.len()
        )));
    }
    for entry in &manifest.outputs {
        if entry.id.trim().is_empty() {
            return Err(violation("an output entry has an empty id"));
        }
        validate_rel_path(&entry.path)?;
    }
    Ok(manifest)
}

/// A `/outputs`-relative path must be non-empty, relative, and free of `..`/`.`
/// / absolute / drive-prefix components (no escape out of `/outputs`).
fn validate_rel_path(rel: &str) -> Result<(), AppError> {
    if rel.trim().is_empty() {
        return Err(violation("an output entry has an empty path"));
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(violation(format!("output path {rel:?} must be relative to /outputs")));
    }
    use std::path::Component;
    for comp in p.components() {
        match comp {
            Component::Normal(_) => {}
            // ParentDir / RootDir / Prefix / CurDir are all escape/oddity vectors.
            _ => {
                return Err(violation(format!(
                    "output path {rel:?} may not contain '.', '..', or an absolute/prefix component"
                )));
            }
        }
    }
    Ok(())
}

/// Read `<staging_dir>/outputs/manifest.json`, validate it, and resolve each
/// entry's `path` to an absolute host path confined under `<staging_dir>/outputs`.
/// Missing/oversize/invalid manifest = a contract violation error (the caller
/// fails the job). Undeclared files under `/outputs` are ignored.
///
/// `staging_dir` is the run's OUTPUT STAGING dir ([`staging_dir`]) — outside the
/// sandbox workspace (ITEM-17), so reclaiming the workspace cannot take the
/// outputs with it.
pub async fn load_produced_outputs(staging_dir: &Path) -> Result<Vec<ProducedOutput>, AppError> {
    let output_dir = outputs_dir(staging_dir);
    let manifest_path = output_dir.join("manifest.json");

    let meta = tokio::fs::metadata(&manifest_path).await.map_err(|e| {
        violation(format!(
            "no outputs manifest at {} (a completed analysis MUST write one): {e}",
            manifest_path.display()
        ))
    })?;
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(violation(format!(
            "outputs manifest is {} bytes (max {MAX_MANIFEST_BYTES})",
            meta.len()
        )));
    }
    let bytes = tokio::fs::read(&manifest_path)
        .await
        .map_err(|e| violation(format!("read outputs manifest failed: {e}")))?;
    let manifest = parse_manifest(&bytes)?;

    // Canonicalize the output dir ONCE so the per-entry containment check
    // compares canonical prefixes (defeats a symlink inside /outputs).
    let canon_dir = tokio::fs::canonicalize(&output_dir)
        .await
        .map_err(|e| violation(format!("canonicalize /outputs failed: {e}")))?;

    let mut out = Vec::with_capacity(manifest.outputs.len());
    for entry in manifest.outputs {
        let host_path = output_dir.join(&entry.path);
        // The declared file must exist and, after canonicalization, stay under
        // the canonical output dir (belt-and-braces with `validate_rel_path`).
        let canon = tokio::fs::canonicalize(&host_path).await.map_err(|e| {
            violation(format!("declared output {:?} not found under /outputs: {e}", entry.path))
        })?;
        if !canon.starts_with(&canon_dir) {
            return Err(violation(format!(
                "declared output {:?} resolves outside /outputs (escape attempt)",
                entry.path
            )));
        }
        out.push(ProducedOutput {
            id: entry.id,
            datatype: entry.datatype,
            rel_path: entry.path,
            layout: entry.layout,
            role: entry.role,
            label: entry.label,
            meta: entry.meta,
            hidden: entry.hidden,
            host_path: canon,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A COMPLETE, otherwise-valid one-entry manifest carrying the given `id` and
    /// `path`, as raw JSON.
    ///
    /// **Every required field is present, and that is load-bearing.** `structure`,
    /// `meta` and `role` carry NO serde default (ITEM-5/ITEM-6, INV-2), so an entry
    /// that omits any of them is rejected by SERDE — with the same
    /// `OUTPUTS_MANIFEST_INVALID` code [`validate_rel_path`] raises. A "rejects an
    /// escape" assertion written over a hand-typed short literal therefore holds
    /// whether or not the guard exists, which is what happened here: with
    /// `validate_rel_path`'s body replaced by `Ok(())` the previous form of
    /// `parse_accepts_valid_and_rejects_escapes` still passed, so the path guard had
    /// no test at all.
    ///
    /// Deriving every reject case from ONE fixture that differs in exactly the
    /// field under test — and asserting on the MESSAGE, since the error code is
    /// shared by every manifest violation and can never discriminate — is what
    /// makes a rejection attributable to the guard.
    ///
    /// (`role` was `""` here until it became a required, non-blank declaration. A
    /// blank was the same fixture bug in miniature: it parsed, and it resolved to
    /// the PROMOTABLE tier.)
    fn manifest_with(id: &str, path: &str) -> Vec<u8> {
        serde_json::to_vec(&complete_entry_json(id, path)).unwrap()
    }

    /// The one complete entry every fixture in this module is derived from, as a
    /// `Value` so a test can remove or replace exactly one key.
    fn complete_entry_json(id: &str, path: &str) -> serde_json::Value {
        serde_json::json!({
            "outputs": [{
                "id": id,
                "datatype": "d",
                "path": path,
                "layout": "file",
                "role": ROLE_ARTIFACT,
                "structure": { "encoding": "opaque" },
                "meta": {},
            }]
        })
    }

    fn sample_json() -> Vec<u8> {
        serde_json::to_vec(&OutputsManifest {
            outputs: vec![OutputEntry {
                id: "embedding".into(),
                datatype: "embedding".into(),
                path: "umap.zarr".into(),
                layout: "zarr".into(),
                role: "primary".into(),
                label: None,
                structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
                meta: serde_json::Value::Null,
                axis: None,
                hidden: false,
            }],
        })
        .unwrap()
    }

    // TEST-6: parse accepts a valid manifest; rejects escapes, empties, oversize.
    #[test]
    fn parse_accepts_valid_and_rejects_escapes() {
        let m = parse_manifest(&sample_json()).expect("valid manifest parses");
        assert_eq!(m.outputs.len(), 1);
        assert_eq!(m.outputs[0].id, "embedding");

        // POSITIVE CONTROL — the reject fixture itself parses. Every rejection
        // below is this manifest with ONE field changed, so the rejection is
        // attributable to that field and to nothing else.
        parse_manifest(&manifest_with("x", "nested/dir/data.zarr"))
            .expect("the reject fixture must be otherwise valid, or the rejects prove nothing");

        // Escapes + path oddities. `Component::{ParentDir, RootDir, Prefix,
        // CurDir}` are all non-`Normal`, so the guard's catch-all arm covers a
        // Windows drive prefix too (untestable on unix, where `C:\x` is one
        // ordinary component and `is_absolute()` is false).
        for bad in [
            "/etc/passwd",        // absolute
            "/",                  // bare root
            "..",                 // bare parent
            "../secret",          // leading traversal
            "a/../../etc/passwd", // interior traversal
            "a/..",               // trailing traversal
            ".",                  // bare current-dir
            "./a",                // leading current-dir component
            "",                   // empty
            "   ",                // whitespace-only
        ] {
            let err = match parse_manifest(&manifest_with("x", bad)) {
                Ok(_) => panic!("path {bad:?} was ACCEPTED — the escape guard did not fire"),
                Err(e) => e,
            };
            assert_eq!(err.error_code(), "OUTPUTS_MANIFEST_INVALID", "path {bad:?}");
            let msg = err.to_string();
            assert!(
                !msg.contains("missing field"),
                "path {bad:?} was rejected by SERDE, not by validate_rel_path — the \
                 path guard is untested: {msg}"
            );
            assert!(
                msg.contains("path"),
                "path {bad:?} was rejected for some unrelated reason: {msg}"
            );
        }

        // BOUNDARY, documented rather than accidental: `Path::components()`
        // normalizes an INTERIOR `.` away (`a/./b` yields `[a, b]`), so this
        // parses — and the path it names is still confined under /outputs. A
        // LEADING `./` is NOT normalized and is rejected above.
        parse_manifest(&manifest_with("x", "a/./b"))
            .expect("an interior '.' normalizes to a confined path");

        // An empty / whitespace id, on the same positive control: only the id
        // differs from the fixture that parsed.
        for bad_id in ["", "   "] {
            let err = parse_manifest(&manifest_with(bad_id, "ok.zarr")).unwrap_err();
            assert_eq!(err.error_code(), "OUTPUTS_MANIFEST_INVALID");
            let msg = err.to_string();
            assert!(!msg.contains("missing field"), "id {bad_id:?}: {msg}");
            assert!(
                msg.contains("id"),
                "id {bad_id:?} rejected for another reason: {msg}"
            );
        }

        // Malformed JSON is the one case that SHOULD be a serde rejection.
        let err = parse_manifest(b"not json").unwrap_err();
        assert_eq!(err.error_code(), "OUTPUTS_MANIFEST_INVALID");
        assert!(err.to_string().contains("malformed"), "{err}");

        // And the required-field contract itself (ITEM-5/ITEM-6, INV-2), DERIVED
        // rather than listed: every key of the complete entry is removed in turn, and
        // each removal must be refused by SERDE naming that key. The set is not typed
        // out, because a list is only ever correct for the fields someone remembered —
        // `role` sat outside the old `["structure","meta"]` list for exactly as long as
        // it carried a default, and the list could not see it.
        let base = complete_entry_json("x", "a.zarr");
        let keys: Vec<String> = base["outputs"][0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert!(!keys.is_empty(), "the fixture has no fields to probe");
        for key in &keys {
            let mut v = base.clone();
            v["outputs"][0].as_object_mut().unwrap().remove(key);
            let err = match parse_manifest(&serde_json::to_vec(&v).unwrap()) {
                Err(e) => e,
                Ok(_) => panic!(
                    "a manifest entry omitting `{key}` was ACCEPTED. Every field of a \
                     complete entry is a producer DECLARATION and carries no serde \
                     default (INV-2): if this one is now genuinely optional, say so \
                     here and say why absence cannot resolve to a privileged value."
                ),
            };
            assert!(
                err.to_string().contains(&format!("missing field `{key}`")),
                "omitting `{key}` must be refused BY THAT FIELD — a rejection naming \
                 something else means the fixture is broken in a second way and this \
                 probe proves nothing: {err}"
            );
        }
    }

    // TEST-13 — **INVERTED** (INV-2). This slot held `role_parses_defaults_and_effective`,
    // which asserted that an entry omitting `role` parsed, landed blank on the wire, and
    // resolved through `effective_role` to `artifact`. It PASSED, and what it certified is
    // what INV-2 forbids: *absence is an error; "if absent, assume X" is not allowed* — and
    // the X it assumed was the PROMOTABLE tier, so a manifest that said nothing about tier
    // produced an artifact `POST /datasets/promote` would export. A test asserting the
    // defect is replaced rather than deleted quietly.
    //
    // What replaces it is the contract that closed it: BOTH ways of declaring no tier are
    // refused, each naming `role`, and an explicitly declared tier still rides through
    // verbatim (the emptiness/discrimination control — the refusals below must be about
    // saying nothing, not about `role` being unwritable).
    #[test]
    fn role_must_be_declared_and_is_never_defaulted() {
        // POSITIVE CONTROL: both tiers, explicitly declared, parse and survive verbatim.
        let m = parse_manifest(
            br#"{"outputs":[
                {"id":"a","datatype":"expression","path":"a.zarr","layout":"zarr","role":"artifact","structure":{},"meta":{}},
                {"id":"b","datatype":"qc-density","path":"b.png","layout":"file","role":"intermediate","structure":{},"meta":{}}
            ]}"#,
        )
        .expect("explicitly declared tiers parse");
        assert_eq!(m.outputs[0].role, ROLE_ARTIFACT);
        assert_eq!(m.outputs[1].role, ROLE_INTERMEDIATE);

        // OMITTED — refused by serde, naming the field. (Also covered by the derived
        // probe in `parse_accepts_valid_and_rejects_escapes`; stated here too because
        // this is the case with a privileged wrong answer, and it deserves to fail a
        // test whose name says so.)
        let mut absent = complete_entry_json("x", "a.zarr");
        absent["outputs"][0].as_object_mut().unwrap().remove("role");
        let err = parse_manifest(&serde_json::to_vec(&absent).unwrap())
            .expect_err("an entry declaring no tier must not deserialize");
        assert!(
            err.to_string().contains("missing field `role`"),
            "an omitted `role` must be refused BY `role`, not resolved to the \
             promotable tier: {err}"
        );

        // BLANK — refused too. Presence alone would not have closed this: `""` is not
        // one of the two tiers, and mapping it to `artifact` is the same "absence ⇒
        // privileged" rule with an extra step. Whitespace-only is the same claim.
        for blank in ["", "   ", "\t"] {
            let mut v = complete_entry_json("x", "a.zarr");
            v["outputs"][0]["role"] = serde_json::json!(blank);
            let err = match parse_manifest(&serde_json::to_vec(&v).unwrap()) {
                Err(e) => e,
                Ok(m) => panic!(
                    "role {blank:?} was ACCEPTED as {:?}. A blank role is not a tier; \
                     accepting it re-opens the privileged default by another route.",
                    m.outputs[0].role
                ),
            };
            assert_eq!(
                err.error_code(),
                "OUTPUTS_MANIFEST_INVALID",
                "role {blank:?}"
            );
            assert!(
                err.to_string().contains("`role`"),
                "role {blank:?} was rejected without naming `role`, so the refusal is \
                 not attributable to this field: {err}"
            );
        }
    }

    // ITEM-7: an `axis` tag parses when present and defaults to `None` when a
    // manifest omits it (back-compat with every existing manifest); it also
    // round-trips through serialize (present ⇒ emitted, absent ⇒ omitted).
    #[test]
    fn axis_parses_present_and_absent() {
        let m = parse_manifest(
            br#"{"outputs":[
                {"id":"cells","datatype":"metadata-column","path":"c.parquet","layout":"file","role":"artifact","axis":"cells","structure":{},"meta":{}},
                {"id":"plain","datatype":"x","path":"p","layout":"file","role":"artifact","structure":{},"meta":{}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(m.outputs[0].axis.as_deref(), Some("cells"));
        assert_eq!(m.outputs[1].axis, None, "absent axis defaults to None (back-compat)");

        // Present axis is emitted on the wire; absent is omitted (skip_serializing_if).
        let s0 = serde_json::to_value(&m.outputs[0]).unwrap();
        assert_eq!(s0.get("axis").and_then(|v| v.as_str()), Some("cells"));
        let s1 = serde_json::to_value(&m.outputs[1]).unwrap();
        assert!(s1.get("axis").is_none(), "omitted axis is not serialized");
    }

    // TEST-13 (flow-through leg): the role rides `load_produced_outputs` into
    // `ProducedOutput` verbatim (real fs path), so the ingest/scope-gen side reads
    // the run-declared role.
    #[tokio::test]
    async fn role_flows_into_produced_output() {
        // A run's STAGING dir (ITEM-17) — `load_produced_outputs` reads
        // `<staging>/outputs`, which is why this fixture builds that shape.
        let ws = std::env::temp_dir().join(format!("cyto-roles-{}", uuid::Uuid::new_v4()));
        let out_dir = outputs_dir(&ws);
        tokio::fs::create_dir_all(&out_dir).await.unwrap();
        tokio::fs::write(out_dir.join("expr.zarr"), b"expr").await.unwrap();
        tokio::fs::write(out_dir.join("dens.png"), b"png").await.unwrap();
        tokio::fs::write(out_dir.join("meta.parquet"), b"pq").await.unwrap();
        let manifest = br#"{"outputs":[
            {"id":"expr","datatype":"expression","path":"expr.zarr","layout":"file","role":"artifact","label":"Expression matrix","structure":{},"meta":{"n_obs":42}},
            {"id":"dens","datatype":"qc-density","path":"dens.png","layout":"file","role":"intermediate","structure":{},"meta":null},
            {"id":"meta","datatype":"metadata-column","path":"meta.parquet","layout":"file","role":"artifact","structure":{},"meta":{}}
        ]}"#;
        tokio::fs::write(out_dir.join("manifest.json"), manifest).await.unwrap();

        let produced = load_produced_outputs(&ws).await.unwrap();
        let by_id = |id: &str| produced.iter().find(|p| p.id == id).unwrap().clone();
        assert_eq!(by_id("expr").role, "artifact");
        assert_eq!(by_id("dens").role, "intermediate");
        assert_eq!(
            by_id("meta").role,
            ROLE_ARTIFACT,
            "the DECLARED tier rides through verbatim — there is no effective-role \
             derivation left, because a blank/absent role never gets this far"
        );

        // ITEM-11: label + meta ride the manifest into ProducedOutput verbatim. An
        // entry that omits the OPTIONAL label lands with `label: None`; `meta` is
        // required (ITEM-6 / INV-2) and cannot be omitted, so the "nothing to say"
        // case is an EXPLICIT `null` — declared absence, not inferred absence.
        assert_eq!(by_id("expr").label.as_deref(), Some("Expression matrix"));
        assert_eq!(by_id("expr").meta, serde_json::json!({"n_obs": 42}));
        assert_eq!(by_id("dens").label, None, "omitted label stays None");
        assert!(by_id("dens").meta.is_null(), "an explicit null meta rides through as null");

        let _ = tokio::fs::remove_dir_all(&ws).await;
    }

    #[test]
    fn parse_rejects_too_many_outputs() {
        let entries = |n: usize| -> Vec<OutputEntry> {
            (0..n)
                .map(|i| OutputEntry {
                    id: format!("o{i}"),
                    datatype: "d".into(),
                    path: format!("f{i}"),
                    layout: "file".into(),
                    role: ROLE_ARTIFACT.into(),
                    label: None,
                    structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
                    meta: serde_json::Value::Null,
                    axis: None,
                    hidden: false,
                })
                .collect()
        };
        let encode = |n: usize| serde_json::to_vec(&OutputsManifest { outputs: entries(n) }).unwrap();

        // POSITIVE CONTROL at the boundary: exactly MAX_OUTPUTS parses, so the
        // rejection below is attributable to the CAP and not to some other
        // property of a 513-entry fixture. (These entries are built as STRUCT
        // literals, so unlike a hand-typed JSON literal they cannot silently start
        // failing on a newly-required field — they stop COMPILING instead.)
        parse_manifest(&encode(MAX_OUTPUTS)).expect("exactly MAX_OUTPUTS is allowed");

        let err = parse_manifest(&encode(MAX_OUTPUTS + 1)).unwrap_err();
        assert_eq!(err.error_code(), "OUTPUTS_MANIFEST_INVALID");
        assert!(
            err.to_string().contains(&format!("max {MAX_OUTPUTS}")),
            "over-cap manifest must be rejected BY THE CAP: {err}"
        );
    }

    // TEST-7: cross-consumer contract — the REAL P1 consumer
    // (`workstore::ingest::OutputsManifest`) is now a re-export of THIS type, so
    // deserializing into it exercises the single A1 definition end-to-end. A field
    // rename here would break P1's compile, and this test asserts the wire shape
    // (incl. `role` REQUIRED, no default) that P1 reads.
    #[test]
    fn cross_consumer_roundtrip_matches_p1_import() {
        // The path P1 (workstore ingest) uses to deserialize a run's manifest.
        use crate::modules::workstore::ingest::OutputsManifest as P1Manifest;

        let json = r#"{"outputs":[
            {"id":"a","datatype":"expression","path":"x.zarr","layout":"zarr","role":"primary","structure":{"encoding":"opaque"},"meta":{}},
            {"id":"b","datatype":"embedding","path":"y.zarr","layout":"zarr","role":"intermediate","structure":{"encoding":"opaque"},"meta":{}}
        ]}"#;
        // P3 parses it. Both entries DECLARE a tier: `role` is required with no
        // default (INV-2), so there is no omitted-role case to carry across the
        // consumer boundary any more — what crosses it is the producer's own value.
        let p3 = parse_manifest(json.as_bytes()).unwrap();
        assert_eq!(p3.outputs[1].role, ROLE_INTERMEDIATE);
        // Re-serialize P3 → deserialize into the REAL P1 consumer type.
        let bytes = serde_json::to_vec(&p3).unwrap();
        let p1: P1Manifest = serde_json::from_slice(&bytes).expect("P1 deserializes P3 output");
        assert_eq!(p1.outputs.len(), 2);
        assert_eq!(p1.outputs[0].id, "a");
        assert_eq!(p1.outputs[0].role, "primary");
        assert_eq!(
            p1.outputs[1].role, ROLE_INTERMEDIATE,
            "the declared tier flows through the P1 import verbatim"
        );
        // The imported type IS this type (single source) — a compile-level guard.
        let _assert_same: OutputsManifest = p1;
    }
}
