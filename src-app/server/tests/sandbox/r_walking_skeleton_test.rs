//! E6 / #194 — the WALKING SKELETON: the first R analysis this platform executes.
//!
//! Everything here is proven BY RUNNING. Not one assertion is a predicate over source
//! text: each one drives the real server, the real job path, the real `env_image`
//! provider, real `squashfuse` + `bwrap`, and reads the result back out of the real
//! object store over the real API.
//!
//! ## What each test is for
//!
//! | test | id | asserts |
//! |---|---|---|
//! | `the_declared_r_env_reaches_the_run_and_its_digest_reaches_provenance` | TEST-1 `[acceptance]` `[invariant: INV-3]` | the whole chain, and that provenance names the **R** image |
//! | `the_r_run_produces_values_only_r_could_have_computed` | TEST-2 `[acceptance]` `[invariant: INV-5]` | the artifact the platform reads back could only have come from R — and the skeleton's declared surface is exactly its `Provides` |
//! | `an_r_analysis_is_refused_by_name_when_only_the_python_env_is_staged` | TEST-3 `[acceptance]` `[invariant: INV-2]` | the pre-#189 substitution defect, refused by name, with a positive control |
//! | `an_operator_override_into_the_python_image_fails_closed` | TEST-4 | Arm B of DEC-7: it fails, catalogs nothing, and is attributed |
//! | `a_python_analysis_in_the_same_process_pins_the_python_image` | TEST-5 `[acceptance]` `[invariant: INV-1]` | the python path is unaffected, in the process where a global would have leaked |
//! | `an_r_entry_exiting_zero_without_a_manifest_fails_the_job` | TEST-8 | the language-agnostic output contract really applies to an R producer |
//!
//! ## The seam this tier runs on, and why it is not a shortcut
//!
//! The R image is BUILT LOCALLY (E5 / #193, `just env-rootfs-local --all`) and is not
//! published — publishing is gated (#80 / #217). So the runtime reaches it through the
//! ENV-SCOPED air-gap seam `TXR_ENV_ROOTFS_SQUASHFS__<env-id>`, which is the production
//! mechanism for an air-gapped deployment, not a test hook: `provide()` hashes the file,
//! stages it into the content-digest cache and mounts it by digest, exactly as the OCI
//! path does after a pull. Run this tier as:
//!
//! ```text
//! sh scripts/build-env-rootfs-local.sh --print-seam     # emits the exact prefix
//! env '<...>' '<...>' cargo test -p txresbench --test integration_tests \
//!     sandbox::r_walking_skeleton -- --test-threads=1
//! ```
//!
//! `--print-seam` emits one `env(1)` assignment per env that is STAGED, each pointing at
//! that env's artifact and each re-verified against the sha256 the build loop recorded
//! beside it — so the command names no env, exactly as the assertions below do not.
//! `env(1)` is required, not stylistic: an env id contains `-`, so the variable name is
//! not a legal shell identifier and neither `export` nor an assignment prefix can set it.
//!

//! Every gate below records a self-skip through the shared ledger
//! (`record_skip`) rather than passing quietly, and `TXR_TEST_NO_SKIP=1` turns each into
//! a hard failure — which is the mode this tier's acceptance run uses.
//!
//! ## Nothing here names an env, a package or an analysis by literal
//!
//! Not in an assertion, and not in the prose either. Which env is "the R env" is DERIVED
//! from the shipped registry — it is the env declared by the one shipped analysis whose
//! `run.runtime` resolves to R — and the digests compared against are COMPUTED from the
//! staged artifacts. That is `per_job_env_test.rs`'s discipline, and it is what makes
//! these tests fail if the DECLARATION moves rather than if a string changes. It is also
//! what keeps a domain vocabulary out of the app's own test tier
//! (`lint-no-domain-in-builtin.mjs`), which is a rule this file has no reason to be an
//! exception to.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use uuid::Uuid;

use txresbench::modules::jobs::repository::JobRepository;

use super::setup_admin;
use crate::common::TestServer;
use crate::dataset::hardening_common::{
    create_project, pinned_env_digest, pool_for, record_skip, rootfs_gate,
};

/// The STRUCTURED fields `env_image.rs` emits when it refuses to serve a rootfs staged
/// for a different env than the one requested. One field per env, under DISTINCT keys.
///
/// **Why the keyed fields and not the typed error code.** `env_image::provide()` raises
/// `ENV_IMAGE_STAGED_ENV_MISMATCH`, and `local_bwrap.rs` deliberately passes that family
/// through UNWRAPPED so the naming survives — but the in-pod executor prints only the
/// error's MESSAGE, and on a staging failure it writes no `jobs.error` row at all. So the
/// code never reaches any channel a test (or an operator) can read on this path. The
/// first version of this test asserted the code anyway and went red for that reason,
/// which is the assertion doing its job: it refused to accept `some failure` as `this
/// failure`.
///
/// What IS observable is the refusal's own structured log line, which names both envs
/// under separate keys — and separate keys are what makes "both are named" checkable at
/// all here, since one env id is a PREFIX of the other.
const REFUSAL_REQUESTED_KEY: &str = "requested_env";
const REFUSAL_STAGED_KEY: &str = "staged_env";

