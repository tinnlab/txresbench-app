//! TEST-16 [ITEM-7, ITEM-9] + TEST-38 [ITEM-27] — the archive→Zarr converter,
//! end-to-end, ROOTFS-GATED.
//!
//! With the analysis rootfs mounted, uploading the converter's input file type
//! auto-enqueues it (TEST-15), the scheduler runs it inside the sandbox, and the run
//! catalogs its produced outputs: the CSC matrix + N `embedding` artifacts (ITEM-9) +
//! the per-axis `metadata-column`s, and the dataset's `metadata` is populated from the
//! converter's summary.
//!
//! ── WHAT ITEM-27 CHANGED HERE ────────────────────────────────────────────────
//! This test used to demand exactly ONE artifact of the lossless multi-file archive
//! type. That store was never a second product: the importer wrote it and then streamed
//! the CSC matrix back OUT of it, so it was a TRANSPOSE BUFFER on the critical path
//! (86 % of import wall clock on the measured 150k × 32k case). ITEM-27 replaced the
//! transpose with a streaming counting sort that writes Zarr directly, and the store
//! went with it.
//!
//! So the assertion INVERTS rather than relaxing: exactly ZERO CATALOGUED artifacts of
//! the retired type, alongside ≥1 matrix. **That catalog count is the whole of what this
//! file discriminates on for ITEM-27.** There is also a disk walk for a stray store
//! directory, and it is a NON-DISCRIMINATING TRIPWIRE — it cannot fail on the path that
//! reaches it, for reasons measured and written out at its call site and repeated in the
//! helper's own doc. Read one of those two notes before treating its green as evidence.
//!
//! This header used to claim the opposite — that the walk was "the part that actually
//! catches a half-done deletion", and that a converter which "wrote the store and merely
//! stopped cataloguing it … does not satisfy this one". That proposition was withdrawn
//! (measured, not reworded) at the call site, in the helper doc, in `TESTS.md` and in
//! `TEST_RESULTS.md`; the header was the one site the correction missed, so the file
//! contradicted itself about one assertion. What is written above is what the walk can
//! actually discriminate.
//!
//! **Where the "wrote it but stopped cataloguing it" evasion IS covered**: the SOURCE
//! scans that deny the converter the means — TEST-52 (the importer's own source no longer
//! speaks the store library, with its measured limits recorded in `TESTS.md`) and TEST-51
//! (the env-image recipe scan). TEST-52 lives in that contributed package's own pytest
//! suite, where it runs without a rootfs and where its subject actually is. So ITEM-27's
//! on-disk half is covered by static denial, not by this file's walk.
//!
//! ── HOW THE DOMAIN IDS ARE SPELLED (INV-5) ──────────────────────────────────
//! This file has to name two contributed datatype ids and one directory suffix, because
//! it asserts on the presence of one and the ABSENCE of the other two. Each is named
//! EXACTLY ONCE, in the constants below, and referenced from there — the same discipline
//! `STORE_LIBRARY` already uses further down, so the assertion and its message do not
//! each re-enter the vocabulary into the tree.
//!
//! The WHOLE test is gated behind [`rootfs_gate`](super::hardening_common::rootfs_gate):
//! it RUNS + asserts on a rootfs-capable host and SELF-SKIPS (never a compile-time
//! ignore) otherwise — the same self-skip precedent as `capsule_reproduces_test.rs`.

use reqwest::multipart::{Form, Part};
use serde_json::Value;

use super::hardening_common::{gate, poll_job_terminal_api, pool_for};
use super::setup_admin;
use crate::common::TestServer;

/// The datatype ITEM-27 retired — the lossless multi-file archive the CSC used to be
/// streamed out of. Named once; asserted ABSENT.
pub(crate) const RETIRED_STORE_DATATYPE: &str = "single-cell/soma";
/// The on-disk directory suffix that same archive used. Named once; asserted ABSENT.
const RETIRED_STORE_DIR_SUFFIX: &str = ".soma";
/// The count-matrix datatype the converter DOES produce. Named once; asserted PRESENT.
pub(crate) const MATRIX_DATATYPE: &str = "single-cell/expression";

