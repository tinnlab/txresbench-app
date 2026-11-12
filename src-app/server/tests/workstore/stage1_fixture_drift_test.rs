//! **The stage-1 reference fixtures regenerate-and-compare, like the parity fixture does.**
//!
//! `gathered_fixture_test` has re-generated its bytes on every run since it was written, so
//! it cannot go stale. These two — the alignment fixtures every seam, serve-path, remap and
//! ordering test reads — had no such guard, and went stale silently: stage 1 replaced
//! `--reversed` with `--agreeing` and inverted which variant disagrees, and nothing in this
//! tree noticed. I found out because I happened to run the emitter by hand. Next time nobody
//! will.
//!
//! **That is the shape this round keeps producing: a guard that exists on one artifact and
//! not on its siblings.** Same mechanism as the parity fixture — regenerate, compare, fail on
//! drift, write only behind the env flag — so a producer change is a red test rather than a
//! discovery.
//!
//! Regenerate with:
//! ```text
//! UPDATE_STAGE1_FIXTURES=1 cargo test --test integration_tests workstore::stage1_fixture_drift
//! ```
//!
//! **The regenerating run's own verdict is not trustworthy — RE-RUN WITHOUT THE FLAG.**
//! Measured while regenerating for C4: `the_absence_fixture_actually_contains_absence_codes`
//! READS the committed fixture while its three siblings WRITE them, in the same binary, in
//! parallel. So under the flag it can read pre-regeneration bytes and report `ok` on a
//! fixture that no longer exists in that form — it did exactly that, passing on the write
//! run and failing on the next plain run.
//!
//! Not fixed by serialising, because that would only hide it: the honest reading is that a
//! write run is a WRITE, not a verification, and the plain run immediately after is what
//! says whether the tree is consistent. Recorded here because "I regenerated and it was
//! green" is otherwise a reasonable thing to believe.

use std::path::{Path, PathBuf};
use std::process::Command;