/// Strip ANSI SGR sequences. The subprocess writes styled `tracing` output, so a field
/// name and its `=` are separated by escapes (`staged_env\x1b[0m\x1b[2m=\x1b[0m…`) and a
/// naive `contains("staged_env=")` finds nothing. This is a terminal-escape transform,
/// not a grammar for anything in the payload.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI … final byte in @-~ ; anything else we just drop the escape itself.
            if chars.peek() == Some(&'[') {
                chars.next();
                for f in chars.by_ref() {
                    if ('@'..='~').contains(&f) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The value of `key=` in `haystack`, up to the next whitespace — EXACT, so
/// `staged_env=<x>` cannot be satisfied by `staged_env=<x>-r`.
fn logged_field<'a>(haystack: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{key}=");
    let start = haystack.find(&needle)? + needle.len();
    let rest = &haystack[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    // A key PRESENT WITH AN EMPTY VALUE reads back as `Some("")`, not `None`. That looks
    // like the weaker choice and is the safe one, because the two callers want opposite
    // things from it and only this direction is safe for BOTH:
    //   * TEST-4 asserts `.is_none()` to prove the staging refusal did NOT fire. `Some("")`
    //     keeps that gate biting on a refusal that fired with a blank value; `None` would
    //     make a refusal that DID fire read as one that did not — a false green on the
    //     assertion whose whole job is to prove the override took effect.
    //   * TEST-3 asserts `.is_some()` and then `assert_eq!`s the value, so a `Some("")`
    //     there fails at the equality with the right message. The `is_some()` pre-gate is
    //     only there to give a better diagnosis when the fields are absent entirely.
    // An earlier cut returned `None` for an empty value and justified it with TEST-4's
    // gate, having the direction exactly backwards.
    Some(&rest[..end])
}

/// The two readers above carry the exactness this file's whole refusal assertion rests
/// on, so they are tested rather than trusted — and tested against the SHAPE that
/// defeated the first version: an env id that is a strict prefix of another.
#[test]
fn the_log_field_reader_is_exact_and_escape_tolerant() {
    // A real styled `tracing` line: the field name and its `=` are separated by escapes.
    let styled = "\u{1b}[31mERROR\u{1b}[0m refusing \u{1b}[3mrequested_env\u{1b}[0m\u{1b}[2m=\u{1b}[0mfoo-r                   \u{1b}[3mstaged_env\u{1b}[0m\u{1b}[2m=\u{1b}[0mfoo \u{1b}[3mseam\u{1b}[0m\u{1b}[2m=\u{1b}[0mX";
    let clean = strip_ansi(styled);
    assert!(!clean.contains('\u{1b}'), "every escape is gone: {clean:?}");
    assert_eq!(logged_field(&clean, "requested_env"), Some("foo-r"));
    // THE POINT: `foo` is a strict prefix of `foo-r`, and this must still read `foo`.
    assert_eq!(logged_field(&clean, "staged_env"), Some("foo"));
    // A key that is not there is `None`. (The `assert_eq!` above already pins the value,
    // so an `assert_ne!` against the sibling id would be implied by it and could never
    // independently go red — one was written here and is deleted rather than kept as
    // decoration, in a test whose whole subject is assertions that cannot fail.)
    assert_eq!(logged_field(&clean, "no_such_key"), None);
    // A key PRESENT WITH AN EMPTY VALUE is `Some("")`, NOT `None` — see the function's
    // own comment for why that is the only direction safe for both callers. Pinned here
    // because it is the kind of "obviously tidier" change that would silently relax
    // TEST-4's `is_none()` gate.
    assert_eq!(logged_field("a= b=x", "a"), Some(""));
    assert_eq!(logged_field("a= b=x", "b"), Some("x"));
    // The value runs to whitespace, not to the end of the line.
    assert_eq!(logged_field(&clean, "seam"), Some("X"));
}

// ───────────────────────────── derived facts, never literals ─────────────────────────

/// The one shipped analysis whose `run.runtime` resolves to R, read off the process-global
/// extension registry that `TestServer::spawn` publishes exactly as boot does.
///
/// DERIVED on purpose. An assertion comparing one hardcoded id to another hardcoded id
/// proves that two strings in this file agree with each other. This proves the SHIPPED
/// TREE declares an R analysis and follows its own declaration — so renaming the package,
/// or dropping the `env:` key, turns these tests red, which is the whole point of the
/// item.
pub(crate) struct ShippedR {
    pub analysis_id: String,
    pub env_id: String,
    pub package: String,
    pub entry: String,
    /// The manifest's `run.runtime` VERBATIM — what the frontend puts on the wire as the
    /// spec's `language` (`workbench.ts::buildProcessSpec`, `jobsCapability.ts`), so the
    /// specs below are the ones a real launch produces rather than a shape invented here.
    pub runtime: String,
    /// Whether this is the deliberately meaningless probe — `launchable: false`. See
    /// `is_the_meaningless_probe`.
    pub is_probe: bool,
}

/// The analysis these tests are ABOUT, identified by a STRUCTURAL PROPERTY rather than by
/// its id.
///
/// #194 shipped exactly one R analysis and this file said so; it also planted the
/// singularity assertion below and addressed it to whoever landed a second. That second one
/// has landed, so the assertion is retired the way its own message instructed — by GIVING
/// THIS FILE AN EXPLICIT SUBJECT, not by relaxing it to `.first()`. Every test here probes
/// the WALKING SKELETON specifically: it takes `a`/`b`/`draws` params, emits an opaque HTML
/// report, and its whole purpose is to be a deliberately meaningless environment probe. None
/// of that is true of a real analysis, so retargeting by registry order would have made six
/// tests silently assert about something else.
///
/// The subject is `launchable: false` — the key the skeleton declares precisely BECAUSE a
/// meaningless probe offered against every dataset in every user's launcher is a product
/// defect. A real analysis is launchable, so this separates them on a property of what the
/// subject IS rather than on what it is called.
///
/// It is deliberately NOT a package-id literal. This file is app-tier, and
/// `lint-no-domain-in-builtin` forbids the app carrying an analysis-domain id at all — the
/// domain lattice is DATA. Spelling one here would have been a domain leak in the app, in
/// exactly the file whose header says "derived facts, never literals".
fn is_the_meaningless_probe(a: &txresbench::modules::extensions::types::AnalysisContributionData) -> bool {
    !a.rest
        .get("launchable")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

pub(crate) fn shipped_rscript_analysis() -> Option<ShippedR> {
    use txresbench::modules::sandbox::spec::Language;
    let reg = txresbench::modules::extensions::try_registry()?;
    let mut found: Vec<ShippedR> = Vec::new();
    for m in reg.all() {
        for a in &m.contributes.analyses {
            let Some(run) = a.run() else { continue };
            if !matches!(Language::from_runtime(&run.runtime), Some(Language::Rscript)) {
                continue;
            }
            // A DECLARING R analysis is the subject; one that declares no env would resolve
            // to the deployment default, which is not what any assertion here is about.
            // `continue` rather than propagate: a second, env-less R analysis must not make
            // this function answer `None` and turn every test below into a false skip
            // reading "no R analysis exists".
            let Some(env_id) = a.env.clone().filter(|e| !e.trim().is_empty()) else { continue };
            found.push(ShippedR {
                is_probe: is_the_meaningless_probe(a),
                analysis_id: a.id.clone(),
                env_id,
                package: m.id.clone(),
                entry: run.entry.clone(),
                runtime: run.runtime.clone(),
            });
        }
    }
    // ── THE SUBJECT IS IDENTIFIED, NOT COUNTED (retired here) ─────────────────────
    //
    // This used to be `assert!(found.len() <= 1, …)`, and its message said: "Before landing
    // [a second R analysis]: give this file an explicit subject (take the analysis id as a
    // parameter, or assert on the one you mean), then delete this assertion. Do NOT relax
    // it to `.first()`." That is what happened; `is_the_meaningless_probe` above is the
    // subject, and the selection below is by that property rather than by position, so
    // registry order cannot move it.
    //
    // The FLOOR the assertion protected is kept, inverted: it is still an error for the
    // tree to stop declaring the subject, and that error still names the TREE rather than
    // the host — a self-skip here would report "this box cannot run R" for a missing
    // package.
    let n_declared = found.len();
    let picked = found.into_iter().find(|r| r.is_probe);
    assert!(
        picked.is_some(),
        "the shipped tree declares {n_declared} R analyses, none of them the deliberately \
         non-launchable environment probe every test in this file is written about. That is \
         a property of the TREE, not of this host: either the probe was removed or made \
         launchable, or the registry did not load."
    );
    picked
}

/// Every env id the RECIPE TREE declares, read off disk — the same derivation
/// `env_image_oci_test.rs` uses, and the same one `build-env-rootfs-local.sh` uses.
///
/// This exists so no test here derives "the env that is not the R one" from
/// `env_image::default_env_id()`. That function consults the process-global
/// settings-cache snapshot, which ANOTHER test in this binary can move (the restored R
/// probe does exactly that) — so a test that read it would be order-dependent, and would
/// silently compare the R env against itself.
fn recipe_env_ids() -> Vec<String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
    let mut ids: Vec<String> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read the recipe tree at {}: {e}", root.display()))
        .flatten()
        .filter(|e| e.path().join("Dockerfile").is_file())
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .collect();
    ids.sort();
    ids
}

/// A STAGED env that is NOT `env_id` — the "wrong image" every control below uses.
/// Derived from the recipe tree, never from a mutable deployment setting.
fn other_staged_env(env_id: &str) -> Option<String> {
    recipe_env_ids()
        .into_iter()
        .find(|id| id != env_id && staged_artifact(id).is_some())
}

/// A shipped analysis that declares NO env — the INV-1 control subject. Also derived.
fn shipped_env_less_python_analysis() -> Option<(String, String, String)> {
    use txresbench::modules::sandbox::spec::Language;
    let reg = txresbench::modules::extensions::try_registry()?;
    for m in reg.all() {
        for a in &m.contributes.analyses {
            let Some(run) = a.run() else { continue };
            if !matches!(Language::from_runtime(&run.runtime), Some(Language::Python)) {
                continue;
            }
            if a.env.is_some() {
                continue;
            }
            return Some((a.id.clone(), m.id.clone(), run.entry.clone()));
        }
    }
    None
}

/// The per-env air-gap seam variable for `env_id` (`env_image.rs` `SEAM_KEYS[0]` +
/// `ENV_SEAM_SUFFIX`), spelled once here so no test builds the name a second way.
pub(crate) fn seam_var(env_id: &str) -> String {
    format!("TXR_ENV_ROOTFS_SQUASHFS__{env_id}")
}

/// The artifact the seam for `env_id` points at, if it is set AND the file is there.
pub(crate) fn staged_artifact(env_id: &str) -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var_os(seam_var(env_id))?);
    p.is_file().then_some(p)
}

/// The content digest `provide()` will record for the artifact at `path` — computed from
/// the BYTES, so the comparison in TEST-1 is against the file the run actually mounted
/// and not against a number typed into this file.
fn sha256_of(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).expect("read the staged rootfs artifact");
    let mut h = Sha256::new();
    h.update(&bytes);
    hex::encode(h.finalize())
}

/// The emitted-field prefix that marks a LIBRARY's resolved version.
///
/// **Why a prefix and not `*_version`.** The first cut of this check looked for any
/// `id="<name>_version"` field and was VACUOUS: the artifact carries `id="r_version"` —
/// the INTERPRETER's own version, emitted unconditionally — which satisfies that shape
/// whether or not any library version was ever recorded. Mutation-proven by a blind
/// auditor: deleting the library row entirely left the artifact with zero mentions of the
/// library and this assertion still green.
///
/// The package's source-side test shares this constant's value (its `LIB_VERSION_KEY`),
/// and the two check different things: that one checks every library the entry LOADS is
/// one it emits a key for; this one checks a key actually reached the BYTES.
const LIB_VERSION_KEY: &str = "lib_version:";

/// Does the artifact carry a LIBRARY version field? Names no library: which libraries an
/// R entry loads is the package's business, and pinning one here would make a package
/// edit fail a platform test.
fn has_library_version_field(body: &str) -> bool {
    body.contains(&format!("id=\"{LIB_VERSION_KEY}"))
}

