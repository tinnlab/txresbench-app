//! **TEST-4** [acceptance] [invariant: INV-2] [covers: ITEM-5, ITEM-2] — the load
//! rejection report on the REAL runtime path (tinnlab/txresbench#190, #197).
//!
//! ## What this proves that a unit test cannot
//!
//! The unit tier (`extensions::loader::tests`) proves the report's CONTENT and the
//! posture function's verdict: the coded check id, the derived origin, the manifest path,
//! the aggregated render, the byte-derived classification, the anti-vacuity floor. None of
//! that proves the mechanism is REACHED — a validator that exists and is unit-tested but
//! is never called is unfinished work, and that is exactly the shape of the defect being
//! fixed (the rejection already existed; nothing acted on it). So this drives a real
//! spawned server through `POST /api/processors/reload` → `reflect_processors`, the SAME
//! path the S6 filesystem watcher takes, and asserts on the HTTP surface an operator
//! actually sees.
//!
//! ## The three legs, and why they are these three
//!
//! (a) A broken **dropped-in** package: the reflect SUCCEEDS, the package is reported by
//!     name with its check id and its manifest path, and every other package still loads.
//!     This is `extensions/mod.rs`'s standing guarantee — "a bad drop degrades to 'that
//!     package absent', never an error that tears down the whole reflect" — preserved
//!     verbatim, and now LOUD instead of silent.
//!
//! (b) A **seed-named** package whose manifest is overwritten on disk. This is the leg
//!     that changed, and the change is the point. The posture turns on ORIGIN, and origin
//!     is decided by the BYTES, not the folder name: `<data_root>/processors/` is writable
//!     at runtime and the seed reconcile is deliberately no-clobber for CONTENT ("a user's
//!     edit to any of those files is untouched" — `extensions/embedded.rs`), so an
//!     overwritten seed manifest survives every restart. Had the classification gone by
//!     NAME, one file write would have earned a permanent, restart-surviving refusal
//!     through the trusted branch — the exact denial of service the tolerant drop-in
//!     posture exists to prevent. So the assertion here is that the server stays UP and
//!     stays LOUD, and that restoring the bytes restores the package. A genuine
//!     first-party refusal is unreachable from a healthy tree by construction (it requires
//!     our own byte-identical shipped package to fail the runtime lint — the #190/#197
//!     defect itself), which is why its posture is proved at the unit tier over the real
//!     `apply_load_posture` and not staged here by pretending an edit produces it.
//!
//! (c) A refusal that IS reachable at runtime, so the refusal WIRING is proved end to end:
//!     the anti-vacuity floor. With every package folder moved away (a failed extraction,
//!     a moved data root, a folder emptied by hand) the reflect is REFUSED, and the
//!     previously-published registry stays live — nothing was swapped. That pair, refusal
//!     plus last-good, is what keeps a loud failure from being its own second outage
//!     (DEC-7), and it is the half no unit test can show because it is a property of the
//!     running server's published snapshot.

use serde_json::Value;

use super::setup_admin;
use crate::common::TestServer;

/// A drop-in folder name — deliberately NOT a seed id, so it derives as dropped-in.
const DROPIN_PKG: &str = "zzz-broken-dropin";

/// A manifest that is valid YAML and names the right package, but carries an outer key the
/// `deny_unknown_fields` schema refuses — the shape a bad hand-edit actually takes.
fn broken_manifest(id: &str) -> String {
    format!(
        "id: {id}\nname: Broken\npublisher: txr\nversion: 0.1.0\napiVersion: \"1.0\"\n\
         bogus_unknown_key: true\ncontributes: {{}}\n"
    )
}

async fn get_json(server: &TestServer, token: &str, path: &str) -> (u16, Value) {
    let resp = server
        .client
        .get(server.api_url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap_or_else(|e| panic!("GET {path}: {e}"));
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

async fn reload(server: &TestServer, token: &str) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(token)
        .send()
        .await
        .expect("reload request");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// The row for one package in a `packages` array (the reload response / `GET /processors`).
fn row<'a>(packages: &'a [Value], id: &str) -> &'a Value {
    packages
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or_else(|| panic!("no row for `{id}` in {packages:?}"))
}