/// The key-artifact datatype family, resolved from the registry as DATA: every type
/// carrying the family capability, plus its subtypes. This is the app's own production
/// derivation (`sandbox/inputs.rs::axis_index_datatype_allow`); spelling the family's
/// base id here instead would hardcode a contributed datatype for a lookup the app
/// already knows how to do without one (INV-5).
fn axis_index_datatype_allow() -> Vec<String> {
    use txresbench::modules::datatype::DatatypeRegistry;
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    let mut allow: Vec<String> = reg
        .types_with_capability("metadata-column-family")
        .into_iter()
        .flat_map(|id| reg.descendants_inclusive(&id))
        .collect();
    allow.sort();
    allow.dedup();
    assert!(
        !allow.is_empty(),
        "no registered datatype carries the key-artifact family capability, so this \
         query would match nothing and the assertion below would be vacuous"
    );
    allow
}

// A REAL h5ad. The converter genuinely parses it inside the sandbox, so a fake
// `\x89HDF…` payload can never satisfy "runs to completion" — this test asserted
// exactly that until the rootfs gate stopped self-skipping and let it run.

#[tokio::test]
async fn h5ad_converts_to_zarr_expression_and_embeddings() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Gate the ENTIRE test: without a mounted, executable analysis rootfs the
    // sandboxed converter can't produce real output — and without the real
    // pbmc3k fixture there is nothing valid for it to convert.
    let Some(h5ad_bytes) = gate(
        &server,
        &admin,
        "h5ad_converts_to_zarr_expression_and_embeddings",
    )
    .await
    else {
        return;
    };

    // Upload a `.h5ad` → typed dataset → auto-enqueued converter job.
    let form = Form::new().part(
        "file",
        Part::bytes(h5ad_bytes).file_name("pbmc.h5ad".to_string()),
    );
    let body: Value = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ds = &body["datasets"].as_array().expect("datasets")[0];
    let dataset_id = ds["id"].as_str().expect("dataset id").to_string();
    let ds_uuid = uuid::Uuid::parse_str(&dataset_id).unwrap();

    // Find the auto-enqueued converter job for this dataset. A job's tenancy scope
    // lives in `job_scope` (ITEM-68 — the `jobs.dataset_id` column was dropped by
    // migration …280001), so resolve via that join. Reads the server's own DB.
    let pool = pool_for(&server).await;
    let job_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT j.id FROM jobs j \
         JOIN job_scope s ON s.job_id = j.id \
         WHERE s.scope_kind = 'dataset' AND s.scope_id = $1",
    )
    .bind(ds_uuid)
    .fetch_one(&pool)
    .await
    .expect("converter job auto-enqueued");

    // Wait for the sandboxed converter to complete, through the SHARED
    // `poll_job_terminal_api`. An earlier private copy of this poller read
    // `body["status"]` — always absent on a `JobDetail` (`{job, logs, …}`) — so it
    // burned its whole deadline and looked like "the job never terminates"; the
    // shared helper reads `body["job"]["status"]` and panics with the last body.
    // 300s: kept from the SOMA era. The streaming transpose is measurably faster
    // (9.5 s vs 14.8 s on a 39M-value bench), so this is now slack, not a floor.
    let (status, detail) = poll_job_terminal_api(
        &server,
        &admin,
        &job_id.to_string(),
        std::time::Duration::from_secs(300),
    )
    .await;
    assert_eq!(
        status, "completed",
        "the h5ad→Zarr converter runs to completion: {}",
        detail["job"]["error"]
    );

    // Assert the produced-artifact shape at the catalog layer (the dataset-scoped
    // artifacts have no project_id, so — like the rest of the hardening suite —
    // this reads the `artifacts` table directly via the server's own DB).
    let datatypes: Vec<String> =
        sqlx::query_scalar("SELECT datatype FROM artifacts WHERE dataset_id = $1")
            .bind(ds_uuid)
            .fetch_all(&pool)
            .await
            .expect("list produced-artifact datatypes");

    let retired = datatypes
        .iter()
        .filter(|d| *d == RETIRED_STORE_DATATYPE)
        .count();
    let expression = datatypes.iter().filter(|d| *d == MATRIX_DATATYPE).count();
    assert_eq!(
        retired, 0,
        "ITEM-27 deleted the archive output — it was the transpose buffer the CSC was \
         streamed out of, not a product. Got {retired} (datatypes: {datatypes:?})"
    );
    assert!(
        expression >= 1,
        "≥1 {MATRIX_DATATYPE} matrix produced: got {expression} (datatypes: {datatypes:?})"
    );
    // The matrix is the ARTIFACT tier now, not the viz-only `intermediate` it was while
    // a lossless archive sat beside it.
    //
    // Reads the FIRST-CLASS `role` column (migration `202608040003_artifact_role.sql`).
    // It read `params->>'role'` until this pass — a column ITEM-7 had already DROPPED,
    // so the query could only ever have failed at runtime; it never did, because the
    // whole test self-skips without a rootfs.
    let expr_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM artifacts \
         WHERE dataset_id = $1 AND datatype = $2 LIMIT 1",
    )
    .bind(ds_uuid)
    .bind(MATRIX_DATATYPE)
    .fetch_one(&pool)
    .await
    .expect("read the expression artifact's role");
    assert_eq!(
        expr_role.as_deref().unwrap_or("artifact"),
        "artifact",
        "the CSC matrix is the count matrix now, not a projection of an archive"
    );

    // A NON-DISCRIMINATING TRIPWIRE — it cannot fail on the path that reaches it, and
    // this comment used to claim the opposite ("the half a datatype count cannot see: a
    // converter that STILL WROTE the store and merely stopped cataloguing it would pay
    // the full 86 % and pass everything above"). Measured: by the time the import job is
    // terminal, `jobs/runner.rs`'s `RunDirs::Reclaim` arm (taken on a cataloged exit-0
    // run — the only arm compatible with the assertions above passing) has already
    // `remove_dir_all`'d `workspace_root` and discarded the staging dir, and BOTH live
    // under this same data root (`TXR_APP_DATA_DIR`, set by the harness, is what
    // `rootfs::data_root()` reads). Everything that survives in the object store is a
    // content-addressed blob named by its hash — `local_fs::put_prefix` turns each member
    // into its own blob and keeps member PATHS inside a manifest blob, never as directory
    // names — so no directory carrying `RETIRED_STORE_DIR_SUFFIX` can exist here for ANY
    // converter.
    //
    // The clause that actually discriminates is the `retired == 0` datatype count above.
    // The "wrote it but did not catalogue it" evasion is covered instead by the SOURCE
    // scans that deny the converter the means: TEST-52 (the importer's own source scan for
    // the retired store library, whose measured limits are recorded in TESTS.md) and
    // TEST-51 (the env-image recipe scan below).
    //
    // Kept, not deleted: it costs one directory walk and it is a real guard IF the
    // cleanup contract ever changes (the `RunDirs::Preserve` arm keeps both trees). It is
    // labelled here so no future reader counts it as the on-disk coverage it is not.
    let stray = find_retired_store_dirs(server.data_dir());
    assert!(
        stray.is_empty(),
        "a retired archive store was written to disk despite not being catalogued: {stray:?}"
    );

    // `embedding` is `cardinality: many` in the converter manifest — the importer
    // EXTRACTS embeddings from the source's `obsm`, it does not compute them. The
    // pbmc3k RAW count matrix carries none, so ZERO here is correct, and the
    // sibling `processor_run_test::import_h5ad_runs_end_to_end_on_pbmc3k` likewise
    // asserts only expression + metadata.

    // BOTH of the matrix's axes still get a key artifact — the labels that used to be
    // recoverable only from the deleted archive's own annotation frames.
    //
    // Two fixes in one, both forced by this branch:
    //   * the axis label lives in the PRODUCER-DECLARED `structure` (ITEM-5). This read
    //     `params->>'axis'`, a column ITEM-7 dropped, so it could only have failed at
    //     runtime — masked because the whole test self-skips without a rootfs.
    //   * it asserted two literal axis NAMES. INV-3 says the name is a LABEL, never a
    //     key, and DRIFT-2.2 records that same name-as-identity defect being fixed at
    //     three separate layers. What actually has to hold is that the two axes are
    //     DISTINCT and both indexed — which is what is asserted, and which a converter
    //     that emitted one axis twice (the real regression) still fails.
    //
    // The key-artifact family is DATA, resolved exactly as `sandbox/inputs.rs`'s
    // `axis_index_datatype_allow` resolves it — the carriers of the family CAPABILITY
    // plus their subtypes — so no datatype-id literal appears here and a contributed
    // subtype is covered for free (the same derivation `workstore::test17` uses).
    let allow = axis_index_datatype_allow();
    let allow_json = serde_json::to_string(&allow).expect("Vec<String> is JSON-serializable");
    let axes: Vec<String> = sqlx::query_scalar(
        "SELECT json_extract(structure, '$.axis') FROM artifacts \
         WHERE dataset_id = $1 AND datatype IN (SELECT value FROM json_each($2)) \
           AND json_extract(meta, '$.is_axis_index') = 'true'",
    )
    .bind(ds_uuid)
    .bind(allow_json)
    .fetch_all(&pool)
    .await
    .expect("list key-artifact axis labels");
    let distinct: std::collections::BTreeSet<&String> = axes.iter().collect();
    assert_eq!(
        distinct.len(),
        2,
        "a 2-D matrix has two axes and each needs its own key artifact; got {axes:?}"
    );

    // ITEM-9: the dataset's metadata is populated from the converter summary.
    let dataset: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{dataset_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let meta = &dataset["metadata"];
    assert!(
        meta.is_object() && !meta.as_object().unwrap().is_empty(),
        "datasets.metadata populated after conversion: {meta}"
    );
}