/// Wait for the framework-owned OUTPUT CONFORMANCE gate to record its verdict against
/// `run`, and return the line it wrote.
///
/// **Why this is asserted at all, and why it matters most for an R producer.** The gate
/// (`packages/_lib/conformance.py`, dispatched by `jobs::conformance`) is the BOUND on
/// DEC-2's weakening: an R entry stages no app helpers, and the reason that is acceptable
/// is that the OUTPUT gate runs outside the processor's process, over `/outputs`, after
/// the job exits — so it is language-agnostic by construction and an R producer inherits
/// it unchanged. That claim was prose in two doc comments and asserted nowhere: if the
/// gate silently never ran over the R artifact, or ran and condemned it, every other
/// assertion in this file still passed.
///
/// The gate is DETACHED (`dispatch_after_ingest` spawns it), so this polls the producing
/// run's own `job_logs` — the channel that module documents as where an operator meets
/// the verdict — rather than racing it.
async fn conformance_verdict(pool: &sqlx::SqlitePool, run: Uuid, budget_secs: u64) -> Option<String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(budget_secs);
    loop {
        let line: Option<String> = sqlx::query_scalar(
            "SELECT content FROM job_logs WHERE job_id = $1 AND content LIKE 'conformance:%' \
             ORDER BY seq DESC LIMIT 1",
        )
        .bind(run)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        if line.is_some() {
            return line;
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}


// ───────────────────────────────── the tier gate ─────────────────────────────────────

/// `Some(ShippedR)` when this host can genuinely run an R analysis: the shipped tree
/// declares one, BOTH envs are staged through their per-env seams, and the sandbox can
/// actually execute (a real PID namespace).
///
/// It records a skip naming the ONE thing that was missing, never a catch-all — a skip
/// reason has to be TRUE of the box it is printed on, or the ledger misdirects the next
/// reader.
async fn r_tier_gate(server: &TestServer, admin: &str, test: &str) -> Option<ShippedR> {
    let Some(r) = shipped_rscript_analysis() else {
        // NOT a skip. The shipped tree either declares an R analysis or this whole item
        // did not land; reporting that as an environmental gate would be the false-reason
        // failure `stage_second_env_image` documents at length.
        panic!(
            "{test}: no shipped analysis declares an `rscript` runtime. That is a property \
             of the TREE, not of this host — E6/#194 ships one. A self-skip here would \
             report 'this box cannot run R' for a missing package."
        );
    };
    if staged_artifact(&r.env_id).is_none() {
        record_skip(
            test,
            &format!(
                "the R env `{}` is not staged: set `{}` to a locally built rootfs \
                 (`just env-rootfs-local --env {} --print-seam` emits the exact `env(1)` \
                 prefix). The image is not published (#80/#217), so the local loop is the \
                 only route.",
                r.env_id,
                seam_var(&r.env_id),
                r.env_id
            ),
        );
        return None;
    }
    if rootfs_gate(server, admin).await.is_none() {
        record_skip(
            test,
            "the sandbox cannot execute on this host (no real PID namespace, or no rootfs \
             mounted) — the analysis would never reach `Rscript`",
        );
        return None;
    }
    Some(r)
}

// ────────────────────────────── shared run plumbing ──────────────────────────────────

/// The params the skeleton's entry reads. `a`/`b` produce a PRODUCT that appears nowhere
/// in the request; `seed`/`draws` produce an R-specific RNG draw that likewise does not.
fn probe_params(a: i64, b: i64, seed: i64, draws: i64) -> Value {
    json!({ "a": a, "b": b, "draws": draws, "seed": seed })
}

/// Submit an analysis through the REAL `POST /jobs` enqueue path and wait for a terminal
/// state. Returns `(job_id, status)`. Unlike `hardening_common::run_real_analysis` this
/// does NOT panic on a non-`completed` status — three of the tests below are about the
/// failure paths.
async fn submit_and_wait(
    server: &TestServer,
    token: &str,
    pool: &sqlx::SqlitePool,
    project: Uuid,
    name: &str,
    spec: Value,
) -> (Uuid, String) {
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({ "job_type": "analysis", "name": name, "params": spec, "project_id": project }))
        .send()
        .await
        .expect("submit analysis");
    assert_eq!(resp.status().as_u16(), 201, "analysis job enqueued");
    let job: Value = resp.json().await.unwrap();
    let id = Uuid::parse_str(job["id"].as_str().unwrap()).unwrap();
    let status = crate::dataset::hardening_common::wait_terminal(
        pool,
        id,
        std::time::Duration::from_secs(600),
    )
    .await;
    (id, status)
}

