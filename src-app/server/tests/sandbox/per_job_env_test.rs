//! #189 (E1) — per-job env selection, end to end over the REAL spawned server.
//!
//! The unit tier pins each hop of the chain in isolation (`env_image`'s precedence +
//! seam tests, `spec`'s validation + DEC-4 overwrite, `extensions::types`' parsing).
//! What those cannot show is that the hops are actually CONNECTED, and connectedness is
//! the whole of PROV-E1-2: before this change every individual layer was reasonable and
//! the env-id still never reached a run, because `ResolvedAnalysisEntry`, `RunSpec`,
//! `AnalysisSpec` and `ComputeSpec` each dropped it independently.
//!
//! These tests therefore drive the assembled path, and the INV-1 regression claim is
//! made by MEASUREMENT (a recorded wire dump diffed against the same dump taken on
//! `origin/main`), not by inspection.

use serde_json::Value;

use super::setup_admin;
use crate::common::TestServer;

/// **TEST-E1-9** [invariant: INV-5] [covers: ITEM-1] — `GET /api/extensions` is
/// UNCHANGED for a package that declares no analysis `env`, and carries EXACTLY the
/// declared value for one that does.
///
/// ## Narrowed by #191, in the way this test's own failure message prescribed
///
/// It used to assert that NO shipped analysis carries an `env` key. That was a snapshot
/// of the tree, not the invariant: INV-5's claim is *byte-faithfulness for a package
/// that declares none*, and it stays exactly as strong here. #191 made 12 shipped
/// ANALYSES declare `env` — 14 contributions counting the two converters that already
/// did. (Counted off the tree when this was written; every assertion below DERIVES its
/// subject, so none of them depends on the number being current.) — not cosmetically, but because the #80 dependency gate
/// resolves an env-LESS declaration against EVERY recipe, so a second, deliberately
/// narrower env cannot exist on disk until each dependency-declaring contribution names
/// the env it targets (the gate's own doc-comment prescribes precisely that). So the
/// subject is split: the env-less analyses still prove the byte-faithful case, and the
/// declaring ones now prove the positive case — that the wire carries what the manifest
/// says and not something else. Deleting either half would be the weakening; keeping
/// only the first half would have made this test vacuous the moment its subject moved.
///
/// Writes the authed payload to `target/env-wire-dump.json`.
///
/// **THE WHOLE-PAYLOAD BYTE COMPARISON THIS PARAGRAPH USED TO PROMISE NO LONGER HOLDS,
/// and leaving the promise standing would be worse than the change itself.** #191 gave 12
/// shipped ANALYSES an explicit `env` (14 contributions in all, counting the two
/// converters that already declared one), which serializes, so a dump taken here and a dump
/// taken on `origin/main` DIFFER by exactly those keys, by design. The dump is still worth
/// writing — it makes the delta inspectable — but it is now a diff to READ, not a file to
/// `cmp`. The regression claim it backed has moved INTO the assertions below, per
/// analysis: an analysis that declares no env still adds no key (byte-faithful, exactly as
/// before), and one that declares an env carries that id verbatim and nothing else.
/// That is a stronger claim than the aggregate byte comparison, and unlike it, it survives
/// the tree's subject moving again.
/// Lifecycle id: **TEST-26** (see `.lifecycle/analysis-env-selection/TESTS.md`).
#[tokio::test]
async fn extensions_wire_is_unchanged_for_packages_declaring_no_env() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /extensions");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("extensions payload is JSON");

    // Record the payload for the cross-branch byte comparison.
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/env-wire-dump.json");
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&out, serde_json::to_vec_pretty(&body).unwrap())
        .unwrap_or_else(|e| panic!("write {}: {e}", out.display()));

    // ANTI-VACUITY: the payload must actually carry the shipped registry, or every
    // assertion below is true of nothing.
    // The endpoint returns a bare ARRAY of extension manifests.
    let items = body
        .as_array()
        .unwrap_or_else(|| panic!("unexpected extensions payload shape: {body}"));
    assert!(
        items.len() >= 2,
        "only {} extension(s) in the payload — the assertions below would be vacuous",
        items.len()
    );

    // The claim, per analysis: the wire carries EXACTLY what the manifest declares. `env`
    // is `skip_serializing_if = "Option::is_none"`, so an analysis that declares none adds
    // no key — which is what makes its payload byte-identical to before the field existed
    // — and one that declares an env carries that id verbatim, never a substitute.
    let mut analyses_seen = 0usize;
    let mut env_less_seen = 0usize;
    let mut declaring_seen = 0usize;
    for ext in items {
        let Some(analyses) = ext
            .pointer("/contributes/analyses")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for a in analyses {
            analyses_seen += 1;
            let id = a.get("id").and_then(Value::as_str).unwrap_or_default();
            // The EXPECTED value is read from the registry's parse of the manifest, never
            // spelled here: naming an env-id in the app's test surface is the domain leak
            // INV-4 forbids, and it would also make this pass for a wire that had been
            // replaced by that constant.
            let declared = txresbench::modules::extensions::declared_env_for_analysis(id);
            match declared {
                None => {
                    env_less_seen += 1;
                    assert!(
                        a.get("env").is_none(),
                        "analysis {id:?} declares no env but gained an `env` key on the \
                         wire, which breaks INV-5's byte-faithfulness for every package \
                         that declares none: {a}"
                    );
                }
                Some(want) => {
                    declaring_seen += 1;
                    assert_eq!(
                        a.get("env").and_then(Value::as_str),
                        Some(want.as_str()),
                        "analysis {id:?} declares an env but the wire does not carry it \
                         verbatim: {a}"
                    );
                }
            }
        }
    }
    assert!(
        analyses_seen >= 1,
        "no analyses found in the payload — the env-key assertion was vacuous"
    );
    // BOTH halves must have a subject, or one of the two claims above is true of nothing.
    assert!(
        env_less_seen >= 1,
        "no shipped analysis declares an env-less contribution — the byte-faithfulness \
         half of this test had no subject"
    );
    assert!(
        declaring_seen >= 1,
        "no shipped analysis declares an env — the positive half of this test had no \
         subject; if that is genuinely the tree's state, the #80 dependency gate can no \
         longer be scoped per env and a second recipe cannot exist"
    );

    // The CONVERTER side still serializes its long-standing `env`, so this test cannot
    // pass by the field having been dropped from the wire altogether.
    let converter_envs: Vec<&Value> = items
        .iter()
        .filter_map(|e| e.pointer("/contributes/converters").and_then(Value::as_array))
        .flatten()
        .filter_map(|c| c.get("env"))
        .collect();
    assert!(
        !converter_envs.is_empty(),
        "no converter declares `env` on the wire — the absence assertion above would \
         also pass if serialization were simply broken"
    );
}

