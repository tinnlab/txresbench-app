//! Export scoping (ITEM-16) over the ITEM-1 backward walk. Export scope = which
//! root you walk from: a single run (default), a set of runs, or the whole project
//! (union of every run's leaf closure). A multi-output upstream run's SIBLING
//! output the target never used is excluded from the carried set.

use std::collections::HashSet;

use uuid::Uuid;
use txresbench_core::AppError;

use crate::modules::provenance::graph::{backward_reachable, WalkArtifact, WalkRun};

/// A resolved export scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportScope {
    /// Backward closure of one run/artifact target.
    Single(Uuid),
    /// Union of the closures of a set of runs.
    Set(Vec<Uuid>),
    /// The whole project (union of all runs' closures).
    Project,
}

/// The minimal sub-DAG to carry: the reachable runs + the exact content-hashes to
/// bundle (never a sibling output the walk didn't follow).
#[derive(Debug, Clone, Default)]
pub struct SubDag {
    pub runs: HashSet<Uuid>,
    pub carried_hashes: HashSet<String>,
}

/// Parse the wire `scope` + optional `target` into an `ExportScope`.
pub fn parse_scope(scope: &str, target: Option<Uuid>) -> Result<ExportScope, AppError> {
    match scope {
        "single" => target
            .map(ExportScope::Single)
            .ok_or_else(|| AppError::bad_request("PROVENANCE_SCOPE", "single scope needs a target")),
        "set" => target
            .map(|t| ExportScope::Set(vec![t]))
            .ok_or_else(|| AppError::bad_request("PROVENANCE_SCOPE", "set scope needs a target")),
        "project" => Ok(ExportScope::Project),
        other => Err(AppError::bad_request(
            "PROVENANCE_SCOPE",
            format!("unknown export scope '{other}' (single|set|project)"),
        )),
    }
}

/// Resolve the scope to the carried sub-DAG. `all_run_ids` is every run in the
/// project (for the whole-project union).
pub fn resolve(
    scope: &ExportScope,
    all_run_ids: &[Uuid],
    runs: &[WalkRun],
    artifacts: &[WalkArtifact],
) -> SubDag {
    let targets: Vec<Uuid> = match scope {
        ExportScope::Single(t) => vec![*t],
        ExportScope::Set(ts) => ts.clone(),
        ExportScope::Project => all_run_ids.to_vec(),
    };
    let walk = backward_reachable(&targets, runs, artifacts);

    // Carried data = every hash the walk followed PLUS the target runs' own
    // outputs (the deliverable). A sibling output of an UPSTREAM run the walk
    // never followed is therefore excluded.
    let target_set: HashSet<Uuid> = targets.iter().copied().collect();
    let mut carried = walk.used_hashes.clone();
    for a in artifacts {
        if let Some(rid) = a.run_id {
            if target_set.contains(&rid) {
                carried.insert(a.content_hash.clone());
            }
        }
    }

    SubDag { runs: walk.runs, carried_hashes: carried }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wr(id: Uuid, inputs: &[&str]) -> WalkRun {
        WalkRun { run_id: id, input_hashes: inputs.iter().map(|s| s.to_string()).collect() }
    }
    fn wa(hash: &str, run: Option<Uuid>) -> WalkArtifact {
        WalkArtifact { content_hash: hash.into(), run_id: run }
    }

    // TEST-8: single-run closure, run-set union, whole-project union; a multi-output
    // run's SIBLING output the target did NOT use is excluded from the carried set.
    #[test]
    fn scope_resolution_and_sibling_exclusion() {
        let u = Uuid::new_v4(); // upstream: consumes root -> produces o1 (used) + o2 (sibling)
        let t = Uuid::new_v4(); // target:   consumes o1   -> produces t1
        let other = Uuid::new_v4(); // unrelated run

        let runs = vec![wr(u, &["root"]), wr(t, &["o1"]), wr(other, &["root"])];
        let artifacts = vec![
            wa("root", None),
            wa("o1", Some(u)),
            wa("o2", Some(u)), // sibling of o1, never used by t
            wa("t1", Some(t)),
            wa("x", Some(other)),
        ];
        let all: Vec<Uuid> = vec![u, t, other];

        // Single-run closure from t.
        let single = resolve(&ExportScope::Single(t), &all, &runs, &artifacts);
        assert!(single.runs.contains(&t) && single.runs.contains(&u));
        assert!(!single.runs.contains(&other), "unrelated run excluded");
        assert!(single.carried_hashes.contains("o1"), "used upstream output carried");
        assert!(single.carried_hashes.contains("root"), "root carried");
        assert!(single.carried_hashes.contains("t1"), "target output carried");
        assert!(!single.carried_hashes.contains("o2"), "unused sibling output excluded");

        // Set union (t only here, same closure).
        let set = resolve(&ExportScope::Set(vec![t]), &all, &runs, &artifacts);
        assert_eq!(set.runs, single.runs);

        // Whole project includes every run.
        let project = resolve(&ExportScope::Project, &all, &runs, &artifacts);
        assert!(project.runs.contains(&t) && project.runs.contains(&u) && project.runs.contains(&other));
    }
}