/// A first-party package that is safe to break: id-sorted-first among those contributing
/// NO datatype, so breaking it cannot cascade into a sibling's `extends` and confound the
/// "exactly one package was refused" assertion, and cannot move the lattice count the
/// no-swap assertions below compare against.
///
/// DERIVED from the live `GET /api/extensions` dump, never typed in. A written-down
/// package id decays the moment the package tree changes — which it did while this branch
/// was open — and the app may carry ZERO domain vocabulary, which
/// `lint-no-domain-in-builtin` enforces.
fn pick_breakable_first_party(extensions: &[Value], packages: &[Value]) -> String {
    let mut ids: Vec<&str> = extensions
        .iter()
        .filter(|m| {
            m["contributes"]["datatypes"]
                .as_array()
                .map(|a| a.is_empty())
                .unwrap_or(true)
        })
        .filter_map(|m| m["id"].as_str())
        .filter(|id| {
            packages
                .iter()
                .any(|p| p["id"] == *id && p["origin"] == "first-party")
        })
        .collect();
    ids.sort();
    ids.first()
        .unwrap_or_else(|| panic!("no leaf first-party package to break: {packages:?}"))
        .to_string()
}

/// POSITIVE CONTROL: every first-party package other than `excluding` must be loaded `ok`.
///
/// Asserting the WHOLE set rather than one hand-picked id is what makes this the
/// anti-vacuity floor it claims to be: "the bad package was refused" is equally true of a
/// reflect that loaded nothing, and a package landing on main tomorrow is covered here with
/// no edit — which is how the package that merged into main mid-branch became a live
/// control the day it landed.
fn assert_every_other_first_party_loaded(packages: &[Value], excluding: &str) {
    let others: Vec<&Value> = packages
        .iter()
        .filter(|p| p["origin"] == "first-party" && p["id"] != excluding)
        .collect();
    assert!(
        others.len() >= 5,
        "POSITIVE CONTROL: the first-party set is populated ({}) — otherwise every \
         assertion here is vacuous: {packages:?}",
        others.len()
    );
    let broken: Vec<(&str, &Value)> = others
        .iter()
        .filter(|p| p["ok"] != true)
        .map(|p| (p["id"].as_str().unwrap_or("?"), &p["check"]))
        .collect();
    assert!(
        broken.is_empty(),
        "POSITIVE CONTROL: every OTHER first-party package must still load; these did \
         not: {broken:?}"
    );
}