/// **TEST-E1-3** [acceptance] [invariant: INV-1] **PROV-E1-2** [covers: ITEM-7, ITEM-11]
/// — an analysis declaring NO `env` resolves to exactly the env-id it resolved to before
/// this change.
///
/// Asserted against the value the resolver RETURNS, never a literal — naming the shipped
/// env here would both bake domain vocabulary into the app's test surface (INV-4) and
/// make the test pass for a resolver that had been replaced by that constant.
///
/// The control is the point: `resolve_env_id(None)` is the pre-#189 code path
/// (`default_env_id`), and every shipped analysis must go through it unchanged.
/// Lifecycle id: **TEST-27** (see `.lifecycle/analysis-env-selection/TESTS.md`).
#[tokio::test]
async fn shipped_env_less_analyses_resolve_exactly_as_before() {
    // Spawning the server is what builds and publishes the real registry this reads.
    let server = TestServer::spawn().await;
    let _token = setup_admin(&server).await;

    use txresbench::modules::sandbox::env_image::{declared_env_ids, resolve_env_id};

    let deployment_default = resolve_env_id(None);
    assert!(
        deployment_default.is_some(),
        "the shipped registry must resolve SOME deployment default, or the comparison \
         below is between two Nones and proves nothing"
    );

    // This test is the INV-1 baseline for analyses that declare NO env: each must resolve
    // to the deployment default, exactly as it did before per-job selection existed.
    //
    // #191 gave 12 shipped analyses an explicit `env`, which is what lets the #80
    // dependency gate be scoped per env and therefore what lets a second recipe exist at
    // all. Following this test's own prior instruction — "a newly-declaring package must
    // be added to a per-job test rather than silently changing this one's subject" — the
    // env-less loop is NARROWED to its real subject, and the declaring ones get their own
    // assertion below rather than being dropped from coverage.
    // The independent source the declaring half is checked against (see below).
    let recipe_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server dir has a parent")
        .join("env-rootfs");
    let recipe_ids =
        txresbench::modules::rootfs::version::discover_env_recipes(&recipe_root);
    assert!(
        !recipe_ids.is_empty(),
        "no env recipe under {} — the cross-source check below would be vacuous",
        recipe_root.display()
    );

    // THE DISCRIMINATING LEG. Every shipped declaring analysis names the SAME env as the
    // deployment default, so `resolve_env_id(Some(default))` and `resolve_env_id(None)`
    // assert the same fact and neither can tell whether per-job selection exists at all —
    // a blind mutation deleted the declared-env branch from `resolve_env_id` and this test
    // stayed green. Driving the resolver with an id that is NOT the default is what makes
    // the per-job claim falsifiable, and it needs no shipped package to declare one.
    {
        let not_the_default = format!("{}-fixture-not-a-default", deployment_default.as_deref().unwrap_or("x"));
        assert_ne!(Some(not_the_default.clone()), deployment_default);
        assert_eq!(
            resolve_env_id(Some(&not_the_default)),
            Some(not_the_default.clone()),
            "a job's DECLARED env must win over the deployment default — this is the whole \
             of per-job selection, and asserting it only for analyses that declare the \
             default proves nothing"
        );
    }

    let reg = txresbench::modules::extensions::registry();
    let mut env_less_seen = 0usize;
    let mut declaring_seen = 0usize;
    for m in reg.all() {
        for a in &m.contributes.analyses {
            let declared = txresbench::modules::extensions::declared_env_for_analysis(&a.id);
            match declared {
                None => {
                    env_less_seen += 1;
                    assert_eq!(
                        resolve_env_id(None),
                        deployment_default,
                        "an env-less analysis must resolve to the deployment default, \
                         unchanged"
                    );
                }
                Some(want) => {
                    declaring_seen += 1;
                    // A DECLARING analysis resolves to what it declared — the per-job
                    // half of the contract. (No `TXR_SANDBOX_ENV_ID` is set in this
                    // process, so the operator override does not displace it here.)
                    assert_eq!(
                        resolve_env_id(Some(&want)),
                        Some(want.clone()),
                        "analysis {:?} declares env {want:?} but resolves elsewhere",
                        a.id
                    );
                    // …and its declaration must name a recipe that EXISTS ON DISK.
                    //
                    // This deliberately reads the RECIPE TREE and not `declared_env_ids()`.
                    // Checking the declaration against the union was a TAUTOLOGY: the union
                    // IS the set of declared values, so `want` is a member by definition and
                    // the assertion could not fail — including for the typo it claimed to
                    // catch, which would simply join the union. (`derived-guards.md` §4:
                    // "a derivation whose two sides read the same source is a tautology".)
                    // The recipe tree is a genuinely independent source, and an env with no
                    // recipe is the failure that would otherwise surface at PULL time.
                    assert!(
                        recipe_ids.contains(&want),
                        "analysis {:?} declares env {want:?}, which is not a recipe under \
                         {} (found: {recipe_ids:?})",
                        a.id,
                        recipe_root.display()
                    );
                }
            }
        }
    }
    assert!(
        env_less_seen >= 1,
        "no env-less shipped analyses — the INV-1 baseline loop above was vacuous"
    );
    assert!(
        declaring_seen >= 1,
        "no shipped analysis declares an env — the per-job half had no subject"
    );

    // The union is non-empty and the deployment default is drawn from it (rather than
    // invented), which is PROV-E1-6 observed on the real shipped registry.
    let union = declared_env_ids();
    assert!(!union.is_empty(), "the shipped registry declares at least one env");
    assert!(
        union.contains(deployment_default.as_ref().unwrap()),
        "the resolved default {deployment_default:?} must come from the DECLARED union \
         {union:?}, not from a constant"
    );
}

