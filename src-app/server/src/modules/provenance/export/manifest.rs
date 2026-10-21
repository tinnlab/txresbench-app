//! RO-Crate-shaped `manifest.json` (ITEM-20). Phase-1 bespoke JSON whose fields
//! map 1:1 onto WRROC `CreateAction`/`FormalParameter` (a per-step CreateAction,
//! params as FormalParameter, PROV the model). The full `ro-crate-metadata.json`
//! upgrade is DESCOPED (phase-2).

use serde_json::{json, Value};
use uuid::Uuid;

/// A run node projected for the manifest.
#[derive(Debug, Clone)]
pub struct ManifestRun {
    pub run_id: Uuid,
    pub kind: String,
    pub generator_id: String,
    pub params: Value,
    pub input_hashes: Vec<String>,
    pub output_hashes: Vec<String>,
}

/// A root (source/reference) node projected for the manifest.
#[derive(Debug, Clone)]
pub struct ManifestRoot {
    pub content_hash: String,
    pub datatype: String,
}

/// A reproducibility-verification claim folded into the manifest (ITEM-14). One
/// per verified run in the export scope.
#[derive(Debug, Clone)]
pub struct ManifestVerification {
    pub run_id: Uuid,
    pub status: String,
    pub tolerance_mode: String,
    pub rootfs_digest: Option<String>,
    pub verified_at: Option<String>,
    /// The one-line honest human claim (from `verify::certificate::claim_line`).
    pub claim: String,
}

/// The bundle-relative `data/` path for a content hash — the bare-hex name the
/// zip members + `reproduce_script`/`inputs.json` use (NO `sha256:` prefix), so
/// a manifest data reference resolves to a real bundle file.
fn data_ref(content_hash: &str) -> String {
    format!("data/{}", content_hash.strip_prefix("sha256:").unwrap_or(content_hash))
}

/// Build the phase-1 RO-Crate-shaped manifest, folding in any reproducibility
/// verification claims (ITEM-14) as WRROC `ControlAction` assertions.
pub fn build_manifest(
    runs: &[ManifestRun],
    roots: &[ManifestRoot],
    verifications: &[ManifestVerification],
) -> Value {
    let mut graph: Vec<Value> = Vec::new();

    // Metadata descriptor (RO-Crate root entity).
    graph.push(json!({
        "@id": "ro-crate-metadata.json",
        "@type": "CreativeWork",
        "conformsTo": { "@id": "https://w3id.org/ro/crate/1.1" },
        "about": { "@id": "./" },
    }));

    // Root data entities.
    for r in roots {
        graph.push(json!({
            "@id": data_ref(&r.content_hash),
            "@type": "File",
            "encodingFormat": r.datatype,
            "sha256": r.content_hash,
        }));
    }

    // One CreateAction per run node; params as FormalParameter entities.
    for run in runs {
        let params_fp: Vec<Value> = params_as_formal_parameters(run.run_id, &run.params);
        let object_refs: Vec<Value> = run
            .input_hashes
            .iter()
            .map(|h| json!({ "@id": data_ref(h) }))
            .chain(params_fp.iter().map(|fp| json!({ "@id": fp["@id"].clone() })))
            .collect();
        let result_refs: Vec<Value> = run
            .output_hashes
            .iter()
            .map(|h| json!({ "@id": data_ref(h) }))
            .collect();

        graph.push(json!({
            "@id": format!("#run-{}", run.run_id),
            "@type": "CreateAction",
            "name": run.kind,
            "instrument": { "@id": format!("#tool-{}", run.generator_id) },
            "object": object_refs,
            "result": result_refs,
        }));
        // Emit the FormalParameter entities the CreateAction references.
        for fp in params_fp {
            graph.push(fp);
        }
    }

    // Reproducibility-verification assertions (ITEM-14): a WRROC `ControlAction`
    // per verified run, honestly reporting the terminal status against the pinned
    // rootfs. `actionStatus` maps reproduced→Completed, else Failed (schema.org
    // has no partial status — the human `description` carries the honest nuance).
    for v in verifications {
        let action_status = if v.status == "reproduced" {
            "CompletedActionStatus"
        } else {
            "FailedActionStatus"
        };
        graph.push(json!({
            "@id": format!("#verification-{}", v.run_id),
            "@type": "ControlAction",
            "name": "reproducibility-verification",
            "object": { "@id": format!("#run-{}", v.run_id) },
            "actionStatus": action_status,
            "verificationStatus": v.status,
            "toleranceMode": v.tolerance_mode,
            "environment": v.rootfs_digest,
            "endTime": v.verified_at,
            "description": v.claim,
        }));
    }

    json!({
        "@context": "https://w3id.org/ro/crate/1.1/context",
        "@graph": graph,
    })
}