async fn job_error_and_logs(pool: &sqlx::SqlitePool, id: Uuid) -> String {
    let err: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .ok()
        .flatten();
    let logs: Vec<(String, String)> = sqlx::query_as(
        "SELECT stream, content FROM job_logs WHERE job_id = $1 ORDER BY seq DESC LIMIT 80",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let body: String = logs
        .iter()
        .rev()
        .map(|(s, c)| format!("[{s}] {c}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("job.error={err:?}\n--- logs ---\n{body}")
}

async fn artifact_ids(pool: &sqlx::SqlitePool, run: Uuid) -> Vec<(Uuid, String)> {
    sqlx::query_as("SELECT id, output_id FROM artifacts WHERE run_id = $1 ORDER BY output_id")
        .bind(run)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
}

/// Read an artifact's bytes back THROUGH THE PLATFORM (`GET /artifacts/{id}/data`) rather
/// than off the filesystem. "An artifact the platform can read back" is the claim; going
/// around the platform would not test it.
async fn artifact_bytes(server: &TestServer, token: &str, id: Uuid) -> String {
    let resp = server
        .client
        .get(server.api_url(&format!("/artifacts/{id}/data")))
        .bearer_auth(token)
        .send()
        .await
        .expect("fetch artifact data");
    assert_eq!(resp.status().as_u16(), 200, "the platform serves the R run's artifact");
    resp.text().await.expect("artifact body")
}

/// Run `txresbench run-job --job-id <id>` as a subprocess against the test server's DB +
/// data dir, with `mutate` applied to its environment first.
///
/// The subprocess is what makes the ENV controllable per test: a `TestServer` inherits
/// this process's environment at spawn and cannot be re-pointed afterwards, so the arms
/// that need a seam REMOVED (TEST-3) or an operator override SET (TEST-4) drive the same
/// in-pod executor the Kubernetes backend runs, with exactly the environment under test.
/// This is `jobrun_inpod_test.rs`'s mechanism, parameterized.
async fn run_job_subprocess_with(
    server: &TestServer,
    job_id: Uuid,
    mutate: impl FnOnce(&mut tokio::process::Command),
) -> (i32, String) {
    let bin = env!("CARGO_BIN_EXE_txresbench");
    let data_dir = server.data_dir();
    let cfg = write_run_job_config(data_dir, server.database_url());

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["run-job", "--job-id", &job_id.to_string()])
        .env("CONFIG_FILE", &cfg)
        .env("TXR_APP_DATA_DIR", data_dir)
        .env("TXR_SCHEDULER_ENABLED", "off");
    mutate(&mut cmd);
    let out = cmd.output().await.expect("spawn txresbench run-job");
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    eprintln!("--- run-job output ---\n{combined}");
    (out.status.code().unwrap_or(-1), combined)
}

/// A minimal `config.yaml` pointing the `run-job` subprocess at the test server's
/// Postgres. Same shape as `jobrun_inpod_test.rs`'s (that module owns its own copy; this
/// one is not shared because the two files are independently runnable and a shared helper
/// in `tests/sandbox/mod.rs` would be a change to a file three other modules read).
fn write_run_job_config(dir: &Path, database_url: &str) -> PathBuf {
    let rest = database_url
        .strip_prefix("postgresql://")
        .or_else(|| database_url.strip_prefix("postgres://"))
        .expect("a postgres URL");
    let (creds, hostpart) = rest.split_once('@').expect("user@host");
    let (user, pass) = creds.split_once(':').unwrap_or((creds, ""));
    let hostpart = hostpart.split(['?']).next().unwrap();
    let (host_port, db) = hostpart.split_once('/').expect("host/db");
    let (host, port) = host_port.split_once(':').unwrap_or((host_port, "5432"));
    let cfg = format!(
        "postgresql:\n  use_embedded: false\n  external:\n    host: \"{host}\"\n    port: {port}\n    username: \"{user}\"\n    password: \"{pass}\"\n    database: \"{db}\"\n  pool:\n    max_connections: 5\n    min_connections: 1\n    acquire_timeout_secs: 5\n    idle_timeout_secs: 30\n    max_lifetime_secs: 300\nserver:\n  host: \"127.0.0.1\"\n  port: 3198\n  api_prefix: \"/api\"\nlogging:\n  level: \"info\"\n  format: \"pretty\"\njwt:\n  secret: \"r-walking-skeleton-test-secret-key-at-least-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
    );
    let path = dir.join(format!("probe-run-job-{}.yaml", Uuid::new_v4()));
    std::fs::write(&path, cfg).expect("write config");
    path
}

/// Insert an already-claimed (`running`) analysis job carrying `params` verbatim — the
/// state the control plane leaves a job in when it hands it to a job-per-run pod.
async fn running_job(
    pool: &sqlx::SqlitePool,
    owner: Uuid,
    project: Option<Uuid>,
    params: Value,
) -> Uuid {
    let repo = JobRepository::new(pool.clone());
    let id = Uuid::new_v4();
    repo.create_running_under_cap(id, owner, "analysis", "walking-skeleton-run", params, project, 100_000)
        .await
        .expect("insert running job")
        .expect("under cap");
    id
}

async fn owner_id(pool: &sqlx::SqlitePool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE username = 'sbxadmin'")
        .fetch_one(pool)
        .await
        .expect("the setup-admin owner id")
}

// ══════════════════════════════════ TEST-1 ═══════════════════════════════════════════

const T1: &str = "sandbox::r_walking_skeleton::declared_env_to_provenance";

/// TEST-1 `[acceptance]` `[invariant: INV-3]` — the whole chain, by running it.
///
/// The hops, each asserted rather than assumed:
///
/// 1. **manifest → spec.** The request body carries a DELIBERATELY WRONG env — the
///    deployment default, i.e. the one a caller would most plausibly send. `POST /jobs` re-derives the env from the registry for the
///    named `analysis_id` and writes it over the request (`jobs/routes.rs`, DEC-4), so the
///    STORED `jobs.params.env` — read back from the DB — must be the R env. This is both
///    the manifest→run hop and the security boundary, in one observation.
/// 2. **spec → ComputeSpec → provide() → mount → bwrap.** The job reaches `completed`,
///    which on this path is only reachable by `Rscript /code/entry.R` exiting 0 inside the
///    mounted rootfs and the host ingesting `/outputs`.
/// 3. **run → provenance.** `provenance_run_repro.env_rootfs_sha256` equals the sha256 of
///    the artifact the R seam points at, and does NOT equal the python one. Both expected
///    values are COMPUTED from the staged files.
///
/// The negative half of hop 3 is not decoration: it is the pre-#189 defect
/// (`provide()` taking `env_id` and never reading it), whose symptom is "R is broken" and
/// whose cost is the next person debugging the image instead of the resolver.
#[tokio::test]
async fn the_declared_r_env_reaches_the_run_and_its_digest_reaches_provenance() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let Some(r) = r_tier_gate(&server, &token, T1).await else {
        return;
    };
    let project = create_project(&server, &token, "probe-end-to-end").await;

    // The env that is NOT the R one — the WRONG value the caller sends. Derived from the
    // RECIPE TREE, NOT from `default_env_id()`: that reads the process-global settings
    // snapshot, which another test in this binary moves, so a control built on it would be
    // order-dependent and could silently compare the R env against itself.
    //
    // It does NOT have to be STAGED. The enqueue path overwrites this key before anything
    // runs, which is the whole point of hop 1 — so requiring a second staged image here
    // would abandon the end-to-end proof, the provenance assertion and the conformance
    // verdict on a box that happens to have only the R env. (An earlier cut did exactly
    // that: a `record_skip` for want of a control that only ONE assertion needs.) A
    // second RECIPE is enough; falling back to a well-formed id that names no recipe is
    // enough after that, because a value the enqueue path must DISCARD need not resolve.
    let other_env = recipe_env_ids()
        .into_iter()
        .find(|id| id != &r.env_id)
        .unwrap_or_else(|| "fixture-not-the-declared-env".to_string());
    assert_ne!(other_env, r.env_id, "the wrong value must differ from the right one");
    assert!(
        shipped_env_less_python_analysis().is_some(),
        "the tree still ships an env-LESS python analysis — the subject of TEST-5's INV-1 \
         control"
    );

    let spec = json!({
        // `language` is what the FE puts on the wire for a sandbox run — it is the
        // manifest's own `run.runtime`, passed through (`buildProcessSpec`). Taken from
        // the registry so this spec is the one a real launch produces.
        "language": r.runtime,
        "analysis_id": r.analysis_id,
        "package": r.package,
        "code_ref": r.entry,
        "params": probe_params(6, 7, 20_260_903, 8),
        "seed": 20_260_903,
        // DELIBERATELY WRONG. The enqueue path must overwrite it from the registry.
        "env": other_env,
    });
    let (job, status) = submit_and_wait(&server, &token, &pool, project, "r-probe", spec).await;
    assert_eq!(
        status,
        "completed",
        "the R analysis completes end to end.\n{}",
        job_error_and_logs(&pool, job).await
    );

    // ── hop 1: the STORED spec carries the env the MANIFEST declares ────────────────
    let stored: Value = sqlx::query_scalar("SELECT params FROM jobs WHERE id = $1")
        .bind(job)
        .fetch_one(&pool)
        .await
        .expect("the stored job params");
    assert_eq!(
        stored["env"].as_str(),
        Some(r.env_id.as_str()),
        "the enqueue path must DERIVE the env from the registry for `{}` and overwrite \
         the caller-supplied `{other_env}` (DEC-4). Stored params: {stored}",
        r.analysis_id
    );

    // ── hop 3: provenance names the R image, and not the python one ─────────────────
    let r_sha = sha256_of(&staged_artifact(&r.env_id).expect("the R seam"));
    let pinned = pinned_env_digest(&pool, job, T1)
        .await
        .expect("a completed sandbox run records its env digest");
    assert_eq!(
        pinned, r_sha,
        "provenance must record the digest of the R image THIS RUN mounted (INV-3)"
    );
    // The NEGATIVE half of INV-3's control — "…and NOT the sibling image's digest" — is
    // the LAST thing this test does, after every other assertion, precisely so that a host
    // which cannot run it loses ONLY that half. It is inline at the tail of this function,
    // not a helper; look for the `record_skip(T1, "PARTIAL: …")`.

    // ── the run really produced a kind-typed artifact the platform cataloged ────────
    let arts = artifact_ids(&pool, job).await;
    assert_eq!(arts.len(), 1, "one cataloged output: {arts:?}");
    let (art_id, output_id) = &arts[0];
    assert_eq!(output_id, "probe");
    let datatype: String = sqlx::query_scalar("SELECT datatype FROM artifacts WHERE id = $1")
        .bind(art_id)
        .fetch_one(&pool)
        .await
        .expect("the artifact's datatype");
    assert_eq!(
        datatype, "report/html",
        "the R producer's declared kind survived ingest — the `/outputs/manifest.json` it \
         wrote is the canonical OutputsManifest the host reads"
    );

    // ── THE BOUND ON DEC-2, ASSERTED RATHER THAN CLAIMED ───────────────────────────
    //
    // An R entry stages NO app helpers. That weakening is acceptable ONLY because the
    // framework-owned OUTPUT gate runs outside the processor's process, over `/outputs`,
    // after the job exits — language-agnostic by construction. Until now that was prose.
    // Here the verdict is read: the gate must have RUN over an R producer's artifact and
    // must have said OK.
    //
    // Note what this proves in passing: the gate itself is a PYTHON job
    // (`verify_conformance.py`) dispatched over an R run's outputs. The two languages meet
    // exactly where §4.1 says they should — at the emitted bytes, not inside a process.
    let verdict = conformance_verdict(&pool, job, 240)
        .await
        .expect(
            "the output conformance gate recorded NO verdict for the R run within its \
             budget. `conformance: …` on the producing run's log is where an operator \
             meets it, and a run with no line at all is the state DEC-2's bound cannot be \
             checked in — it is not evidence of conformance",
        );
    assert!(
        verdict.contains("OK"),
        "the framework-owned output gate did not pass the R producer's artifact. This is \
         the claim that BOUNDS DEC-2's weakening (`an R entry stages nothing`), so a \
         FAILED or NOT VERIFIED verdict here means the weakening is unbounded: {verdict}"
    );
    // A BACKSTOP, and named as one rather than dressed up as the discriminator: the
    // `NOT VERIFIED` line contains no `OK`, so the assertion above already excludes it
    // today. This exists so that a future wording which put both words in one line could
    // not slip an UNCHECKED artifact through as a verified one.
    assert!(
        !verdict.contains("NOT VERIFIED"),
        "the gate ran but checked NOTHING — an unchecked artifact must not read as a \
         verified one (`jobs::conformance` keeps the three outcomes apart): {verdict}"
    );

    // ── INV-3's NEGATIVE half, LAST, and never silently ────────────────────────────
    //
    // `pinned == r_sha` says the run recorded a digest that happens to equal the R
    // image's. The control that makes it mean something is that it does NOT equal the
    // SIBLING image's — that is the literal pre-#189 substitution defect.
    //
    // It needs a second STAGED image, which not every host has, and the two obvious ways
    // to handle that are both wrong and were both tried:
    //   * skip the WHOLE test (an earlier cut) — abandons the end-to-end proof, the
    //     provenance positive and the conformance verdict for want of one control;
    //   * fall back to an unstaged id and let an `if let` quietly not run (the next cut) —
    //     turns a loud, ledgered gate into a SILENT no-op, which is strictly worse.
    // So it sits LAST, after everything else has asserted, and its absence is RECORDED:
    // `record_skip` lands in the ledger and PANICS under `TXR_TEST_NO_SKIP=1`, which is
    // the mode the acceptance tier runs in and where both envs are staged.
    let Some(other) = staged_artifact(&other_env) else {
        record_skip(
            T1,
            "PARTIAL: every assertion above ran, but INV-3's NEGATIVE control did not — no \
             SECOND env is staged, so there is no sibling digest for the recorded one to \
             be distinguished FROM. Stage both (`sh scripts/build-env-rootfs-local.sh \
             --all`) and set both per-env seams.",
        );
        return;
    };
    let other_sha = sha256_of(&other);
    assert_ne!(
        other_sha, r_sha,
        "the two staged artifacts are identical, so the assertion below cannot fail — the \
         control is vacuous"
    );
    assert_ne!(
        pinned, other_sha,
        "the run recorded the SIBLING image's digest for an analysis that declares the R \
         env. This is the pre-#189 substitution defect: its symptom is `R is broken` and \
         its cause is the resolver."
    );
}

// ══════════════════════════════════ TEST-2 ═══════════════════════════════════════════

const T2: &str = "sandbox::r_walking_skeleton::r_only_evidence";

/// TEST-2 `[acceptance]` `[invariant: INV-5]` — the artifact could only have come from R,
/// and the skeleton's surface is exactly its declared `Provides`.
///
/// A job that merely SUCCEEDS proves the platform ran something. These assertions prove
/// it ran **R**, in the **R image**, on **this request**:
///
/// * `R version <n>.<n>` — a string that appears nowhere in the request and that no python
///   interpreter emits.
/// * the PRODUCT `a*b` — present, while the operands' source expression is absent. The
///   surviving python probe's discipline (`6*7 → 42`), applied to an artifact.
/// * R's own RNG draw for the request's seed — and the value NumPy would have produced for
///   that same seed is asserted ABSENT. That control is what makes "only R" mean something
///   rather than being a claim about a number.
///
/// It runs the analysis TWICE with DIFFERENT operands and DIFFERENT seeds, and requires
/// the two artifacts to differ accordingly. Without that, every assertion here would pass
/// against a canned file: the second run is what makes them range over the request.
#[tokio::test]
async fn the_r_run_produces_values_only_r_could_have_computed() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let Some(r) = r_tier_gate(&server, &token, T2).await else {
        return;
    };
    let project = create_project(&server, &token, "probe-evidence").await;

    // Two DIFFERENT requests. The expected R values were obtained by running R itself
    // inside this recipe's image; a future R whose generator changes turns this red, which
    // is the correct and loud outcome for a value that is a property of the interpreter.
    //
    // The python column is the CONTROL: `numpy.random.seed(s); randn(n).sum()` for the same
    // seed and count. R and NumPy both use a Mersenne-Twister, and they still disagree —
    // R draws normals by INVERSION, NumPy by the polar method — which is exactly why this
    // discriminates the interpreter rather than the seed.
    let cases: [(i64, i64, i64, i64, &str, &str); 2] = [
        (6, 7, 20_260_903, 8, "1.411273495", "3.115683525"),
        (13, 17, 31_337, 5, "1.460114226", "-0.567348651"),
    ];

    let mut bodies: Vec<String> = Vec::new();
    for (a, b, seed, draws, r_draw, py_draw) in cases {
        let spec = json!({
            "language": r.runtime,
            "analysis_id": r.analysis_id,
            "package": r.package,
            "code_ref": r.entry,
            "params": probe_params(a, b, seed, draws),
            "seed": seed,
        });
        let (job, status) =
            submit_and_wait(&server, &token, &pool, project, "r-evidence", spec).await;
        assert_eq!(
            status,
            "completed",
            "the R probe completes for a={a} b={b} seed={seed}.\n{}",
            job_error_and_logs(&pool, job).await
        );
        let arts = artifact_ids(&pool, job).await;
        assert_eq!(arts.len(), 1);
        let body = artifact_bytes(&server, &token, arts[0].0).await;

        // (1) R's own identity. Matched as a SHAPE, so an R upgrade does not falsely red
        //     this, while nothing that is not R can satisfy it.
        assert!(
            body.contains("R version ") && body.contains("Mersenne-Twister"),
            "the artifact carries no R interpreter identity — it did not come from R:\n{body}"
        );
        // (2) the PRODUCT, evaluated. Present; and the source expression absent, so an
        //     echo of the request cannot satisfy it.
        let product = (a * b).to_string();
        assert!(
            body.contains(&format!(">{product}<")),
            "the artifact does not carry the PRODUCT {product} of the requested operands \
             — nothing evaluated {a}*{b}:\n{body}"
        );
        assert!(
            !body.contains(&format!("{a}*{b}")),
            "the artifact echoed the SOURCE expression instead of its value:\n{body}"
        );
        // (3) R's RNG, and the python control.
        // …and the ARTIFACT carries a LIBRARY's resolved version. The package's own test
        // can only see that the SOURCE reads one and names a key for it; only the emitted
        // bytes can say a key actually arrived. (Why this matters at all is the manifest's
        // `run:` comment and DEC-8; this assertion does not restate it.)
        assert!(
            has_library_version_field(&body),
            "the artifact carries no `{LIB_VERSION_KEY}…` field, so no library's resolved \
             version reached the emitted bytes:\n{body}"
        );
        assert!(
            body.contains(r_draw),
            "the artifact does not carry R's draw ({r_draw}) for seed {seed} — the value \
             R and only R produces here:\n{body}"
        );
        assert!(
            !body.contains(py_draw),
            "the artifact carries NumPy's draw ({py_draw}) for seed {seed}, not R's. \
             Whatever produced this artifact, it was not R."
        );
        bodies.push(body);
    }

    // ── THE CONTROLS THAT MAKE THE ASSERTIONS ABOVE MEAN SOMETHING ────────────────
    //
    // The two runs must DIFFER. A canned artifact, a cached response, or an entry that
    // ignores `/inputs/params.json` all satisfy every assertion above and fail here.
    assert_ne!(
        bodies[0], bodies[1],
        "two different requests produced byte-identical artifacts — the assertions above \
         range over nothing"
    );
    // ── THE CROSS-CASE CONTROLS, AND THE PREMISE THEY NEED ────────────────────────
    //
    // These were deleted in one round on the reasoning that they are "strictly implied by
    // the per-case positives, since the artifact carries exactly one draw field and one
    // product field". The next round showed the reasoning is false: NOTHING asserted that
    // premise. The per-case checks are `contains` — presence, not uniqueness — so an entry
    // that appended to a shared file, dumped a table over several seeds, or emitted BOTH
    // cases' values would satisfy every per-case positive AND `bodies[0] != bodies[1]`, and
    // would be caught only here. They are restored, and the premise is now PINNED rather
    // than assumed.
    for (i, body) in bodies.iter().enumerate() {
        assert_eq!(
            body.matches("id=\"rng_draw\"").count(),
            1,
            "run {i}'s artifact carries {} draw fields, not one — the cross-case controls \
             below reason about a single value per artifact, and that premise must be \
             asserted rather than assumed:\n{body}",
            body.matches("id=\"rng_draw\"").count()
        );
        assert_eq!(
            body.matches("id=\"product\"").count(),
            1,
            "run {i}'s artifact carries {} product fields, not one:\n{body}",
            body.matches("id=\"product\"").count()
        );
    }
    assert!(
        !bodies[1].contains(cases[0].4),
        "the SECOND run's artifact carries the FIRST run's RNG draw ({}) — the entry is \
         not reading the seed from the request, or it is emitting more than its own \
         answer:\n{}",
        cases[0].4,
        bodies[1]
    );
    assert!(
        !bodies[0].contains(cases[1].4),
        "the FIRST run's artifact carries the SECOND run's RNG draw ({})",
        cases[1].4
    );
    assert!(
        !bodies[1].contains(&format!(">{}<", cases[0].0 * cases[0].1)),
        "the SECOND run's artifact carries the FIRST run's product:\n{}",
        bodies[1]
    );
    //
    // The NumPy comparison inside the loop is DESCRIPTIVE, not a control — NumPy is not
    // installed in the R image, so nothing reachable on this path could have put its
    // number in the artifact. It is kept because it documents WHY these two numbers differ
    // (R draws normals by inversion, NumPy by the polar method), and its own comment says
    // so.

    // ── INV-5: the surface E7 is allowed to bind to is exactly the declared `Provides` ──
    //
    // E6 is a tracer bullet. If the skeleton contributed a datatype, a converter or a
    // view, E7 could take a dependency on a SHAPE rather than on PROV-E6-1/2 — which is
    // what INV-5 forbids. Asserted against the loaded registry, not the manifest text.
    let reg = txresbench::modules::extensions::try_registry().expect("registry");
    let m = reg
        .all()
        .into_iter()
        .find(|m| m.id == r.package)
        .expect("the skeleton package is loaded");
    assert!(
        m.contributes.datatypes.is_empty(),
        "the skeleton contributes a datatype — E6/DEC-5 and INV-5 forbid it"
    );
    assert!(
        m.contributes.converters.is_empty(),
        "the skeleton contributes a converter — INV-5 forbids giving E7 a shape to bind to"
    );
    assert_eq!(
        m.contributes.analyses.len(),
        1,
        "the skeleton contributes exactly one analysis"
    );
    // INV-5 is broader than the contribution vocabulary: "a datatype, a converter, a VIEW,
    // a public helper, a STABLE FILE LAYOUT". The three above cover the first two; these
    // cover the rest of what a downstream item could reach for.
    // Read by NAME, not position: a declared collection is authored by a contributor in
    // whatever order they wrote it, and the contract promises nothing about index 0. The
    // `len() == 1` assertion above makes the lookup total, but it is the ID that says WHICH
    // analysis these assertions are about — an index says only "whichever came first".
    let a = m
        .contributes
        .analyses
        .iter()
        .find(|a| a.id == r.analysis_id)
        .unwrap_or_else(|| panic!("the skeleton's analysis `{}` is present", r.analysis_id));
    assert!(
        a.rest.get("ui").is_none(),
        "the skeleton declares a `ui:` view — a view is a shape E7 could bind to, and \
         DEC-6 says this item does not touch the frontend"
    );
    assert!(
        a.run().is_some_and(|run| run.helpers.is_empty()),
        "the skeleton declares `run.helpers` — a staged sibling is a file layout E7 could \
         depend on. DEC-2's contract is that an R entry is SELF-CONTAINED"
    );
    // …and the output layout the tests above pin (`probe`, `probe.html`,
    // `meta.kind`) is NOT a promise. Stated here so a reader of those assertions knows
    // they are this test's grip on the artifact, not a contract E7 may hold: E6's
    // `Provides` are the four in PLAN.md, and none of them names an output id or a
    // filename. If E7 needs a stable output shape, that is a NEW contract to negotiate,
    // not one to inherit.
    eprintln!(
        "[INV-5] the skeleton's output id/filename/meta.kind are pinned by THIS FILE only \
         and are not part of E6's declared Provides; a downstream item may not bind to them."
    );
}