/// `<repo>` — `CARGO_MANIFEST_DIR` is `<repo>/src-app/server`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("CARGO_MANIFEST_DIR is <repo>/src-app/server")
        .to_path_buf()
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// Every file under `root`, as `(relative path, bytes)`, sorted.
fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .expect("under root")
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read(&p).expect("read")));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Run stage 1's emitter into `dest`, with `flags`.
fn emit(dest: &Path, flags: &[&str]) {
    let script = repo_root().join("src-app/packages/embedding-integrate/tools/emit_reference_alignment.py");
    assert!(
        script.is_file(),
        "the reference emitter is missing at {} — the fixtures below cannot be checked \
         against anything, which is worse than them being stale",
        script.display()
    );
    let out = Command::new("python3")
        .arg(&script)
        .arg(dest)
        .args(flags)
        .current_dir(repo_root())
        .output()
        .expect("python3 must be available to regenerate the reference fixtures");
    assert!(
        out.status.success(),
        "the emitter failed with {flags:?} — if its INTERFACE changed, that is exactly the \
         drift this test exists to surface:\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Regenerate one fixture and compare, or write it under the env flag.
fn check(name: &str, flags: &[&str], min_files: usize) {
    let tmp = std::env::temp_dir().join(format!(
        "txr-s1fx-{}-{}-{name}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    emit(&tmp, flags);

    // The emitter writes `outputs/` (the artifacts) and `inputs/` (the staged sources); the
    // committed fixture holds the first at its root and the second under `sources/`.
    let mut fresh = tree(&tmp.join("outputs"));
    for (rel, bytes) in tree(&tmp.join("inputs")) {
        fresh.push((format!("sources/{rel}"), bytes));
    }
    fresh.sort_by(|a, b| a.0.cmp(&b.0));

    assert!(
        fresh.len() >= min_files,
        "NON-VACUITY: the emitter produced {} file(s) for {name}; an empty regeneration would \
         make every comparison below trivially true",
        fresh.len()
    );

    let root = fixture(name);
    if std::env::var("UPDATE_STAGE1_FIXTURES").is_ok() {
        let _ = std::fs::remove_dir_all(&root);
        for (rel, bytes) in &fresh {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir -p");
            std::fs::write(&p, bytes).expect("write");
        }
        eprintln!("stage-1 fixture {name} REGENERATED at {}", root.display());
        let _ = std::fs::remove_dir_all(&tmp);
        return;
    }

    let committed = tree(&root);
    let names_fresh: Vec<&str> = fresh.iter().map(|(r, _)| r.as_str()).collect();
    let names_committed: Vec<&str> = committed.iter().map(|(r, _)| r.as_str()).collect();
    assert_eq!(
        names_fresh, names_committed,
        "{name}: the emitter's FILE SET no longer matches the committed fixture. If the \
         producer's output shape changed, regenerate with UPDATE_STAGE1_FIXTURES=1 and \
         re-read every expected value that depends on it — do not regenerate to make a red \
         test green"
    );
    for ((rel, a), (_, b)) in fresh.iter().zip(committed.iter()) {
        assert!(
            a == b,
            "{name}/{rel} differs from what the emitter produces today ({} vs {} bytes). \
             This is the guard working: the committed fixture is what every seam, ordering \
             and remap test reads, so a producer change that nothing regenerates is a suite \
             agreeing with last month's producer.",
            a.len(),
            b.len()
        );
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// The COINCIDING variant — declaration order equals the sorted segment order.
#[test]
fn the_agreeing_reference_fixture_matches_the_emitter() {
    check("stage1_alignment", &["--agreeing"], 30);
}

/// The DISAGREEING variant — the emitter's default since stage 1's own audit found that a
/// coinciding fixture hides an ordering defect. Every ordering-sensitive test reads this one.
#[test]
fn the_disagreeing_reference_fixture_matches_the_emitter() {
    check("stage1_alignment_reversed", &[], 30);
}

/// The ABSENCE variant — `--mode authority --authority ds-a`, where the authority's
/// vocabulary excludes levels the other source has, so the lookup carries `-1`.
///
/// It exists because `GATHER_LEVEL_ABSENT` had no producer-faithful fixture: I measured both
/// modes and found every code mapped, and concluded the path was unreachable. It was
/// reachable — the emitter's two authority invocations were DEGENERATE, because ds-a's levels
/// were a strict subset of ds-b's, so naming ds-b as authority dropped nothing. **A
/// degenerate fixture and a missing implementation present identically from outside.**
#[test]
fn the_absence_reference_fixture_matches_the_emitter() {
    check(
        "stage1_alignment_absence",
        &["--mode", "authority", "--authority", "ds-a"],
        30,
    );
}

/// …and it really does carry absence, which is the whole reason it exists.
///
/// **The guard's PURPOSE is unchanged and its DEFINITION of absence has moved** (C4/DEC-26).
/// It asserted `any(c < 0)`; a dropped level is no longer a `-1` sentinel but a code pointing
/// at the vocabulary's DECLARED missing level, so the old form failed on a fixture that is
/// not degenerate at all — `no -1 in [1, 2, 2]`, where `2` IS the absence.
///
/// This is the same inversion the emitter's own exit-3 self-check took, and the same shape as
/// every other guard whose SUBJECT moved rather than whose rule was wrong: keep what it is
/// for, change only what the thing it looks for is encoded as. Deleting it would have removed
/// the only check that this fixture exercises the path it exists for; loosening it to "any
/// code" would have made it unable to fail.
///
/// It is now cross-checked against the DECLARATION rather than against a literal: the absent
/// code is looked up from `missing_levels[column]` through `unified_levels[column]`, so the
/// test cannot drift from the artifact the way a hardcoded `-1` (or a hardcoded `2`) would.
#[test]
fn the_absence_fixture_actually_contains_absence_codes() {
    let root = fixture("stage1_alignment_absence").join("alignment.zarr");
    let store = crate::common::zarr::load_dir(&root);

    // The producer DECLARES which label means absence; nothing here guesses it.
    let attrs: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("zarr.json")).expect("read zarr.json"))
            .expect("parse zarr.json");
    let txr = &attrs["attributes"]["txr_alignment"];
    let missing_label = txr["missing_levels"]["group"]
        .as_str()
        .expect("the absence fixture must DECLARE a missing level for `group`");
    let vocabulary: Vec<String> = txr["unified_levels"]["group"]
        .as_array()
        .expect("unified_levels.group")
        .iter()
        .map(|v| v.as_str().expect("a level is a string").to_string())
        .collect();
    let absent_code = vocabulary
        .iter()
        .position(|l| l == missing_label)
        .expect("the declared missing level must be IN the vocabulary it names");

    // APPENDED, never inserted — so it can never shadow a real level or shift a code.
    assert_eq!(
        absent_code,
        vocabulary.len() - 1,
        "the missing level {missing_label:?} is not the last entry of {vocabulary:?} — \
         inserting it shifts every later code and silently relabels the column"
    );

    let lookup = crate::common::zarr::read_i32(&store, "levels__group__0");
    assert!(
        lookup.contains(&(absent_code as i32)),
        "FIXTURE IS DEGENERATE: no code maps to the declared missing level {missing_label:?} \
         (code {absent_code}) in {lookup:?}. A fixture that cannot express the value it \
         exists for is indistinguishable from an unimplemented path — which is exactly the \
         mistake this fixture was added to correct"
    );
    // …and the retired encoding must never come back: a negative code is refused by the
    // serve path with a 400 for the ENTIRE column, so one appearing here would mean the
    // producer regressed to a sentinel the reader cannot serve.
    assert!(
        !lookup.iter().any(|c| *c < 0),
        "a NEGATIVE code is present in {lookup:?}. Since C4 every code is an in-range index \
         into the unified vocabulary; `remap_codes` refuses a negative one outright"
    );
    // Every code addresses a real level — the property that makes the column servable.
    assert!(
        lookup.iter().all(|c| (*c as usize) < vocabulary.len()),
        "a code in {lookup:?} indexes past the {}-entry vocabulary {vocabulary:?}",
        vocabulary.len()
    );
}

/// **…and the two really are different in the property they exist for.**
///
/// Without this, both fixtures could regenerate cleanly while being the same case — which is
/// exactly what happened when the emitter's flag was inverted: the committed pair silently
/// swapped meanings and every test still passed.
#[test]
fn the_two_fixtures_disagree_about_ordering_as_their_names_claim() {
    let read_orders = |name: &str| -> (Vec<i32>, Vec<i64>) {
        let store = crate::common::zarr::load_dir(&fixture(name).join("alignment.zarr"));
        (
            crate::common::zarr::read_i32(&store, "segment_order"),
            crate::common::zarr::read_i64(&store, "segment_start"),
        )
    };
    let (agree_order, agree_start) = read_orders("stage1_alignment");
    let (disagree_order, disagree_start) = read_orders("stage1_alignment_reversed");

    assert_eq!(
        agree_order,
        (0..agree_order.len() as i32).collect::<Vec<_>>(),
        "`stage1_alignment` must be the COINCIDING case"
    );
    assert!(agree_start.windows(2).all(|w| w[0] <= w[1]));

    assert_ne!(
        disagree_order,
        (0..disagree_order.len() as i32).collect::<Vec<_>>(),
        "`stage1_alignment_reversed` must be the DISAGREEING case — if it coincides, every \
         ordering test built on it passes against a reader that ignores declared_order"
    );
    assert!(
        disagree_start.windows(2).any(|w| w[0] > w[1]),
        "…and its segment starts must be non-monotonic in array order: {disagree_start:?}"
    );
}