/// Runtime metadata that is never a scientific parameter (DEC-1/DEC-9 §2). The
/// caller (`bundle::science_params`) already resolves the promoted-column-then-
/// re-run-spec source and strips these; the filter here is the belt to that
/// braces, so no source can leak runtime metadata into the crate AS science.
const NON_SCIENTIFIC_PARAM_KEYS: [&str; 2] = ["language", "arch"];

/// Render a run's SCIENTIFIC params object as `FormalParameter` entities (WRROC
/// shape) — **ITEM-7**: this is where an exported crate documents what a filter run
/// was actually filtered on (the column, the comparator, the threshold), so a
/// reviewer reading the bundle out of the app can see the predicate.
fn params_as_formal_parameters(run_id: Uuid, params: &Value) -> Vec<Value> {
    let Some(obj) = params.as_object() else {
        return Vec::new();
    };
    obj.iter()
        .filter(|(k, _)| !NON_SCIENTIFIC_PARAM_KEYS.contains(&k.as_str()))
        .map(|(k, v)| {
            json!({
                "@id": format!("#param-{run_id}-{k}"),
                "@type": "FormalParameter",
                "name": k,
                "defaultValue": v,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-11: one CreateAction per run node with FormalParameter-shaped params
    // and root/output references (fields map 1:1 onto WRROC).
    #[test]
    fn manifest_emits_createaction_per_run() {
        let run_id = Uuid::new_v4();
        let runs = vec![ManifestRun {
            run_id,
            kind: "selection.column".into(),
            generator_id: "provenance.selection".into(),
            params: serde_json::json!({ "col": "leiden", "op": "==" }),
            input_hashes: vec!["sha256:root".into()],
            output_hashes: vec!["sha256:sel".into()],
        }];
        let roots = vec![ManifestRoot { content_hash: "sha256:root".into(), datatype: "single-cell/expression".into() }];

        let m = build_manifest(&runs, &roots, &[]);
        let graph = m["@graph"].as_array().expect("@graph array");

        let create_actions: Vec<&Value> =
            graph.iter().filter(|e| e["@type"] == "CreateAction").collect();
        assert_eq!(create_actions.len(), 1, "one CreateAction per run node");
        let ca = create_actions[0];
        assert_eq!(ca["name"], "selection.column");
        assert!(ca["result"][0]["@id"] == "data/sel", "output referenced by bare-hex data name");
        assert!(ca["object"].as_array().unwrap().iter().any(|o| o["@id"] == "data/root"), "root referenced by bare-hex data name");

        let fps: Vec<&Value> =
            graph.iter().filter(|e| e["@type"] == "FormalParameter").collect();
        assert_eq!(fps.len(), 2, "each param becomes a FormalParameter");
        assert!(fps.iter().any(|fp| fp["name"] == "col"));

        // Without a verification claim there is no ControlAction.
        assert!(!graph.iter().any(|e| e["@type"] == "ControlAction"), "no claim → no ControlAction");
    }

    // TEST-11 [ITEM-7]: an exported crate documents WHAT WAS FILTERED ON — every
    // SCIENTIFIC param of a `cell.filter` run becomes a `FormalParameter` the run's
    // CreateAction references, while the runtime metadata (`language`/`arch`) that a
    // pre-promotion run's column carries is never emitted as though it were science.
    #[test]
    fn formal_parameters_carry_the_science_never_runtime_metadata() {
        let run_id = Uuid::new_v4();
        let runs = vec![ManifestRun {
            run_id,
            kind: "compute".into(),
            generator_id: "cell.filter".into(),
            // What `bundle::science_params` resolves for a filter run, PLUS the two
            // runtime keys a legacy column would drag in (the belt-and-braces case).
            params: serde_json::json!({
                "criteria": [{ "column": "pct_counts_mito", "max": 10 }],
                "label": "lowqc",
                "seed": 7,
                "language": "python",
                "arch": "x86_64",
            }),
            input_hashes: vec!["sha256:root".into()],
            output_hashes: vec!["sha256:mask".into()],
        }];

        let m = build_manifest(&runs, &[], &[]);
        let graph = m["@graph"].as_array().expect("@graph array");
        let fps: Vec<&Value> = graph.iter().filter(|e| e["@type"] == "FormalParameter").collect();
        let names: Vec<&str> = fps.iter().filter_map(|fp| fp["name"].as_str()).collect();

        assert!(names.contains(&"criteria"), "the predicate is documented as a FormalParameter");
        assert!(names.contains(&"label"), "the committed mask label is documented");
        assert!(names.contains(&"seed"), "the seed IS a scientific parameter (DEC-1)");
        assert!(!names.contains(&"language"), "`language` is runtime metadata, not science");
        assert!(!names.contains(&"arch"), "`arch` is runtime metadata, not science");

        // The filtered column + threshold are literally present in the crate.
        let criteria_fp = fps.iter().find(|fp| fp["name"] == "criteria").expect("criteria param");
        assert_eq!(criteria_fp["defaultValue"][0]["column"], "pct_counts_mito");
        assert_eq!(criteria_fp["defaultValue"][0]["max"], 10);

        // …and the CreateAction references exactly the emitted FormalParameters.
        let ca = graph.iter().find(|e| e["@type"] == "CreateAction").expect("a CreateAction");
        let refs: Vec<&Value> = ca["object"].as_array().expect("object refs").iter().collect();
        for fp in &fps {
            assert!(
                refs.iter().any(|o| o["@id"] == fp["@id"]),
                "every emitted FormalParameter is referenced by the run's CreateAction"
            );
        }
        assert!(
            !refs.iter().any(|o| o["@id"].as_str().is_some_and(|s| s.ends_with("-language"))),
            "no dangling reference to a suppressed runtime-metadata param"
        );
    }

    // TEST-7: a verification claim folds in as a WRROC ControlAction referencing
    // the run, with the honest status/claim; absent otherwise.
    #[test]
    fn manifest_folds_verification_claim() {
        let run_id = Uuid::new_v4();
        let runs = vec![ManifestRun {
            run_id,
            kind: "compute".into(),
            generator_id: "analysis".into(),
            params: serde_json::json!({}),
            input_hashes: vec!["sha256:root".into()],
            output_hashes: vec!["sha256:out".into()],
        }];
        let vers = vec![ManifestVerification {
            run_id,
            status: "reproduced".into(),
            tolerance_mode: "tolerant".into(),
            rootfs_digest: Some("sha256:deadbeef".into()),
            verified_at: Some("2026-07-17T00:00:00Z".into()),
            claim: "Reproduced ✓ — bit-identical outputs".into(),
        }];
        let m = build_manifest(&runs, &[], &vers);
        let graph = m["@graph"].as_array().unwrap();
        let ca = graph
            .iter()
            .find(|e| e["@type"] == "ControlAction")
            .expect("a ControlAction verification assertion");
        assert_eq!(ca["object"]["@id"], format!("#run-{run_id}"), "references the run");
        assert_eq!(ca["verificationStatus"], "reproduced");
        assert_eq!(ca["actionStatus"], "CompletedActionStatus");
        assert!(ca["description"].as_str().unwrap().contains("Reproduced"));
    }
}