// ══════════════════════════════════ TEST-3 ═══════════════════════════════════════════

const T3: &str = "sandbox::r_walking_skeleton::refusal_by_name";

/// TEST-3 `[acceptance]` `[invariant: INV-2]` — the substitution the epic exists to
/// prevent, refused BY NAME, with its positive control.
///
/// Arm A of DEC-7. The R analysis is run through the in-pod executor with the R seam
/// REMOVED from the environment and only the python seam present — i.e. exactly the
/// deployment state in which a `provide()` that ignored `env_id` would hand back the
/// python rootfs and let `Rscript` fail deep inside a sandbox. It must instead:
///
/// * FAIL, and
/// * name BOTH envs in the refusal — the one requested and the one that is staged — and
/// * catalog nothing.
///
/// The control runs the IDENTICAL job with the seam present and requires it to succeed. A
/// refusal test without that control passes just as happily when this whole item is
/// deleted, when the binary cannot start, or when the job was malformed.
#[tokio::test]
async fn an_r_analysis_is_refused_by_name_when_only_the_python_env_is_staged() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let Some(r) = r_tier_gate(&server, &token, T3).await else {
        return;
    };
    // The SECOND staged env — the "wrong image". Derived from the RECIPE TREE, never
    // from `default_env_id()` (a process-global another test in this binary moves).
    let Some(other_env) = other_staged_env(&r.env_id) else {
        record_skip(
            T3,
            "no SECOND env is staged, so there would be nothing for the provider to \
             wrongly substitute and the refusal could not be distinguished from `nothing \
             is staged at all`. Stage both envs (`sh scripts/build-env-rootfs-local.sh \
             --all`) and set both per-env seams.",
        );
        return;
    };
    let owner = owner_id(&pool).await;
    let project = create_project(&server, &token, "probe-refusal").await;

    // The params a real enqueue produces for this analysis — including the env the
    // MANIFEST declares, resolved through the registry rather than typed.
    let params = json!({
        "language": r.runtime,
        "analysis_id": r.analysis_id,
        "package": r.package,
        "code_ref": r.entry,
        "params": probe_params(6, 7, 20_260_903, 8),
        "seed": 20_260_903,
        "env": r.env_id,
    });

    // ── the arm under test: the R seam is GONE ─────────────────────────────────────
    let job = running_job(&pool, owner, Some(project), params.clone()).await;
    let r_seam = seam_var(&r.env_id);
    let (code, out) = run_job_subprocess_with(&server, job, |cmd| {
        cmd.env_remove(&r_seam);
    })
    .await;
    assert_ne!(code, 0, "with no R env staged the run must FAIL, not substitute:\n{out}");
    let diag = format!("{out}\n{}", job_error_and_logs(&pool, job).await);

    // ── THE FAILURE MUST BE THE ONE THIS TEST IS ABOUT, AND MUST NAME BOTH ENVS ────
    //
    // `code != 0` alone is satisfied by anything that goes wrong — a malformed spec, an
    // unreachable database, a bad generated config. And "names both envs" is not
    // checkable by two `contains` calls, because one env id is a PREFIX of the other:
    // the longer id's presence implies the shorter one's, so the conjunction collapses to
    // ONE check and a message naming only the requested env — the exact "R is broken"
    // message this test forbids — would pass.
    //
    // Both problems are solved by reading the refusal's own STRUCTURED FIELDS, which come
    // from one code path (`env_image.rs`'s refusal) and put each env under its own key.
    // A keyed, whitespace-bounded value is exact: `staged_env=<x>` cannot be satisfied by
    // `staged_env=<x>-r`.
    let clean = strip_ansi(&diag);
    let requested = logged_field(&clean, REFUSAL_REQUESTED_KEY);
    let staged = logged_field(&clean, REFUSAL_STAGED_KEY);
    assert!(
        requested.is_some() && staged.is_some(),
        "the run failed, but not with the substitution refusal this test exists for — \
         its structured fields (`{REFUSAL_REQUESTED_KEY}`/`{REFUSAL_STAGED_KEY}`) are \
         absent. A non-zero exit for some other reason would make every assertion below \
         vacuous:\n{diag}"
    );
    assert_eq!(
        requested,
        Some(r.env_id.as_str()),
        "the refusal names the wrong REQUESTED env:\n{diag}"
    );
    assert_eq!(
        staged,
        Some(other_env.as_str()),
        "the refusal does not name the env that is ACTUALLY staged. Without BOTH names \
         the operator reads `R is broken` and goes to debug the image instead of the \
         staging:\n{diag}"
    );
    // …and the human-facing message says both too, in a form the quotes make exact.
    // (Two channels, deliberately: the structured line is the contract, the message is
    // what an operator reads, and a refusal that names both in one but not the other is
    // worth knowing about.)
    assert!(
        clean.contains(&format!("{:?}", r.env_id)) && clean.contains(&format!("{other_env:?}")),
        "the refusal's MESSAGE does not quote both env names:\n{diag}"
    );
    assert!(
        artifact_ids(&pool, job).await.is_empty(),
        "a refused run catalogs nothing"
    );

    // ── the positive control: the IDENTICAL job, with the seam present ─────────────
    let ok_job = running_job(&pool, owner, Some(project), params).await;
    let (ok_code, ok_out) = run_job_subprocess_with(&server, ok_job, |_| {}).await;
    assert_eq!(
        ok_code, 0,
        "the same job SUCCEEDS once the R env is staged — without this the refusal above \
         is indistinguishable from a job that could never have run:\n{ok_out}"
    );
    assert_eq!(
        artifact_ids(&pool, ok_job).await.len(),
        1,
        "the control run cataloged its output"
    );
}