/// Every path under `root` whose name ends in [`RETIRED_STORE_DIR_SUFFIX`], recursively.
/// The retired archive was a DIRECTORY, so a leftover one is visible by name without
/// opening anything.
///
/// Its only caller documents why this returns empty for every possible converter on the
/// success path (the run dirs are reclaimed before the assertion runs, and stored bytes
/// are content-addressed blobs). Read that note before treating a green here as evidence.
fn find_retired_store_dirs(root: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(RETIRED_STORE_DIR_SUFFIX) {
                out.push(path.display().to_string());
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-51 [ITEM-38] — the ENV IMAGE no longer installs (or smoke-imports) the store
// library. A SOURCE-level scan of the recipe, for the same reason TEST-19 is one: a
// package removed from a container image is INVISIBLE to any dependency-graph scan of
// the server binary — nothing the server links, loads or declares changes when a wheel
// leaves `/opt/venv`, so the recipe text is the only place the fact exists.
//
// Not rootfs-gated and not a `#[tokio::test]`: it reads a committed file, so it RUNS
// everywhere, including on a host with no rootfs — which is where the rest of this file
// self-skips, and therefore where a half-done deletion would otherwise go unnoticed.
//
// COMMENTS ARE STRIPPED before the assertion. The recipe's prose has to be able to say
// what was removed and why the schema version did NOT bump — forbidding the WORD would
// force that reasoning to be erased along with the dependency, which is the failure mode
// this file's header documents for the assertion it INVERTED rather than deleted.
/// The one forbidden token — the pip/import name of the retired store library. Named once
/// (a test asserting a specific package is absent has to spell it) and referenced from
/// there, so the assertion and its message do not each re-enter the word into the tree.
const STORE_LIBRARY: &str = "tiledbsoma";

#[test]
fn test51_the_env_recipe_neither_installs_nor_imports_the_store_library() {
    // The recipe is DISCOVERED, not spelled: `env-rootfs/<env-id>/` IS the data (W2), and
    // the env-id is declared by a contributed manifest, so hardcoding one here would put a
    // domain name back into the app's test tree to assert something the name is irrelevant
    // to. Same resolution the build helper and `rootfs::version`'s own test use.
    use txresbench::modules::rootfs::version::{
        discover_env_recipes, select_env_recipe_in, ENV_RECIPE_FILE,
    };
    let env_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server dir has a parent")
        .join("env-rootfs");
    let ids = discover_env_recipes(&env_root);
    assert!(
        !ids.is_empty(),
        "the shipped tree has ≥1 env recipe at {}",
        env_root.display()
    );
    // EVERY shipped recipe is asserted on, not just the default: a second env that
    // re-introduced the library would otherwise be invisible here.
    let mut checked = 0usize;
    for id in &ids {
        let recipe = env_root.join(id).join(ENV_RECIPE_FILE);
        let src = std::fs::read_to_string(&recipe)
            .unwrap_or_else(|e| panic!("read {}: {e}", recipe.display()));
        checked += 1;
        assert_one_recipe(&recipe, &src);
    }
    assert_eq!(checked, ids.len(), "every discovered recipe was read");
    // The default selection still resolves (the build helper's path) — so a tree whose
    // recipes all became unselectable cannot pass this test by being unreadable.
    // #191: resolution now consults the tree's DECLARED default (`env-rootfs/DEFAULT_ENV`)
    // rather than the first sorted id, so this reads the tree rather than the id list.
    let selected =
        select_env_recipe_in(&env_root, None).expect("a non-empty tree selects a recipe");
    assert!(ids.contains(&selected));
}

/// Assert ONE discovered recipe neither installs nor imports [`STORE_LIBRARY`], with the
/// positive controls that make each absence an absence.
fn assert_one_recipe(recipe: &std::path::Path, src: &str) {
    let at = recipe.display();
    // Instruction lines only. A `#` inside a Dockerfile string would over-truncate, which
    // can only make this assertion STRICTER (less text searched ⇒ never a false pass) —
    // and the two lines that matter (`uv pip install …`, the `python -c "import …"`
    // smoke) carry none.
    let instructions: String = src
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        !instructions.to_ascii_lowercase().contains(STORE_LIBRARY),
        "{at} still installs or imports `{STORE_LIBRARY}`. ITEM-27 removed the only \
         consumer (it was the transpose BUFFER, not a product), so the image was shipping \
         ~200 MB of native library, plus a build-time import smoke asserting it loads, for \
         nobody. Instruction lines:\n{instructions}"
    );

    // POSITIVE CONTROLS — every assertion above is an absence, and an unreadable file, a
    // moved recipe or an over-eager comment strip would satisfy it for the wrong reason.
    // These prove the scan is looking at a REAL recipe that still installs a REAL stack.
    //
    // #191: the controls are DERIVED FROM THE RECIPE'S OWN PIN FILE rather than spelled.
    // They used to be `uv pip install` plus four python distribution names, which is the
    // shape of exactly ONE recipe — so the moment a second env landed whose interpreter is
    // not python (no venv, no `uv`, none of those four distributions), this control failed
    // a recipe that is perfectly correct. That is the one-recipe-shaped defect the pin
    // had, and the fix is the same: read the property off the tree instead of typing it.
    //
    // What a control has to establish is only that the scan READ a real, non-empty recipe,
    // and every recipe carries its own answer to that beside itself.
    // TEST-P15 / #214-#215. This control used to PARSE the pin file itself — its own
    // `pins.lines()`, its own `split('#')` comment rule, its own `split_once("==")` token
    // rule. A control derived from an unchecked parse of the file it is controlling is the
    // weakest possible control: the very disagreement it would need to detect is the one it
    // would inherit. It now reads the build gate's exported parse
    // (`docs/design/pin-file-single-parse.md`), which is the same parse `cargo check`
    // proved fresh against these exact bytes before this test could run at all.
    let env_root = recipe
        .parent()
        .and_then(|d| d.parent())
        .expect("control: a recipe lives at <env-root>/<id>/Dockerfile");
    let env_id = recipe
        .parent()
        .and_then(|d| d.file_name())
        .and_then(|s| s.to_str())
        .expect("control: a recipe directory has a name");
    let artefact = txresbench::processor_manifest_lint::read_env_pin_artefact(env_root)
        .unwrap_or_else(|e| panic!("control: {e}"));
    let recipe_pins = artefact
        .get(env_id)
        .unwrap_or_else(|| panic!("control: no recipe `{env_id}` in the exported pin parse"));
    let pin_names: Vec<String> = recipe_pins
        .pins
        .iter()
        .map(|p| p.raw_name.clone())
        .collect();
    assert!(
        pin_names.len() >= 5,
        "control: recipe `{env_id}` has {} pin(s) — too thin to control anything",
        pin_names.len()
    );
    assert!(
        instructions.contains("requirements.txt"),
        "control: {at} must install FROM its pin file — otherwise the absence above is \
         'read nothing', not 'removed'"
    );
    // At least a few of the recipe's OWN pinned names must appear in its instruction text
    // (each recipe verifies its installs by name in a build-time smoke). A recipe stripped
    // of every package, or a file the comment strip ate, satisfies neither.
    let named = pin_names.iter().filter(|n| instructions.contains(n.as_str())).count();
    assert!(
        named >= 3,
        "control: only {named} of {} pinned package name(s) appear in {at}'s instruction \
         lines — a recipe that names none of what it installs would pass the assertion \
         above vacuously",
        pin_names.len()
    );
}