/// **TEST-E1-8** [invariant: INV-2] [covers: ITEM-7] — a well-formed but UNPUBLISHED
/// declared env fails with a typed, named error rather than silently running in the
/// deployment default image.
///
/// This is the failure mode the whole item exists to prevent, at the layer a job
/// actually hits it: the registry is open, so `resolve` happily produces a reference for
/// any well-formed id, and the failure must surface at PULL naming the env — never as a
/// substitution.
///
/// Runs without a server: it exercises the provider directly, which is where the
/// decision is made.
/// Lifecycle id: **TEST-28** (see `.lifecycle/analysis-env-selection/TESTS.md`).
#[tokio::test]
async fn an_unpublished_declared_env_fails_by_name_and_never_substitutes() {
    use txresbench::modules::sandbox::env_image::{
        resolve, EnvImageProvider, OciEnvImageProvider,
    };
    use std::time::Duration;

    // A well-formed id that no recipe publishes. It still RESOLVES — the registry is
    // open by design, which is exactly why the guard has to be at the fetch, not a
    // name allowlist.
    const UNPUBLISHED: &str = "fixture-unpublished-env";
    let r = resolve(UNPUBLISHED).expect("a well-formed id always resolves to its own repo");
    assert!(
        r.oci_ref.ends_with(UNPUBLISHED),
        "the env-id is the trailing repo component, carried verbatim: {}",
        r.oci_ref
    );

    // Provide must FAIL. A short budget keeps this from waiting on a real registry.
    let err = tokio::task::spawn_blocking(|| {
        OciEnvImageProvider::new().provide(UNPUBLISHED, Duration::from_secs(20))
    })
    .await
    .expect("no panic")
    .expect_err("an unpublished env must fail the job, never fall back to another image");

    // The error names the env, and is a typed ENV_IMAGE_* code — not a generic failure
    // and, above all, not an Ok mounting some other env's rootfs.
    assert!(
        err.error_code().starts_with("ENV_IMAGE_") || err.error_code().starts_with("ENV_ROOTFS_"),
        "typed env-image failure, got {}: {err}",
        err.error_code()
    );
}