// ══════════════════════════════════ TEST-4 ═══════════════════════════════════════════

const T4: &str = "sandbox::r_walking_skeleton::operator_override_fails_closed";

/// TEST-4 — Arm B of DEC-7: an operator override into the WRONG image fails CLOSED.
///
/// `TXR_SANDBOX_ENV_ID` sits ABOVE a declared env by design (`env_image.rs:144`): it is
/// the operator's escape hatch for pinning a whole process to one image. E6 does not
/// re-litigate that precedence, and it does NOT add a runtime interpreter-presence
/// precheck — that needs a per-env capability declaration nothing on main carries, and
/// inventing one inside a tracer bullet is what INV-5 forbids (DEC-7).
///
/// What E6 DOES assert is the safety property that must hold regardless: forced into an
/// image with no R interpreter, the run **fails, catalogs nothing, and is attributed** —
/// it never reports success and never records the R image's digest for a run that did not
/// mount it.
///
/// The residual this test MEASURES rather than asserts — that today's message names the
/// interpreter rather than the analysis+runtime+env triple — is recorded in DEC-7 as a
/// scoped follow-up for the item that owns env capability declarations.
#[tokio::test]
async fn an_operator_override_into_the_python_image_fails_closed() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let Some(r) = r_tier_gate(&server, &token, T4).await else {
        return;
    };
    // The SECOND staged env — the "wrong image". Derived from the RECIPE TREE, never
    // from `default_env_id()` (a process-global another test in this binary moves).
    let Some(other_env) = other_staged_env(&r.env_id) else {
        record_skip(
            T4,
            "no SECOND env is staged, so there is no wrong image to force into. Stage both envs \
             (`sh scripts/build-env-rootfs-local.sh --all`) and set both per-env seams.",
        );
        return;
    };
    let owner = owner_id(&pool).await;
    let project = create_project(&server, &token, "probe-override").await;

    let params = json!({
        "language": r.runtime,
        "analysis_id": r.analysis_id,
        "package": r.package,
        "code_ref": r.entry,
        "params": probe_params(6, 7, 20_260_903, 8),
        "seed": 20_260_903,
        "env": r.env_id,
    });
    let job = running_job(&pool, owner, Some(project), params).await;
    let (code, out) = run_job_subprocess_with(&server, job, |cmd| {
        cmd.env("TXR_SANDBOX_ENV_ID", &other_env);
    })
    .await;

    assert_ne!(
        code, 0,
        "an R entry forced into an image with no R interpreter must FAIL — a zero exit \
         here would mean the platform reported success for a run that executed nothing:\n{out}"
    );
    let diag = format!("{out}\n{}", job_error_and_logs(&pool, job).await);
    // ── THE FAILURE IS THE ONE THIS TEST IS ABOUT, not any failure ────────────────
    //
    // `code != 0` alone is satisfied by a malformed spec, an unreachable DB, a bad config.
    // The override arm's whole subject is a run that REACHED the sandbox and could not
    // execute its interpreter there, so that is what is asserted: the interpreter is named
    // in the failure, and the refusal that belongs to the OTHER arm is absent (a
    // `STAGED_ENV_MISMATCH` here would mean the override never took effect).
    // The interpreter name is DERIVED from the language the manifest declares, through
    // the same function the runner uses to build the command — not typed here, so it
    // cannot drift from what actually gets exec'd.
    let interpreter = txresbench::modules::sandbox::spec::Language::from_runtime(&r.runtime)
        .expect("the declared runtime resolves to a language")
        .command_for("/code/entry")
        .split_whitespace()
        .next()
        .expect("the command names an interpreter")
        .to_string();
    assert!(
        diag.contains(&interpreter),
        "the failure does not mention the interpreter that could not run:\n{diag}"
    );
    // …and it must not be one of the EARLIER failures that would also produce a non-zero
    // exit and could also mention a missing thing. A `|| contains(\"not found\")` disjunct
    // stood here and defeated the very purpose the line above states: `job_error_and_logs`
    // is exactly the haystack a `package not found` / `code_ref not found` lands in.
    for earlier in ["malformed analysis spec", "no processor package provides", "cannot infer a runtime"] {
        assert!(
            !diag.contains(earlier),
            "the run failed BEFORE reaching the sandbox (`{earlier}`), so this arm asserted \
             about an earlier error rather than about an interpreter that is not there:\n{diag}"
        );
    }
    assert!(
        logged_field(&strip_ansi(&diag), REFUSAL_STAGED_KEY).is_none(),
        "the run was refused at STAGING (the substitution refusal's structured fields are \
         present), so the operator override never took effect and this arm exercised \
         nothing:\n{diag}"
    );
    assert!(
        artifact_ids(&pool, job).await.is_empty(),
        "a run that could not execute its interpreter catalogs NOTHING — never an empty \
         or partial result"
    );

    // ── ATTRIBUTION, ASSERTED POSITIVELY ──────────────────────────────────────────
    //
    // The first cut asserted only `recorded != Some(r_sha)`, which passes when `recorded`
    // is `None` — i.e. when NO provenance row exists at all, the ordinary outcome for a
    // run that failed. "Not mis-attributed" and "not attributed" are different states and
    // that assertion could not tell them apart. So both are enumerated: either there is no
    // row (the run never got far enough to have one), or there IS one and it names the
    // image the run ACTUALLY mounted — the python one. A stale R digest is the
    // process-global failure PROV-E1-4 removed, resurfacing on the failure path.
    let r_sha = sha256_of(&staged_artifact(&r.env_id).expect("the R seam"));
    let other_sha = sha256_of(&staged_artifact(&other_env).expect("the sibling seam"));
    assert_ne!(r_sha, other_sha, "the two staged images hash the same — nothing to tell apart");
    let recorded: Option<String> =
        sqlx::query_scalar("SELECT env_rootfs_sha256 FROM provenance_run_repro WHERE run_id = $1")
            .bind(job)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .flatten();
    match recorded.as_deref() {
        None => eprintln!(
            "[TEST-4] the failed run wrote no provenance env digest at all — it never \
             reached the recording hop. Fail-closed, and not mis-attributed."
        ),
        Some(d) => {
            assert_ne!(
                d, r_sha,
                "the failed run recorded the R image's digest despite running against \
                 `{other_env}` — a run's provenance must name the image IT mounted"
            );
            assert_eq!(
                d, other_sha,
                "the run recorded a digest that is neither image staged on this host"
            );
        }
    }

    // ── THE POSITIVE CONTROL ──────────────────────────────────────────────────────
    //
    // Without it, every assertion above is satisfied by an item that does not exist: a
    // binary that cannot start, a config that cannot be read, a spec that never parsed.
    // The IDENTICAL job, with the override removed, must succeed.
    let ok_job = running_job(
        &pool,
        owner,
        Some(project),
        json!({
            "language": r.runtime,
            "analysis_id": r.analysis_id,
            "package": r.package,
            "code_ref": r.entry,
            "params": probe_params(6, 7, 20_260_903, 8),
            "seed": 20_260_903,
            "env": r.env_id,
        }),
    )
    .await;
    let (ok_code, ok_out) = run_job_subprocess_with(&server, ok_job, |cmd| {
        cmd.env_remove("TXR_SANDBOX_ENV_ID");
    })
    .await;
    assert_eq!(
        ok_code, 0,
        "the SAME job succeeds with the override removed — without this control, \
         `it failed` is indistinguishable from `it could never have run`:\n{ok_out}"
    );

    // The MEASUREMENT behind DEC-7's named residual. Printed, not asserted: E6's contract
    // for this arm is FAIL-CLOSED (asserted above), and pinning today's exact message
    // would freeze a residual in place instead of recording it for the item that owns env
    // capability declarations.
    eprintln!(
        "[DEC-7 Arm B residual] override={other_env} declared={} — the failure text the \
         platform produced is above; today it names the interpreter, NOT the \
         analysis+runtime+env triple INV-2 asks for. See DESIGN_FIDELITY.md (INV-2, \
         AT-RISK).",
        r.env_id
    );
}