#[tokio::test]
async fn a_failed_package_load_is_loud_and_its_posture_is_scoped_by_origin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let processors_dir = server.data_dir().join("processors");
    assert!(
        processors_dir.is_dir(),
        "the server extracted the seed processors folder at boot: {}",
        processors_dir.display()
    );

    // ── Baseline. The server booted, so by construction no first-party package was
    //    refused (boot would have failed). Record the healthy lattice to compare against.
    let (st, before) = get_json(&server, &admin, "/datatypes").await;
    assert_eq!(st, 200, "baseline GET /datatypes");
    let baseline_types = before.as_array().expect("datatype array").len();
    assert!(
        baseline_types > 10,
        "POSITIVE CONTROL: the baseline lattice is populated ({baseline_types} types) — \
         every 'unchanged' assertion below is vacuous against an empty registry"
    );

    let (st, before_pkgs) = get_json(&server, &admin, "/processors").await;
    assert_eq!(st, 200, "baseline GET /processors");
    let before_pkgs = before_pkgs.as_array().expect("packages array").clone();
    assert!(
        before_pkgs.iter().all(|p| p["ok"] == true),
        "baseline: the shipped seed loads with ZERO rejections: {before_pkgs:?}"
    );
    let (st, exts) = get_json(&server, &admin, "/extensions").await;
    assert_eq!(st, 200, "baseline GET /extensions");
    let exts = exts.as_array().expect("extensions array").clone();

    // The package this test will overwrite, chosen from the live dump — see the helper for
    // why it is derived rather than named.
    let seed_pkg = pick_breakable_first_party(&exts, &before_pkgs);
    assert_eq!(
        row(&before_pkgs, &seed_pkg)["origin"],
        "first-party",
        "an UNTOUCHED seed package derives as first-party — it is still carrying the \
         bytes this binary embedded, which is what the classification actually asserts"
    );
    assert_every_other_first_party_loaded(&before_pkgs, "");

    // ══ (a) a broken DROPPED-IN package: loud, named, and TOLERATED (INV-2). ══
    std::fs::create_dir_all(processors_dir.join(DROPIN_PKG)).expect("mkdir drop-in");
    std::fs::write(
        processors_dir.join(DROPIN_PKG).join("manifest.yaml"),
        broken_manifest(DROPIN_PKG),
    )
    .expect("write broken drop-in");

    let (status, body) = reload(&server, &admin).await;
    assert_eq!(
        status, 200,
        "a broken DROP-IN must not tear down the reflect (INV-2): {body}"
    );
    let packages = body["packages"].as_array().expect("packages array").clone();

    let bad = row(&packages, DROPIN_PKG);
    assert_eq!(bad["ok"], false, "the broken drop-in is refused");
    assert_eq!(
        bad["origin"], "dropped-in",
        "…and it is classified as a DROP-IN — derived from the embedded seed itself, \
         never from a written-down list"
    );
    assert_eq!(
        bad["check"], "PKG_MALFORMED_MANIFEST",
        "…carrying a STABLE check id an operator and a test can both key on: {bad}"
    );
    assert_eq!(
        bad["manifest_path"],
        format!("{DROPIN_PKG}/manifest.yaml"),
        "…and the manifest to go fix: {bad}"
    );
    assert!(
        bad["error"].as_str().unwrap_or_default().contains(DROPIN_PKG),
        "…with a package-scoped message: {bad}"
    );

    // POSITIVE CONTROL — the refusal is about that one package, not about the scan. Every
    // first-party package in the SAME reflect must still load; without this, "the bad
    // package is refused" is equally true of a reflect that loaded nothing.
    assert_every_other_first_party_loaded(&packages, "");
    let (_, after_a) = get_json(&server, &admin, "/datatypes").await;
    assert_eq!(
        after_a.as_array().expect("array").len(),
        baseline_types,
        "a tolerated drop-in refusal costs the lattice nothing"
    );

    // ══ (b) a SEED-NAMED package overwritten on disk: still loud, still TOLERATED. ══
    // The anti-DoS property, end to end. The reconcile is no-clobber for content so this
    // write survives every restart; if origin went by NAME this single write would be a
    // permanent boot refusal reached through the trusted branch.
    let seed_manifest = processors_dir.join(&seed_pkg).join("manifest.yaml");
    let embedded_bytes = std::fs::read(&seed_manifest).expect("read the shipped manifest");
    std::fs::write(&seed_manifest, broken_manifest(&seed_pkg))
        .expect("overwrite the seed package's manifest");

    let (status, body) = reload(&server, &admin).await;
    assert_eq!(
        status, 200,
        "overwriting a seed-NAMED manifest must NOT be able to stop a running server \
         reflecting: anyone who can write one file under <data_root>/processors/ could \
         otherwise brick it permanently: {body}"
    );
    let packages = body["packages"].as_array().expect("packages array").clone();
    let overwritten = row(&packages, &seed_pkg);
    assert_eq!(
        overwritten["ok"], false,
        "the overwritten package is refused — LOUDLY, which is the whole fix: {overwritten}"
    );
    assert_eq!(
        overwritten["origin"], "dropped-in",
        "…and it is NO LONGER first-party: the folder keeps a seed-managed NAME, but the \
         bytes are not the ones this binary embedded, and the name alone is exactly what \
         must not confer trust: {overwritten}"
    );
    assert_eq!(
        overwritten["check"], "PKG_MALFORMED_MANIFEST",
        "…coded, so a test asserts the check rather than the prose: {overwritten}"
    );
    assert_eq!(
        overwritten["manifest_path"],
        format!("{seed_pkg}/manifest.yaml"),
        "…and names the file an operator has to go fix: {overwritten}"
    );
    assert_every_other_first_party_loaded(&packages, &seed_pkg);

    // …and RESTORING the shipped bytes restores the package AND its classification. The
    // check reads disk on every scan rather than remembering a verdict, so recovery costs
    // nothing but putting the file back.
    std::fs::write(&seed_manifest, &embedded_bytes).expect("restore the shipped manifest");
    let (status, body) = reload(&server, &admin).await;
    assert_eq!(status, 200, "the restored tree reflects: {body}");
    let packages = body["packages"].as_array().expect("packages array").clone();
    let restored = row(&packages, &seed_pkg);
    assert_eq!(restored["ok"], true, "the restored package loads: {restored}");
    assert_eq!(
        restored["origin"], "first-party",
        "…and is first-party again, because the bytes are ours again: {restored}"
    );

    // ══ (c) a refusal that IS reachable: the anti-vacuity floor, on the real path. ══
    // Park every package folder — the shape a failed extraction, a moved data root, or a
    // hand-emptied folder takes. This is the leg that proves the CHECKED path is genuinely
    // wired into `reflect_processors` and that a refusal swaps NOTHING.
    let parked = server.data_dir().join("processors-parked");
    std::fs::create_dir_all(&parked).expect("mkdir park");
    let mut moved: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(&processors_dir).expect("read processors dir") {
        let path = entry.expect("dir entry").path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().expect("dir name").to_owned();
        std::fs::rename(&path, parked.join(&name)).expect("park a package folder");
        moved.push(std::path::PathBuf::from(name));
    }
    assert!(
        moved.len() >= 5,
        "NON-VACUITY: the park loop must actually move the packages, else the refusal \
         below would be about something other than an empty folder ({} moved)",
        moved.len()
    );

    let (status, body) = reload(&server, &admin).await;
    assert_eq!(
        status, 500,
        "a scan that discovers ZERO candidate packages is a COLLAPSE, and publishing an \
         empty registry over it is precisely the silent failure this change exists to \
         stop: {body}"
    );
    let msg = body.to_string();
    assert!(
        msg.contains("ZERO candidate packages"),
        "the refusal says what happened: {msg}"
    );
    assert!(
        msg.contains(&processors_dir.display().to_string()),
        "…and names the scanned root, so an operator knows WHERE to look: {msg}"
    );
    assert!(
        msg.contains("TXR_PROCESSOR_SEED_ONLY") && msg.contains("data root"),
        "…and diagnoses the likely causes rather than only stating the symptom: {msg}"
    );

    // ── the LAST-GOOD registry is still live: a refused reflect swaps NOTHING. ──
    // This is the half that keeps the refusal from being its own outage (DEC-7): a running
    // server does not lose its registry because a folder went missing under it.
    let (st, after_c) = get_json(&server, &admin, "/datatypes").await;
    assert_eq!(st, 200, "the server is still serving after a refused reflect");
    assert_eq!(
        after_c.as_array().expect("array").len(),
        baseline_types,
        "the refused reflect did NOT swap: the previously-published lattice is intact"
    );
    let (_, after_pkgs) = get_json(&server, &admin, "/processors").await;
    let after_pkgs = after_pkgs.as_array().expect("array").clone();
    assert_eq!(
        row(&after_pkgs, &seed_pkg)["ok"],
        true,
        "the last-good snapshot still holds the packages — the refusal protected the \
         running registry instead of degrading it"
    );
    assert_every_other_first_party_loaded(&after_pkgs, "");

    // …and un-parking recovers, so the refusal is a stop, not a trap.
    for name in &moved {
        std::fs::rename(parked.join(name), processors_dir.join(name)).expect("un-park");
    }
    let (status, body) = reload(&server, &admin).await;
    assert_eq!(status, 200, "the restored folder reflects again: {body}");
    let packages = body["packages"].as_array().expect("packages array").clone();
    assert_every_other_first_party_loaded(&packages, "");
}