/// **INV-7** [acceptance] — the submodule PINS have not moved on this branch.
///
/// An epic-wide standing constraint (`sdk` at `6cf9426`, `agent-kit` at `e47ca31`), and
/// one worth an executable check rather than a promise: a submodule pin moves by
/// accident far more easily than it moves on purpose — any `git submodule update
/// --remote`, any IDE that helpfully syncs, any `git add -A` after a stray checkout
/// inside the submodule — and the resulting commit looks like a one-line gitlink change
/// that reviewers skim past.
///
/// Asserted as "unchanged FROM THE MERGE BASE" rather than against a hardcoded sha, so
/// the test states the actual invariant (this branch does not move the pins) and does
/// not itself need editing the next time the pins are deliberately bumped on main.
/// Lifecycle id: **TEST-29** (see `.lifecycle/analysis-env-selection/TESTS.md`).
#[test]
fn the_submodule_pins_do_not_move_on_this_branch() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let run = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
    };

    let Some(base) = ["origin/main", "main"].iter().find_map(|r| {
        run(&["merge-base", r, "HEAD"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }) else {
        // No base ref to compare against (a shallow/exported checkout) — say so rather
        // than passing silently, which would be a green test that checked nothing.
        eprintln!("skip: no origin/main or main ref to resolve a merge base against");
        return;
    };

    // The gitlink entries at the merge base and at HEAD, for the whole submodule set —
    // DERIVED from `.gitmodules`, so a submodule added later is covered with no edit here.
    let modules = std::fs::read_to_string(root.join(".gitmodules")).expect("read .gitmodules");
    let paths: Vec<String> = modules
        .lines()
        .filter_map(|l| l.trim().strip_prefix("path = ").map(str::to_string))
        .collect();
    assert!(
        !paths.is_empty(),
        "no submodules parsed from .gitmodules — the comparison below would be vacuous"
    );

    for p in &paths {
        let at_base = run(&["rev-parse", &format!("{base}:{p}")]);
        let at_head = run(&["rev-parse", &format!("HEAD:{p}")]);
        // Both sides must RESOLVE. Without this, an untracked path or a sparse checkout
        // makes both `None`, the equality below holds, and the test reports PASS having
        // compared nothing — the "green test that checked nothing" its own doc rejects.
        assert!(
            at_base.is_some() && at_head.is_some(),
            "could not resolve the gitlink for submodule {p:?} at the base and at HEAD \
             (base={at_base:?}, head={at_head:?}); the comparison below would be vacuous"
        );
        // The pin invariant applies to GITLINKS. The sanitised checkout this suite
        // runs against flattens the submodules into ordinary tracked trees (no
        // `.git` inside, `git ls-tree` reports mode 040000 rather than 160000), so
        // there is no pin to compare and the tree hash changes with any vendored
        // edit. Detect that regime and state it rather than failing a comparison
        // that has no meaning here.
        let mode = |rev: &str| {
            run(&["ls-tree", rev, p])
                .map(|s| s.split_whitespace().next().unwrap_or("").to_string())
        };
        let base_mode = mode(&base);
        let head_mode = mode("HEAD");
        if base_mode.as_deref() != Some("160000") || head_mode.as_deref() != Some("160000") {
            eprintln!(
                "skip pin comparison for {p:?}: the checkout vendors this submodule as a \
                 tracked tree (modes {base_mode:?} → {head_mode:?}) rather than a gitlink; \
                 the pin invariant applies only to real gitlinks"
            );
            continue;
        }
        assert_eq!(
            at_base, at_head,
            "submodule {p:?} pin MOVED on this branch (base {at_base:?} → HEAD {at_head:?}); \
             the pins are a standing epic constraint and this branch may not change them"
        );
    }
}

/// **PROV-E1-2, the CONNECTEDNESS proof** [acceptance] [invariant: INV-1] — a declared
/// env survives EVERY hop from the registry declaration to the `ComputeSpec` the backend
/// is handed, for BOTH contribution kinds.
///
/// Added after a blind audit observed that the per-hop unit tests left two hops with no
/// coverage at all — `runner.rs`'s `env_id: spec.env.clone()` at both `ComputeSpec`
/// construction sites, and the converter threading at `dataset/routes.rs`,
/// `dataset/process.rs` and `drafts/freeze.rs`. Either could have been reverted with the
/// whole suite still green, which is precisely the failure this contract exists to
/// prevent: before #189 every individual layer was reasonable and the env-id still never
/// reached a run, because each layer dropped it independently.
///
/// The assertion is on the value that arrives at the END of the chain, so a break at any
/// intermediate hop fails it.
/// Lifecycle id: **TEST-33** (see `.lifecycle/analysis-env-selection/TESTS.md`).
#[tokio::test]
async fn a_declared_env_survives_every_hop_to_the_compute_spec() {
    use txresbench::modules::sandbox::backend::{ComputeSpec, PriorityClass, ResourceClass};
    use txresbench::modules::sandbox::spec::AnalysisSpec;

    const DECLARED: &str = "fixture-declared-env";

    // ── the ANALYSIS kind: registry declaration → params → AnalysisSpec → ComputeSpec ──
    // The params bag is built exactly as `drafts/freeze.rs` builds it from a
    // `ResolvedAnalysisEntry` (which now carries `env`).
    let params = serde_json::json!({
        "language": "python",
        "code_ref": "compute/e.py",
        "package": "pkg",
        "analysis_id": "pkg.declared",
        "env": DECLARED,
        "params": {},
    });
    let spec = AnalysisSpec::parse(&params).expect("the enqueued params parse");
    assert_eq!(
        spec.env.as_deref(),
        Some(DECLARED),
        "hop 1: the declared env must survive the Job.params round trip"
    );

    // hop 2: the runner's ComputeSpec construction (both sites do `env_id: spec.env.clone()`).
    let compute = ComputeSpec {
        job_id: uuid::Uuid::new_v4(),
        workspace_root: std::path::PathBuf::from("/tmp/ws"),
        outputs_dir: std::path::PathBuf::from("/tmp/out"),
        command: String::new(),
        input_mounts: vec![],
        code_mount: None,
        extra_mounts: vec![],
        profile: txresbench::modules::sandbox::backend::ResourceProfile {
            memory_max_bytes: 1,
            memory_swap_max_bytes: 1,
            pids_max: 1,
            cpu_max: "max 100000".into(),
            timeout_secs: 1,
        },
        priority: PriorityClass::Normal,
        resource_class: ResourceClass::CpuSandbox,
        env_id: spec.env.clone(),
    };
    assert_eq!(
        compute.env_id.as_deref(),
        Some(DECLARED),
        "hop 2: the ComputeSpec the backend is handed must carry the declared env"
    );

    // hop 3: what the backend resolves from it — the value that reaches `provide()`.
    // With no operator override set, the declared env wins.
    let resolved =
        txresbench::modules::sandbox::env_image::resolve_env_id(compute.env_id.as_deref());
    assert_eq!(
        resolved.as_deref(),
        Some(DECLARED),
        "hop 3: the env-id handed to the image provider must be the DECLARED one"
    );

    // ── the CONVERTER kind: the same chain, from the shape the on-ingest / on-integrate
    //    paths build (no `analysis_id`; `env` comes straight off the resolved converter).
    let conv_params = serde_json::json!({
        "language": "python",
        "code_ref": "compute/conv.py",
        "package": "pkg",
        "env": DECLARED,
        "params": {},
    });
    let conv = AnalysisSpec::parse(&conv_params).expect("the converter params parse");
    assert_eq!(
        conv.env.as_deref(),
        Some(DECLARED),
        "a converter's declared env must survive the same round trip — PROV-E1-2 covers \
         BOTH contribution kinds, and the converter half had no test at all"
    );
    assert_eq!(
        txresbench::modules::sandbox::env_image::resolve_env_id(conv.env.as_deref()).as_deref(),
        Some(DECLARED)
    );

    // ── the CONTROL: an env-LESS spec still resolves the deployment default, so the
    //    assertions above cannot be satisfied by a resolver that returns its argument.
    let bare = AnalysisSpec::parse(&serde_json::json!({
        "language": "python", "code_ref": "compute/e.py"
    }))
    .unwrap();
    assert_eq!(bare.env, None);
    assert_eq!(
        txresbench::modules::sandbox::env_image::resolve_env_id(bare.env.as_deref()),
        txresbench::modules::sandbox::env_image::default_env_id(),
        "an env-less job resolves exactly what it resolved before per-job selection (INV-1)"
    );
}

/// **PROV-E1-4, the RECORDING hop** [acceptance] [invariant: INV-3] — the digest a run
/// mounted is what `build_new_run` records as that run's `env_rootfs_sha256`, and two
/// concurrently-finalizing runs each record their own.
///
/// Added because a blind audit observed that the recording hop — the contract's actual
/// claim, *"a run RECORDS the digest of the image THAT RUN mounted"* — had no test:
/// every existing test sets that column by raw SQL, and the capsule tier SELF-SKIPS when
/// the digest is absent, so a silently broken sidecar read would have reported SKIP
/// rather than FAIL.
/// Lifecycle id: **TEST-34** (see `.lifecycle/analysis-env-selection/TESTS.md`).
#[tokio::test]
async fn a_run_records_the_digest_its_own_workspace_carries() {
    use txresbench::modules::sandbox::env_image::{read_run_env_digest, write_run_env_digest};

    // Two runs, two workspaces, two DIFFERENT digests — the configuration in which a
    // process-global carrier records the wrong one.
    let mk = |tag: &str, hex: &str| {
        let root = std::env::temp_dir().join(format!("txr-rec-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        write_run_env_digest(&root, Some(hex));
        (root, hex.to_string())
    };
    let (root_a, hex_a) = mk("a", &"a".repeat(64));
    let (root_b, hex_b) = mk("b", &"b".repeat(64));

    // Finalize both CONCURRENTLY and assert each reads back its own — this is the value
    // `recorder::record` passes to `build_new_run` as `env_rootfs_sha256`.
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for (root, want) in [(root_a.clone(), hex_a.clone()), (root_b.clone(), hex_b.clone())] {
        let barrier = std::sync::Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            assert_eq!(
                read_run_env_digest(&root).as_deref(),
                Some(want.as_str()),
                "each finalizing run must read back the digest ITS OWN workspace carries"
            );
        }));
    }
    for h in handles {
        h.join().expect("no finalize thread panicked");
    }

    // A run that mounted NOTHING records None — never a neighbour's digest. This is the
    // honest record for an in-app interaction run or a promote/byte-copy run.
    let empty = std::env::temp_dir().join(format!("txr-rec-none-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(read_run_env_digest(&empty), None);

    // A RETRY that mounts a seam with no content identity must not inherit the previous
    // attempt's digest — the workspace is deliberately preserved across a failed
    // finalize, so this is reachable.
    write_run_env_digest(&root_a, None);
    assert_eq!(
        read_run_env_digest(&root_a),
        None,
        "a retry with no digest must CLEAR the stale sidecar, not inherit it"
    );

    for r in [root_a, root_b, empty] {
        let _ = std::fs::remove_dir_all(r);
    }
}