// ══════════════════════════════════ TEST-5 ═══════════════════════════════════════════

const T5: &str = "sandbox::r_walking_skeleton::python_unaffected";

/// TEST-5 `[acceptance]` `[invariant: INV-1]` — the python path is unaffected, asserted in
/// the process where a process-global would have leaked.
///
/// The R run happens FIRST, in the same server process, with both envs staged. Then a
/// python analysis runs. It must:
///
/// * pin the PYTHON image's digest (not the R one the process last mounted), and
/// * carry NO `env` key in its stored params — an analysis that declares none is
///   byte-identical to pre-#189, and the enqueue path REMOVES a caller-supplied env for
///   exactly that reason, and
/// * produce the SAME output content-hashes it produces when no R run precedes it.
///
/// The ordering is the test. `LAST_RESOLVED_DIGEST` was a process-global last-write, and
/// the whole of PROV-E1-4 is that provenance now reads a RUN-SCOPED sidecar instead; the
/// only way to observe the difference is to mount two different images in one process and
/// then look at the older run's row.
#[tokio::test]
async fn a_python_analysis_in_the_same_process_pins_the_python_image() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let Some(r) = r_tier_gate(&server, &token, T5).await else {
        return;
    };
    // The SECOND staged env — the "wrong image". Derived from the RECIPE TREE, never
    // from `default_env_id()` (a process-global another test in this binary moves).
    let Some(py_env) = other_staged_env(&r.env_id) else {
        record_skip(
            T5,
            "no SECOND env is staged, so there is no python run to compare. Stage both envs \
             (`sh scripts/build-env-rootfs-local.sh --all`) and set both per-env seams.",
        );
        return;
    };
    let owner = owner_id(&pool).await;
    let project = create_project(&server, &token, "probe-inv1").await;

    // A python analysis, expressed as an INLINE script so it needs no dataset and no
    // package input — the smallest thing that genuinely traverses the same
    // stage→provide→bwrap→ingest path a shipped python analysis does. Its bytes are
    // fixed, so its output content-hash is deterministic and comparable across runs.
    // ── WHY THIS SCRIPT FINGERPRINTS ITS ENVIRONMENT INSTEAD OF WRITING A LITERAL ──
    //
    // The first cut wrote a fixed byte string. Its content-hash was therefore a CONSTANT:
    // the comparison below could not have failed no matter what this branch broke —
    // helper staging, env resolution, which image got mounted, all of it. "Byte-identical,
    // proven not asserted" would have been proven only about bytes the test dictated.
    //
    // So the artifact is now a MEASUREMENT of the two things this branch could break:
    //   * `sys.version` + the interpreter prefix — i.e. WHICH IMAGE was mounted;
    //   * the sorted listing of `/code` — i.e. WHAT WAS STAGED beside the entry.
    // A run that mounted the R image, or that lost/gained an app helper, produces
    // different bytes and a different content-hash, and the assertion goes red.
    //
    // `sorted()` because a directory listing has no defined order, and an order-dependent
    // hash would fail for a reason that is not the one under test.
    let py_params = json!({
        "language": "python",
        "script": "import json, os, sys\n\
os.makedirs('/outputs', exist_ok=True)\n\
fp = {\n\
  'version': sys.version.split()[0],\n\
  'prefix': sys.prefix,\n\
  'code': sorted(os.listdir('/code')),\n\
}\n\
open('/outputs/result.bin','w').write(json.dumps(fp, sort_keys=True))\n\
json.dump({'outputs':[{'id':'result','datatype':'data/opaque','path':'result.bin','layout':'opaque','role':'artifact','structure':{'encoding':'opaque','media_type':'application/json'},'meta':{}}]}, open('/outputs/manifest.json','w'))\n",
    });

    // ── 1. the R run FIRST, so the process has most recently mounted the R image ────
    let r_params = json!({
        "language": r.runtime,
        "analysis_id": r.analysis_id,
        "package": r.package,
        "code_ref": r.entry,
        "params": probe_params(6, 7, 20_260_903, 8),
        "seed": 20_260_903,
        "env": r.env_id,
    });
    let r_job = running_job(&pool, owner, Some(project), r_params).await;
    let (r_code, r_out) = run_job_subprocess_with(&server, r_job, |_| {}).await;
    assert_eq!(r_code, 0, "the R run must succeed for this ordering to mean anything:\n{r_out}");

    // ── 2. the python run, in the same process, right after ────────────────────────
    let py_job = running_job(&pool, owner, Some(project), py_params.clone()).await;
    let (py_code, py_out) = run_job_subprocess_with(&server, py_job, |_| {}).await;
    assert_eq!(py_code, 0, "the python control run succeeds:\n{py_out}");

    let r_sha = sha256_of(&staged_artifact(&r.env_id).expect("the R seam"));
    let py_sha = sha256_of(&staged_artifact(&py_env).expect("the python seam"));
    assert_ne!(r_sha, py_sha, "the two staged images are identical — the test is vacuous");

    let pinned_py = pinned_env_digest(&pool, py_job, T5)
        .await
        .expect("the python run recorded a digest");
    assert_eq!(
        pinned_py, py_sha,
        "the python run must pin the PYTHON image (INV-1). Pinning `{r_sha}` here would be \
         a process-global last-write leaking the R run's image into a python run's \
         provenance — the exact failure PROV-E1-4 removed."
    );
    let pinned_r = pinned_env_digest(&pool, r_job, T5).await.expect("the R run recorded a digest");
    assert_eq!(pinned_r, r_sha, "…and the EARLIER R run still reads back its OWN digest");

    // ── 3. the python run's OUTPUT is what it was, with no R run in the picture ─────
    let sig_after = artifact_signature(&pool, py_job).await;
    let clean_server = TestServer::spawn().await;
    let clean_token = setup_admin(&clean_server).await;
    let clean_pool = pool_for(&clean_server).await;
    let clean_owner = owner_id(&clean_pool).await;
    let clean_project = create_project(&clean_server, &clean_token, "probe-inv1-clean").await;
    let clean_job = running_job(&clean_pool, clean_owner, Some(clean_project), py_params).await;
    let (c_code, c_out) = run_job_subprocess_with(&clean_server, clean_job, |cmd| {
        // No R env in scope at all: the pre-#189 world for this run.
        cmd.env_remove(seam_var(&r.env_id));
    })
    .await;
    assert_eq!(c_code, 0, "the python control runs in a server that never saw the R env:\n{c_out}");
    let sig_clean = artifact_signature(&clean_pool, clean_job).await;
    assert_eq!(
        sig_after, sig_clean,
        "the python analysis produced DIFFERENT bytes depending on whether an R run \
         preceded it in the same deployment — INV-1 says it is byte-identically unaffected"
    );
    assert!(!sig_after.is_empty(), "the signature is empty, so the comparison is vacuous");

    // …and the fingerprint is READ, so "identical" is identical to something MEANINGFUL.
    // A hash comparison alone would still pass if BOTH runs had silently mounted the R
    // image; this asserts what the python run actually observed inside its sandbox.
    let py_art = artifact_ids(&pool, py_job).await;
    assert_eq!(py_art.len(), 1, "the python control cataloged its fingerprint: {py_art:?}");
    let fp = artifact_bytes(&server, &token, py_art[0].0).await;
    let fp: Value = serde_json::from_str(&fp).expect("the fingerprint is JSON");
    assert!(
        fp["version"].as_str().is_some_and(|v| v.starts_with('3')),
        "the python control ran a python 3 interpreter — not R, and not nothing: {fp}"
    );
    let code: Vec<&str> = fp["code"]
        .as_array()
        .expect("the fingerprint lists /code")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        code.contains(&"entry.py"),
        "the staged code dir holds the python entry the run executed: {code:?}"
    );

    // ── 4. …and a spec with no `analysis_id` stores NO env key ─────────────────────
    //
    // This asserts the STORED SPEC, so it deliberately does not wait for the run: the
    // claim is about what the enqueue path wrote, and waiting would add a second failure
    // mode (a scheduler that never claims it) to an assertion that has nothing to do with
    // running. The env-LESS run itself is already proven above — `py_job` carries no `env`
    // and completed.
    let resp = clean_server
        .client
        .post(clean_server.api_url("/jobs"))
        .bearer_auth(&clean_token)
        .json(&json!({
            "job_type": "analysis",
            "name": "inv1-wire",
            "project_id": clean_project,
            "params": {
                "language": "python",
                "script": "open('/outputs/manifest.json','w').write('{\"outputs\":[]}')\n",
                // A caller-supplied env on a spec that names no analysis: nothing to
                // honour, so the boundary must DROP it rather than trust it (DEC-4).
                "env": r.env_id,
            },
        }))
        .send()
        .await
        .expect("submit the wire-shape job");
    assert_eq!(resp.status().as_u16(), 201, "the env-less spec enqueues");
    let wire: Value = resp.json().await.unwrap();
    let wire_job = Uuid::parse_str(wire["id"].as_str().unwrap()).unwrap();
    let stored: Value = sqlx::query_scalar("SELECT params FROM jobs WHERE id = $1")
        .bind(wire_job)
        .fetch_one(&clean_pool)
        .await
        .expect("stored params");
    assert!(
        stored.get("env").is_none(),
        "a spec with no `analysis_id` has no declaration to honour, so the enqueue path \
         must REMOVE the caller-supplied env rather than trust it (DEC-4). Stored: {stored}"
    );
    // …and the control that stops "no env key" from passing for the wrong reason. It is
    // NOT `language is present` — that asserts about a value this test itself supplied.
    // It is the ROUTE's own stated contract: it sets ONE key and does not re-encode the
    // body through `AnalysisSpec`, because several of that struct's fields are
    // `#[serde(default)]` WITHOUT `skip_serializing_if` and a round-trip would MATERIALIZE
    // them into the stored row. So a lossy rewrite is detectable by its debris — and if
    // the route had rewritten the body, "no env key" would be true for the wrong reason.
    for materialized in ["inputs", "produces", "schedule", "extra_mounts", "arch"] {
        assert!(
            stored.get(materialized).is_none(),
            "the stored params carry `{materialized}`, which this request did not send: \
             the enqueue path re-encoded the whole body through `AnalysisSpec` instead of \
             setting one key. A lossy rewrite of a persisted request body would also \
             explain the absent `env` above: {stored}"
        );
    }
}

async fn artifact_signature(pool: &sqlx::SqlitePool, run: Uuid) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT output_id, content_hash FROM artifacts WHERE run_id = $1 ORDER BY output_id",
    )
    .bind(run)
    .fetch_all(pool)
    .await
    .expect("run signature")
}

// ══════════════════════════════════ TEST-8 ═══════════════════════════════════════════

const T8: &str = "sandbox::r_walking_skeleton::manifest_contract_violation";

/// TEST-8 — the NEGATIVE arm of the output contract, from the R side.
///
/// `P3 FINAL.md` ITEM-15 / DEC-K: *a missing or invalid `/outputs/manifest.json` on an
/// exit-0 run is a typed contract violation → the job fails.* That rule has only ever
/// been exercised by python producers. This drives it with a real `Rscript` entry that
/// exits 0 having written no manifest — proving the contract is enforced by the HOST over
/// the emitted directory (language-agnostic by construction, PROV-shipped-9) rather than
/// by anything staged into a python entry's `/code`.
///
/// Both arms run: the positive control writes a valid manifest from R and must succeed, so
/// "the R job failed" cannot be satisfied by R being broken.
#[tokio::test]
async fn an_r_entry_exiting_zero_without_a_manifest_fails_the_job() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let Some(r) = r_tier_gate(&server, &token, T8).await else {
        return;
    };
    let owner = owner_id(&pool).await;
    let project = create_project(&server, &token, "probe-contract").await;

    // An INLINE R script: `env` is honoured verbatim on this path (the in-pod executor
    // reads the stored spec), which is what lets an ad-hoc R entry reach the R image.
    let spec = |script: &str| {
        json!({ "language": r.runtime, "script": script, "env": r.env_id })
    };

    // ── the violation: exit 0, an artifact on disk, NO manifest ────────────────────
    let bad = running_job(
        &pool,
        owner,
        Some(project),
        spec("dir.create('/outputs', showWarnings = FALSE)\nwriteLines('bytes', '/outputs/result.bin')\nquit(status = 0)\n"),
    )
    .await;
    let (bad_code, bad_out) = run_job_subprocess_with(&server, bad, |_| {}).await;
    assert_ne!(
        bad_code, 0,
        "an R entry that exits 0 with no `/outputs/manifest.json` must FAIL the job — the \
         output contract is the HOST's, not the interpreter's:\n{bad_out}"
    );
    assert!(
        artifact_ids(&pool, bad).await.is_empty(),
        "a contract-violating run catalogs nothing"
    );

    // ── and an INVALID manifest is refused too, not just an absent one ─────────────
    let invalid = running_job(
        &pool,
        owner,
        Some(project),
        spec("dir.create('/outputs', showWarnings = FALSE)\nwriteLines('{ not json', '/outputs/manifest.json')\nquit(status = 0)\n"),
    )
    .await;
    let (inv_code, inv_out) = run_job_subprocess_with(&server, invalid, |_| {}).await;
    assert_ne!(inv_code, 0, "an unparseable manifest is a contract violation too:\n{inv_out}");
    assert!(
        artifact_ids(&pool, invalid).await.is_empty(),
        "an INVALID manifest must catalog nothing, exactly as a MISSING one does. \
         Asserting only the exit code here would let a half-read manifest's entries land \
         in the catalog while the job reported failure — a partial result, which is the \
         one outcome DEC-K exists to forbid"
    );

    // ── the positive control: the SAME R interpreter, writing a VALID manifest ─────
    let good = running_job(
        &pool,
        owner,
        Some(project),
        spec(
            "dir.create('/outputs', showWarnings = FALSE)\n\
             writeLines('<!doctype html><html><body>ok</body></html>', '/outputs/ok.html')\n\
             writeLines('{\"outputs\":[{\"id\":\"ok\",\"datatype\":\"report/html\",\"path\":\"ok.html\",\"layout\":\"opaque\",\"role\":\"artifact\",\"structure\":{\"encoding\":\"opaque\",\"media_type\":\"text/html\"},\"meta\":{}}]}', '/outputs/manifest.json')\n",
        ),
    )
    .await;
    let (good_code, good_out) = run_job_subprocess_with(&server, good, |_| {}).await;
    assert_eq!(
        good_code, 0,
        "the control must SUCCEED — otherwise the two failures above are explained by R \
         being unavailable rather than by the contract:\n{good_out}"
    );
    assert_eq!(
        artifact_ids(&pool, good).await.len(),
        1,
        "the control's declared output was cataloged"
    );
}
