//! Sandbox + rootfs integration tests over the SDK harness (real spawned server
//! + Postgres). Rootfs/bwrap-needing assertions are gated on
//! `SandboxAvailability::Ready` (Linux + bwrap + squashfuse + a real, non-stub
//! embedded rootfs) — a legit environment gate, mirroring ziee's rootfs tier.

use serde_json::{json, Value};

use crate::common::TestServer;
// Every self-skip in this file goes through the shared recorder, so it lands in
// `target/test-skip-ledger.tsv` — the only channel that survives libtest's capture
// of a PASSING test. A bare `eprintln!` skip reads as a green run.
use crate::dataset::hardening_common::record_skip;

mod admission_test;
mod env_image_oci_test;
mod env_image_test;
// #80 — the manual env-image republish path (runbook + script) is real and cannot
// drift from the disabled CI workflow it stands in for. Pure file-parity assertions:
// no server, no database.
mod env_publish_runbook_test;
// #196 — the build-tier SCRIPTS derive the env set from the union of both contribution
// kinds. They sit outside every other Rust gate (nothing compiles or runs them), which is
// how the fetch script's converters-only reader survived. Synthetic trees, no network.
mod env_script_derivation_test;
mod settings_test;
// T3 / ITEM-6 (PROV-T3-1): the saas-gated KubernetesBackend job-per-run (runtime-self-skips
// via record_skip when no kind cluster is reachable). The file is `#![cfg(feature = "saas")]`
// so it compiles to empty in the desktop/default build.
mod kubernetes_backend_test;
// #66 / k8s-jobrun-dataplane: the in-pod one-shot executor (`cytoanalyst run-job`) the
// job-per-run KubernetesBackend pod runs — stage inputs from the object store → bwrap →
// finalize outputs back. Not saas-gated (the executor core is location-agnostic); the real-run
// legs self-skip when no rootfs is usable.
mod jobrun_inpod_test;
// ITEM-7 — the sandbox-stacked integration suite (real loopback OCI registry +
// real stacked bwrap runs + the four-route matrix + the preflight runbook; the
// real-run legs self-skip via record_skip when the host cannot execute, like
// the other rootfs-gated suites here).
mod method_stack_test;
// #189 (E1) — per-job env selection end to end: the wire-stability measurement, the
// INV-1 no-declared-env regression baseline, and the unpublished-env refusal.
mod per_job_env_test;
// #194 (E6) — the WALKING SKELETON: the first R analysis this platform executes, end to
// end through the real job path, and the substitution refusal that stops "R is broken"
// from being how an operator learns they staged the python rootfs.
mod r_walking_skeleton_test;

/// First-run setup → returns the owner's access token.
async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "sbxadmin",
            "email": "sbx@cyto.test",
            "password": "sbxPassw0rd!",
            "display_name": "Sandbox Admin"
        }))
        .send()
        .await
        .expect("setup/admin request");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    let body: Value = resp.json().await.expect("setup/admin json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("setup response carries an access token")
        .to_string()
}

/// Create a restricted (no-permission) user via the admin API and log in as
/// them → their access token.
async fn restricted_user_token(server: &TestServer, admin: &str) -> String {
    let create = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": "sbxuser",
            "email": "sbxuser@cyto.test",
            "password": "sbxUserP0!",
            "permissions": []
        }))
        .send()
        .await
        .expect("create user request");
    let s = create.status().as_u16();
    assert!(s == 201 || s == 200, "create restricted user -> {s}");

    let login = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": "sbxuser", "password": "sbxUserP0!" }))
        .send()
        .await
        .expect("login request");
    assert_eq!(login.status().as_u16(), 200, "restricted user can log in");
    let body: Value = login.json().await.expect("login json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("login carries a token")
        .to_string()
}

async fn get_status(server: &TestServer, token: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url("/sandbox/status"))
        .bearer_auth(token)
        .send()
        .await
        .expect("status request");
    assert_eq!(resp.status().as_u16(), 200, "admin reads sandbox status");
    resp.json().await.expect("status json")
}

// TEST-16: status endpoint (admin) + boot recorded availability + rootfs shape.
#[tokio::test]
async fn status_reports_availability_and_rootfs() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let status = get_status(&server, &token).await;
    let availability = status["availability"]
        .as_str()
        .expect("availability string");
    assert!(
        [
            "ready",
            "rootfs_unavailable",
            "host_unsupported",
            "workspace_init_failed"
        ]
        .contains(&availability),
        "availability is a known variant: {availability}"
    );
    let rootfs = &status["rootfs"];
    assert!(
        rootfs["schema_version"].is_number(),
        "rootfs has a schema_version"
    );
    assert!(rootfs["supported"].is_boolean());
    assert!(rootfs["extracted"].is_boolean());
    assert!(rootfs["mounted"].is_boolean());
}

// TEST-17: settings GET/PUT roundtrip + 422 on out-of-range.
#[tokio::test]
async fn settings_get_put_roundtrip_and_validation() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // GET the seeded singleton.
    let get = server
        .client
        .get(server.api_url("/sandbox/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("get settings");
    assert_eq!(get.status().as_u16(), 200);
    let before: Value = get.json().await.expect("settings json");
    assert!(
        before["timeout_secs"].is_number(),
        "seeded row has timeout_secs"
    );

    // PUT a valid change → persists.
    let put = server
        .client
        .put(server.api_url("/sandbox/settings"))
        .bearer_auth(&token)
        .json(&json!({ "timeout_secs": 321, "pids_max": 256 }))
        .send()
        .await
        .expect("put settings");
    assert_eq!(put.status().as_u16(), 200);
    let after: Value = put.json().await.expect("put json");
    assert_eq!(after["timeout_secs"], json!(321));
    assert_eq!(after["pids_max"], json!(256));

    // Read-back confirms persistence.
    let reget: Value = server
        .client
        .get(server.api_url("/sandbox/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("reget")
        .json()
        .await
        .expect("reget json");
    assert_eq!(reget["timeout_secs"], json!(321));

    // PUT out-of-range → 422 SANDBOX_LIMIT_OUT_OF_RANGE.
    let bad = server
        .client
        .put(server.api_url("/sandbox/settings"))
        .bearer_auth(&token)
        .json(&json!({ "timeout_secs": 0 }))
        .send()
        .await
        .expect("bad put");
    assert_eq!(bad.status().as_u16(), 422, "out-of-range is 422");
    let bad_body: Value = bad.json().await.expect("422 json");
    assert_eq!(bad_body["error_code"], json!("SANDBOX_LIMIT_OUT_OF_RANGE"));
}

// TEST-18: a restricted user is 403'd on every sandbox endpoint (backend-deny).
#[tokio::test]
async fn restricted_user_is_forbidden() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let user = restricted_user_token(&server, &admin).await;

    for (method, path, needs) in [
        ("GET", "/sandbox/settings", "sandbox::settings::read"),
        ("PUT", "/sandbox/settings", "sandbox::settings::manage"),
        ("POST", "/sandbox/execute", "sandbox::execute"),
    ] {
        let req = match method {
            "GET" => server.client.get(server.api_url(path)),
            "PUT" => server
                .client
                .put(server.api_url(path))
                .json(&json!({ "timeout_secs": 100 })),
            _ => server
                .client
                .post(server.api_url(path))
                .json(&json!({ "command": "echo hi" })),
        };
        let resp = req.bearer_auth(&user).send().await.expect("request");
        assert_eq!(resp.status().as_u16(), 403, "{method} {path} is forbidden");
        let body: Value = resp.json().await.expect("403 json");
        assert_eq!(body["error_code"], json!("INSUFFICIENT_PERMISSIONS"));
        // The wire body puts the human message under `error` (ApiError shape).
        let msg = body["error"].as_str().unwrap_or("");
        assert!(msg.contains(needs), "403 message names {needs}: {msg}");
    }
}

// TEST-19 + TEST-20: the gold execute path + extract-on-first-use, gated on a
// real embedded rootfs. On a stub build (no docker at build time) both executes
// return 503 and status stays not-mounted (also a real, asserted behavior).
//
// ── THE R BRANCH IS GONE, DELIBERATELY (owner decision) ─────────────────────
//
// This test used to run `Rscript -e 'cat(1+1)'` first and assert exit 0. The
// schema-v5 env recipe (`env-rootfs/<env-id>/Dockerfile`, line 13) does not ship
// an R interpreter — it records, verbatim, "DROPS r-base-core (no R processor
// exists — re-add if one lands)". Both the assertion and that removal PRE-DATE
// this branch, so for as long as the v5 image has been published the assertion
// has been certifying a capability the recipe intentionally removed; it survived
// only because the whole 200-branch is reached solely on a host with a real PID
// namespace AND a mounted rootfs.
//
// DO NOT "restore" the R half without first re-adding `r-base-core` to that
// recipe AND republishing the image: the interpreter is a property of the IMAGE,
// not of the sandbox, and a test cannot conjure it.
//
// WHAT SURVIVES STILL DISCRIMINATES. The probe is `python3 -c 'print(6*7)'` and
// the assertion is that stdout contains `42` — a value that appears NOWHERE in
// the request. Nothing short of a real interpreter evaluating the expression
// inside the rootfs produces it: an echo, a shim, a canned 200 or a shell that
// merely accepted the string all yield `6*7` (or nothing) and fail. Exit code 0
// plus the TEST-20 extracted+mounted assertions are checked on the same path.
#[tokio::test]
async fn execute_runs_python_when_ready_else_503() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    async fn execute(server: &TestServer, token: &str, cmd: &str) -> (u16, Value) {
        let resp = server
            .client
            .post(server.api_url("/sandbox/execute"))
            .bearer_auth(token)
            .json(&json!({ "command": cmd }))
            .send()
            .await
            .expect("execute request");
        let status = resp.status().as_u16();
        let body = resp.json().await.unwrap_or(Value::Null);
        (status, body)
    }

    // Branch on the EXECUTE outcome, not the (optimistic) boot availability: the
    // strict-PID-ns probe runs lazily at first execute, so a host that lacks a
    // real PID namespace (a restricted/container kernel) boots "ready" but then
    // SECURELY refuses at execute (FB HIGH-1) rather than run with host /proc.
    // Both outcomes are correct + asserted; the sandbox NEVER runs insecurely.
    let (s, body) = execute(&server, &token, "python3 -c 'print(6*7)'").await;
    if s == 200 {
        // Host provides a real PID namespace → the gold path ran for real.
        assert_eq!(body["exit_code"], json!(0), "python exit 0 (body: {body})");
        // `42` is the PRODUCT, not the input: the request carries `6*7`, so this
        // string can only come from an interpreter that evaluated it in the rootfs.
        let stdout = body["stdout"].as_str().unwrap_or("");
        assert!(stdout.contains("42"), "python printed 42: {body}");
        assert!(
            !stdout.contains("6*7"),
            "stdout echoed the SOURCE instead of its value — nothing evaluated it: {body}"
        );

        // ── TEST-20: the rootfs the run used is REALLY there afterwards ─────────
        //
        // SECOND stale assertion in this test, unmasked by removing the first (see the
        // R note above). `rootfs.extracted` does NOT mean "some rootfs is available";
        // `rootfs::status` derives it from `embedded::content_sha256_full()`, i.e. from
        // the EMBEDDED `include_bytes!` slot. That slot is a 0-BYTE STUB on any build
        // made without docker present — the boot log says so in as many words — and the
        // analysis rootfs is lazy-fetched from the OCI registry instead. So an
        // unconditional `extracted == true` certifies the RETIRED delivery mechanism,
        // exactly as `Rscript` certified a retired interpreter.
        //
        // Branch on the BUILD, assert a real property either way, never a silent pass —
        // the idiom every other real-execute test in this file already uses.
        let after = get_status(&server, &token).await;
        let embedded_bytes = after["rootfs"]["embedded_bytes"].as_u64().unwrap_or(0);
        if embedded_bytes > 0 {
            // A build that DOES embed the archive: extract-on-first-use, unchanged.
            assert_eq!(
                after["rootfs"]["extracted"],
                json!(true),
                "extracted after run (embedded slot is {embedded_bytes} bytes)"
            );
            assert_eq!(after["rootfs"]["mounted"], json!(true), "mounted after run");
        } else {
            // The lazy-fetch build. The field describes the EMBEDDED slot, so `false` is
            // the correct answer — asserted rather than skipped, so this branch is taken
            // for a CHECKED reason and would fail if the field ever stopped reporting
            // the slot it names.
            assert_eq!(
                after["rootfs"]["extracted"],
                json!(false),
                "the embedded slot is a 0-byte stub, so nothing was extracted FROM IT; \
                 a `true` here means the field changed meaning: {after}"
            );
            // …and the rootfs is proven present BEHAVIOURALLY, which is the substance of
            // TEST-20: a SECOND command still runs, so the mount the first call
            // established persists, and it resolves the env recipe's own venv prefix —
            // a directory that exists inside the analysis image and not on the host, so
            // this cannot pass against a host interpreter leaking through.
            let (s2, body2) = execute(
                &server,
                &token,
                "python3 -c \"import os; print('VENV' if os.path.isdir('/opt/venv') else 'NOVENV')\"",
            )
            .await;
            assert_eq!(
                s2, 200,
                "the fetched rootfs still serves a second call: {body2}"
            );
            assert_eq!(body2["exit_code"], json!(0), "second call exit 0: {body2}");
            assert!(
                body2["stdout"].as_str().unwrap_or("").contains("VENV")
                    && !body2["stdout"].as_str().unwrap_or("").contains("NOVENV"),
                "the interpreter that ran is the one INSIDE the mounted image: {body2}"
            );
        }
    } else {
        // Secure refusal: NO real PID namespace (HIGH-1) or a stub build — either
        // way a graceful 503 SANDBOX_UNAVAILABLE, and no command ever runs. (The
        // read-only rootfs may still be mounted — harmless; the security property
        // is that no COMMAND executes with host /proc, proven by the 503.)
        assert_eq!(s, 503, "secure refusal is a graceful 503 (body: {body})");
        assert_eq!(body["error_code"], json!("SANDBOX_UNAVAILABLE"));
        let (s2, body2) = execute(&server, &token, "echo hi").await;
        assert_eq!(s2, 503, "still 503 on a second call (body: {body2})");
    }
}

// ═══════════ TEST-7 [acceptance] [invariant: INV-4] — THE R PROBE, RESTORED ══════════
//
// The note above says, verbatim:
//
//     DO NOT "restore" the R half without first re-adding `r-base-core` to that recipe
//     AND republishing the image: the interpreter is a property of the IMAGE, not of the
//     sandbox, and a test cannot conjure it.
//
// Epic #169 is the point at which that precondition is met — with one honest amendment.
// E3 (#191) added a SECOND env recipe, built on an R base image and shipping a real R
// interpreter, which is what makes the precondition satisfiable at all. Which recipe that
// is, this file does not say and does not need to: the probe below asks the REGISTRY for
// the env the shipped R analysis declares. The image is NOT republished: publishing is gated (#80, and #217 makes the
// publish script's step 1b unpassable for any recipe today). So the standing instruction's
// SUBSTANCE is honoured — the interpreter is a property of the image and this test does
// not conjure one — by gating on the image being AVAILABLE rather than on it being
// published: E5 (#193) builds it locally and hands it to the runtime through the env-scoped
// air-gap seam, which is the production mechanism for an air-gapped deployment.
//
// The probe DISCRIMINATES the way the surviving python one does (E6/DEC-4): `42` is the
// PRODUCT, not the input. The request carries `6*7`, so an echo, a shim, a canned 200 or a
// shell that merely accepted the string all yield `6*7` or nothing and FAIL. A second
// probe asks for a string only R emits at all.
//
// It is `#[cfg(test)]`-tier only: restoring it needs no `src-app/server/src` change, which
// is INV-4 from the other side.

/// The R env, and the artifact staged for it — both derived, never typed. See
/// `r_walking_skeleton_test::shipped_rscript_analysis` for why.
///
/// The two failure modes are kept APART, because they have different remedies and a skip
/// reason that names the wrong one sends the next reader to the wrong place. "The tree
/// declares no R analysis" is a property of the TREE (someone dropped the package); "the
/// image is not staged" is a property of this HOST (run the local build loop). Folding
/// them into one message would print "build an image" for a missing package, which is
/// exactly the false-reason failure the sibling module panics rather than commits.
enum RProbeSubject {
    Ready(String),
    NoRAnalysis,
    NotStaged(String),
}

fn r_env_if_staged() -> RProbeSubject {
    let Some(r) = r_walking_skeleton_test::shipped_rscript_analysis() else {
        return RProbeSubject::NoRAnalysis;
    };
    match r_walking_skeleton_test::staged_artifact(&r.env_id) {
        Some(_) => RProbeSubject::Ready(r.env_id),
        None => RProbeSubject::NotStaged(r.env_id),
    }
}

#[tokio::test]
async fn execute_runs_r_inside_the_r_image_when_it_is_available() {
    const T: &str = "sandbox::r_interpreter_probe";
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let env_id = match r_env_if_staged() {
        RProbeSubject::Ready(id) => id,
        // NOT a skip. The shipped tree either declares an R analysis or the item that
        // ships one did not land — a property of the TREE, not of this host. Reporting it
        // as an environmental gate would print "build an image" for a missing package.
        RProbeSubject::NoRAnalysis => panic!(
            "{T}: no shipped analysis declares an R runtime WITH an `env`, so there is no \
             env for this probe to point the deployment at. That is a property of the \
             tree, not of this host."
        ),
        RProbeSubject::NotStaged(id) => {
            record_skip(
                T,
                &format!(
                    "the R env image `{id}` is not staged for this run. Build it with \
                     `sh scripts/build-env-rootfs-local.sh --env {id}` and export the \
                     per-env seam it prints (`--print-seam`). The interpreter is a \
                     property of the IMAGE; this test does not conjure one."
                ),
            );
            return;
        }
    };

    async fn execute(server: &TestServer, token: &str, cmd: &str) -> (u16, Value) {
        let resp = server
            .client
            .post(server.api_url("/sandbox/execute"))
            .bearer_auth(token)
            .json(&json!({ "command": cmd }))
            .send()
            .await
            .expect("execute request");
        let status = resp.status().as_u16();
        let body = resp.json().await.unwrap_or(Value::Null);
        (status, body)
    }

    /// Move (or clear, with `""`) the DEPLOYMENT DEFAULT env through the admin settings
    /// row — the supported operator route, and the one `resolve_env_id` step 3 reads.
    async fn set_default_env(server: &TestServer, token: &str, value: &str) -> u16 {
        server
            .client
            .put(server.api_url("/sandbox/settings"))
            .bearer_auth(token)
            .json(&json!({ "default_env_id": value }))
            .send()
            .await
            .expect("set the deployment default env")
            .status()
            .as_u16()
    }

    // ── WHY THIS TEST GATHERS FIRST AND ASSERTS LAST ───────────────────────────────
    //
    // `POST /sandbox/execute` is the ad-hoc seam: it carries no contribution, so it
    // deliberately takes NO per-job env (`service.rs`, DEC-4) and uses the deployment
    // default. The admin settings row is the supported operator route to move that, and
    // it is read live from the settings-cache snapshot `resolve_env_id` step 3 consults.
    //
    // But that snapshot is PROCESS-GLOBAL with a `LOADED` latch — it is not per-server —
    // so a value left behind here is inherited by every later test in this binary, which
    // would silently re-point THEIR deployment default at the R image. (The pre-existing
    // `settings_test.rs` sets and then clears for exactly this reason.)
    //
    // So the probes are RUN first, their results captured into locals, the global is
    // CLEARED, and only then is anything asserted.
    //
    // Two things this deliberately does NOT claim. (1) The window is NARROWED, not closed:
    // the four `.expect()`s below (three probes and the settings write) can still panic
    // inside it. Closing it entirely needs unwind machinery, which is a bigger hammer than
    // a test-tier ordering problem deserves — but "narrowed" is what is true. (2) It is a
    // CLEAR, not a restore: `""` means "back to auto-detect" (`sandbox/settings.rs` reads
    // absent/empty as unset), which is the value this binary starts with. If some future
    // test sets a NON-empty default and expects it to survive, this clobbers it — and that
    // test should set its own, for the same reason this one clears.
    assert_eq!(
        set_default_env(&server, &token, &env_id).await,
        200,
        "the admin can point the deployment at the R env"
    );

    // Branch on the EXECUTE outcome, not on boot availability — the strict-PID-ns probe
    // runs lazily at first execute, so a host without a real PID namespace boots "ready"
    // and then SECURELY refuses. Both outcomes assert a real property; neither is a
    // silent pass.
    //
    // `6*7` is the request; `42` is the PRODUCT. An echo, a shim, a canned 200 or a shell
    // that merely accepted the string all yield `6*7` (or nothing) and fail.
    let (s, body) = execute(&server, &token, "Rscript -e 'cat(6*7)'").await;
    let (s2, body2) = if s == 200 {
        execute(&server, &token, "Rscript -e 'cat(R.version.string)'").await
    } else {
        (0, Value::Null)
    };
    let (s3, body3) = if s == 200 {
        execute(
            &server,
            &token,
            "Rscript -e \"cat(if (dir.exists(R.home())) 'RHOME' else 'NORHOME', R.home())\"",
        )
        .await
    } else {
        (0, Value::Null)
    };

    // RESTORE, before a single assertion can panic out of this function.
    let cleared = set_default_env(&server, &token, "").await;

    assert_eq!(cleared, 200, "the deployment default was CLEARED back to auto-detect for the rest of this binary");

    if s != 200 {
        assert_eq!(s, 503, "a non-executing host refuses gracefully (body: {body})");
        assert_eq!(body["error_code"], json!("SANDBOX_UNAVAILABLE"));
        record_skip(
            T,
            "this host cannot execute in the sandbox (no real PID namespace), so no \
             interpreter of any language can be probed here. The 503 refusal itself is \
             asserted above.",
        );
        return;
    }

    assert_eq!(body["exit_code"], json!(0), "R exits 0 (body: {body})");
    let stdout = body["stdout"].as_str().unwrap_or("");
    assert!(stdout.contains("42"), "R printed the PRODUCT 42: {body}");
    assert!(
        !stdout.contains("6*7"),
        "stdout echoed the SOURCE instead of its value — nothing evaluated it: {body}"
    );

    // …and the thing that evaluated it was R, not some other interpreter that also knows
    // how to multiply. `R.version.string` appears nowhere in the request and nothing but R
    // emits it.
    assert_eq!(s2, 200, "a second call still runs (body: {body2})");
    assert_eq!(body2["exit_code"], json!(0), "second call exit 0: {body2}");
    let ver = body2["stdout"].as_str().unwrap_or("");
    assert!(
        ver.starts_with("R version "),
        "the interpreter that ran identifies itself as R: {body2}"
    );

    // …and it is the interpreter INSIDE the mounted image, not one leaking from the host:
    // the R the recipe installs lives under the image's own prefix, which does not exist
    // on the host. This is the R twin of the python probe's `/opt/venv` assertion.
    assert_eq!(s3, 200, "third call runs (body: {body3})");
    let home = body3["stdout"].as_str().unwrap_or("");
    assert!(
        home.contains("RHOME") && !home.contains("NORHOME"),
        "R resolved its own home inside the mounted image: {body3}"
    );
}

// ----------------------------------------------------------------- P3: analysis jobs

use std::time::Duration;

/// Create an `analysis` job via /jobs; returns (status_code, body).
async fn create_analysis(
    server: &TestServer,
    token: &str,
    name: &str,
    script: &str,
) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({
            "job_type": "analysis",
            "name": name,
            "params": { "language": "python", "script": script }
        }))
        .send()
        .await
        .expect("create analysis job");
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

async fn poll_job(
    server: &TestServer,
    token: &str,
    id: &str,
    wanted: &[&str],
    timeout: Duration,
) -> Value {
    let start = tokio::time::Instant::now();
    loop {
        let resp = server
            .client
            .get(server.api_url(&format!("/jobs/{id}")))
            .bearer_auth(token)
            .send()
            .await
            .expect("get job");
        if resp.status().as_u16() == 200 {
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let s = body["job"]["status"].as_str().unwrap_or("");
            if wanted.contains(&s) {
                return body;
            }
        }
        if start.elapsed() > timeout {
            panic!("job {id} did not reach {wanted:?} in time");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// TEST-28: an analysis job runs end-to-end through the streaming sandbox runner
// when the sandbox is Ready (script writes /outputs/manifest.json → the run
// completes); ELSE it fails with a CLEAR backend-unavailable reason. Branch on
// the OUTCOME (a boot-"ready" host may still refuse at first-run via the PID-ns
// probe) — both outcomes are correct + asserted, never a skipped test.
#[tokio::test]
async fn analysis_job_runs_when_ready_else_fails_clearly() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // A script that produces a declared output + the canonical manifest.
    let script = "import os, json\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/result.txt', 'w').write('ok')\n\
json.dump({'outputs': [{'id':'r','datatype':'table','path':'result.txt','layout':'file','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'primary'}]}, open('/outputs/manifest.json','w'))\n\
print('analysis done')\n";
    let (code, body) = create_analysis(&server, &token, "e2e", script).await;
    assert_eq!(code, 201, "analysis job created (body: {body})");
    let id = body["id"].as_str().expect("job id").to_string();

    let detail = poll_job(
        &server,
        &token,
        &id,
        &["completed", "failed"],
        Duration::from_secs(90),
    )
    .await;
    match detail["job"]["status"].as_str().unwrap_or("") {
        "completed" => {
            // Ready path: it ran the scientific sandbox for real.
            assert_eq!(
                detail["job"]["exit_code"],
                json!(0),
                "clean exit (detail: {detail})"
            );
        }
        "failed" => {
            // Degraded path: a clear, non-empty failure reason (never a silent hang).
            let err = detail["job"]["error"].as_str().unwrap_or("");
            assert!(!err.is_empty(), "a failed analysis job carries a reason");
            assert!(
                err.contains("unavailable")
                    || err.contains("backend")
                    || err.contains("manifest")
                    || err.contains("sandbox")
                    || err.contains("Linux")
                    || err.contains("exited"),
                "failure reason is about the sandbox/backend/contract: {err}"
            );
        }
        other => panic!("unexpected terminal status {other}"),
    }
}

// TEST-29 + TEST-2(guards): a long-running analysis job stopped mid-run → stopped
// (its child + cgroup + guards are torn down); on a degraded build it fails
// cleanly instead (asserted).
#[tokio::test]
async fn analysis_job_cancel_or_fail_clean() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let (code, body) =
        create_analysis(&server, &token, "sleeper", "import time\ntime.sleep(120)\n").await;
    assert_eq!(code, 201);
    let id = body["id"].as_str().expect("job id").to_string();

    // Wait for it to reach running (Ready) or terminal (degraded).
    let detail = poll_job(
        &server,
        &token,
        &id,
        &["running", "failed", "completed", "stopped"],
        Duration::from_secs(60),
    )
    .await;
    if detail["job"]["status"] == "running" {
        // Ready path: stop it → stopped, promptly (teardown reaps the sandbox).
        let stop = server
            .client
            .post(server.api_url(&format!("/jobs/{id}/stop")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("stop");
        assert_eq!(stop.status().as_u16(), 200, "stop accepted");
        let after = poll_job(&server, &token, &id, &["stopped"], Duration::from_secs(20)).await;
        assert_eq!(
            after["job"]["status"],
            json!("stopped"),
            "cancel tore the run down"
        );
    } else {
        // Degraded path: it failed clean (no sandbox) — a valid, asserted outcome.
        assert_eq!(
            detail["job"]["status"],
            json!("failed"),
            "degraded → clean failure"
        );
    }
}

// TEST-30: the rootfs schema is v5 (uv scientific + spatial stack + Cell Ranger) and,
// when Ready, an in-sandbox `import scanpy` succeeds; else the analysis fails clean.
// (The name + prose said "v4" long after the assertion moved to 5; artifact-model
// ITEM-38 corrected them while removing the store library this line used to list.)
#[tokio::test]
async fn rootfs_schema_is_v5_and_scanpy_import() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // The schema version is v5 regardless of a stub vs real rootfs.
    let status = get_status(&server, &token).await;
    assert_eq!(
        status["rootfs"]["schema_version"],
        json!(5),
        "no-conda uv scientific + spatial rootfs is schema v5"
    );

    let (code, body) = create_analysis(
        &server,
        &token,
        "scanpy",
        "import scanpy, anndata, leidenalg, harmonypy, zarr\nprint('scientific stack present')\n\
import os, json\nos.makedirs('/outputs', exist_ok=True)\n\
json.dump({'outputs': []}, open('/outputs/manifest.json','w'))\n",
    )
    .await;
    assert_eq!(code, 201);
    let id = body["id"].as_str().expect("job id").to_string();
    let detail = poll_job(
        &server,
        &token,
        &id,
        &["completed", "failed"],
        Duration::from_secs(120),
    )
    .await;
    match detail["job"]["status"].as_str().unwrap_or("") {
        "completed" => assert_eq!(detail["job"]["exit_code"], json!(0), "scanpy import ran"),
        "failed" => {
            let err = detail["job"]["error"].as_str().unwrap_or("");
            assert!(
                !err.is_empty(),
                "clean failure reason on a degraded build: {err}"
            );
        }
        other => panic!("unexpected status {other}"),
    }
}

// TEST-21 (ITEM-12): Cell Ranger import-smoke — `cellranger --version` is on
// PATH inside the built rootfs. Rootfs-gated the same way the other real-execute
// sandbox tests are: it drives the REAL production path (execute → bwrap →
// command) and branches on the OUTCOME. Cell Ranger is present only when the
// rootfs was built with `CYTO_CELLRANGER_URL` (the 10x signed URL) supplied
// (DEC-12) — so on a stub / no-URL build this asserts a clean, reasoned failure
// (503 unavailable, or a non-zero exit naming `cellranger`/`not found`), never a
// silent pass. When present it asserts `--version` actually ran (exit 0 + a
// version line), proving the CLI is wired onto PATH.
#[tokio::test]
async fn cellranger_version_on_path_when_built_else_clean_fail() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .post(server.api_url("/sandbox/execute"))
        .bearer_auth(&token)
        .json(&json!({ "command": "cellranger --version" }))
        .send()
        .await
        .expect("execute cellranger --version");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);

    if status == 200 && body["exit_code"] == json!(0) {
        // Cell Ranger IS in this rootfs → `--version` ran on PATH.
        let out = format!(
            "{}{}",
            body["stdout"].as_str().unwrap_or(""),
            body["stderr"].as_str().unwrap_or("")
        );
        assert!(
            out.to_lowercase().contains("cellranger")
                || out.contains("cell ranger")
                || out.contains('.'),
            "cellranger --version printed a version banner: {body}"
        );
    } else if status == 200 {
        // Ready sandbox but Cell Ranger absent (no CYTO_CELLRANGER_URL at build):
        // a clean non-zero exit — command not found — never a hang.
        assert_ne!(
            body["exit_code"],
            json!(0),
            "absent cellranger → non-zero exit: {body}"
        );
        let out = format!(
            "{}{}",
            body["stdout"].as_str().unwrap_or(""),
            body["stderr"].as_str().unwrap_or("")
        );
        assert!(
            out.to_lowercase().contains("cellranger")
                || out.contains("not found")
                || out.contains("No such file")
                || out.contains("command"),
            "absent-cellranger failure names the missing command: {body}"
        );
    } else {
        // Degraded build (stub rootfs / no PID-ns): a graceful 503, no command ran.
        assert_eq!(
            status, 503,
            "secure/degraded refusal is a graceful 503: {body}"
        );
        assert_eq!(body["error_code"], json!("SANDBOX_UNAVAILABLE"));
    }
}

// ----------------------------------------------------------- ITEM-22: serve-by-digest

// TEST-22e (ITEM-22): the serve-by-digest endpoint is permission-gated and
// validates the digest — works on ANY build (no real rootfs needed):
//  - unauthenticated → 401
//  - a restricted (no-perm) user → 403
//  - a malformed digest → 400
//  - a well-formed but absent digest → 404
//  - the embedded digest, once extracted (Ready build), streams 200 octet-stream.
#[tokio::test]
async fn serve_rootfs_by_digest_gated_and_validated() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let user = restricted_user_token(&server, &admin).await;

    let good_absent = "a".repeat(64);
    let malformed = "not-a-valid-digest";

    // 401 unauthenticated.
    let unauth = server
        .client
        .get(server.api_url(&format!("/sandbox/rootfs/{good_absent}")))
        .send()
        .await
        .expect("unauth request");
    assert_eq!(unauth.status().as_u16(), 401, "no token → 401");

    // 403 restricted user (lacks sandbox::settings::read).
    let forbidden = server
        .client
        .get(server.api_url(&format!("/sandbox/rootfs/{good_absent}")))
        .bearer_auth(&user)
        .send()
        .await
        .expect("restricted request");
    assert_eq!(forbidden.status().as_u16(), 403, "no perm → 403");

    // 400 malformed digest (path-traversal guard rejects it before any fs hit).
    let bad = server
        .client
        .get(server.api_url(&format!("/sandbox/rootfs/{malformed}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("malformed request");
    assert_eq!(bad.status().as_u16(), 400, "malformed digest → 400");
    let bad_body: Value = bad.json().await.unwrap_or(Value::Null);
    assert_eq!(bad_body["error_code"], json!("ROOTFS_BAD_DIGEST"));

    // 404 well-formed but absent digest.
    let absent = server
        .client
        .get(server.api_url(&format!("/sandbox/rootfs/{good_absent}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("absent request");
    assert_eq!(absent.status().as_u16(), 404, "absent digest → 404");
    let absent_body: Value = absent.json().await.unwrap_or(Value::Null);
    assert_eq!(absent_body["error_code"], json!("ROOTFS_DIGEST_ABSENT"));

    // If the build shipped a real rootfs, extract it (via one execute) then the
    // embedded digest serves 200 with matching bytes. On a stub build the digest
    // is empty and this branch is skipped (asserted absent behavior above stands).
    let status = get_status(&server, &admin).await;
    let digest = status["rootfs"]["content_sha256"].as_str().unwrap_or("");
    if status["rootfs"]["supported"] == json!(true) && !digest.is_empty() {
        // Trigger extraction (idempotent) — execute may 200 or securely 503;
        // either way the extract-on-first-use path runs when supported.
        let _ = server
            .client
            .post(server.api_url("/sandbox/execute"))
            .bearer_auth(&admin)
            .json(&json!({ "command": "true" }))
            .send()
            .await;

        let after = get_status(&server, &admin).await;
        if after["rootfs"]["extracted"] == json!(true) {
            let served = server
                .client
                .get(server.api_url(&format!("/sandbox/rootfs/{digest}")))
                .bearer_auth(&admin)
                .send()
                .await
                .expect("serve present digest");
            assert_eq!(served.status().as_u16(), 200, "present digest streams 200");
            let ct = served
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            assert_eq!(ct, "application/octet-stream", "served as octet-stream");
            let bytes = served.bytes().await.expect("stream body");
            assert!(!bytes.is_empty(), "served squashfs is non-empty");
            assert_eq!(
                after["rootfs"]["embedded_bytes"].as_u64().unwrap_or(0),
                bytes.len() as u64,
                "served bytes == embedded rootfs length"
            );
        }
    }
}

// ─────────────────── TEST-22 (ITEM-16): inputs are hardlinked, never copied ──────

use std::collections::{HashMap, HashSet};
use std::path::Path;

use async_trait::async_trait;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use cytoanalyst::modules::sandbox::inputs::{input_mounts, materialize_inputs};
use cytoanalyst::modules::sandbox::spec::AnalysisSpec;
use cytoanalyst::modules::sandbox::types::MountMode;
use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::{
    BlobLink, ByteStream, ContentKey, GcReport, LocalFsStore, MultiFilePut, ObjectStat, ObjectStore,
};

async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// A store rooted at the SERVER's own workstore dir — the real blob pool, on the
/// real filesystem the real sandbox workspace shares (both are siblings under the
/// app data root, which is WHY the hardlink path is the normal path in a default
/// deployment rather than a lucky one).
fn server_store(server: &TestServer) -> LocalFsStore {
    LocalFsStore::new(server.data_dir().join("workstore"))
}

async fn admin_user_id(server: &TestServer, token: &str) -> Uuid {
    let me: Value = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(token)
        .send()
        .await
        .expect("/auth/me")
        .json()
        .await
        .expect("/auth/me json");
    Uuid::parse_str(me["user"]["id"].as_str().expect("user id")).expect("uuid")
}

async fn create_project(server: &TestServer, token: &str, name: &str) -> Uuid {
    let r = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(r.status().as_u16(), 201, "create project");
    let s: Value = r.json().await.expect("project json");
    Uuid::parse_str(s["id"].as_str().expect("project id")).unwrap()
}

fn new_artifact(
    project_id: Uuid,
    output_id: &str,
    object_key: &str,
    content_hash: &str,
    multifile: bool,
) -> NewArtifact {
    NewArtifact {
        project_id: Some(project_id),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        // A BUILT-IN root type (`datatype::builtin`), deliberately NOT a contributed
        // one: what this fixture feeds is the input-staging path (hardlink vs copy vs
        // bind), which never opens a byte and never asks what the artifact MEANS
        // (INV-1). Naming a domain id here would pin the sandbox suite to one
        // contributed bundle for a property that has nothing to do with it (INV-5).
        datatype: "data/opaque".to_string(),
        object_key: Some(object_key.to_string()),
        is_multifile: multifile,
        content_hash: content_hash.to_string(),
        structure: json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    }
}

/// A LOCAL store that refuses to hardlink — the negative control, and a faithful
/// stand-in for two real deployments at once:
///
///  * an S3 / remote backend, whose blobs are not local files at all
///    (`BlobLink::Unsupported` is literally the trait default it would inherit), and
///  * a local pool sitting on a different mount from the sandbox workspace, which
///    fails with `EXDEV`.
///
/// Both land in the SAME caller branch, so exercising it once covers both. Every
/// other method delegates, so the only variable under test is the link capability.
struct NoLinkStore(LocalFsStore);

#[async_trait]
impl ObjectStore for NoLinkStore {
    async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
        self.0.put(bytes).await
    }
    async fn put_prefix(&self, members: &[(String, Vec<u8>)]) -> Result<MultiFilePut, AppError> {
        self.0.put_prefix(members).await
    }
    async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
        self.0.get(key).await
    }
    async fn get_range(&self, k: &ContentKey, o: u64, l: u64) -> Result<Vec<u8>, AppError> {
        self.0.get_range(k, o, l).await
    }
    async fn get_stream(&self, k: &ContentKey, o: u64, l: u64) -> Result<ByteStream, AppError> {
        self.0.get_stream(k, o, l).await
    }
    /// The one behavioural difference.
    async fn link_blob(&self, _key: &ContentKey, _dest: &Path) -> BlobLink {
        BlobLink::Unsupported
    }
    async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError> {
        self.0.stat(key).await
    }
    async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
        self.0.exists(key).await
    }
    async fn delete(&self, key: &ContentKey) -> Result<(), AppError> {
        self.0.delete(key).await
    }
    async fn resolve_member(&self, m: &ContentKey, p: &str) -> Result<ContentKey, AppError> {
        self.0.resolve_member(m, p).await
    }
    async fn gc(&self, keep: &HashSet<String>, age: u64) -> Result<GcReport, AppError> {
        self.0.gc(keep, age).await
    }
}

/// Every `(device, inode)` under the blob pool, plus the file count.
///
/// Identity is checked by MEMBERSHIP in this set rather than by reconstructing
/// `blobs/<aa>/<bb>/<hex>` in the test, so the assertion does not silently rot if
/// the pool's on-disk fan-out ever changes — and so it needs no test-only accessor
/// on `LocalFsStore`.
#[cfg(unix)]
fn pool_inodes(root: &Path) -> (HashSet<(u64, u64)>, usize) {
    use std::os::unix::fs::MetadataExt;
    let mut set = HashSet::new();
    let mut stack = vec![root.join("blobs")];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(m) = std::fs::metadata(&path) {
                set.insert((m.dev(), m.ino()));
            }
        }
    }
    let n = set.len();
    (set, n)
}

#[cfg(unix)]
fn dev_ino(path: &Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).unwrap_or_else(|e| panic!("stat {}: {e}", path.display()));
    (m.dev(), m.ino())
}

#[cfg(unix)]
fn nlink(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).expect("stat staged input").nlink()
}

/// TEST-22 [covers: ITEM-16] — job inputs reach the sandbox by **hardlink + a
/// read-only bind**, and **no second copy of the blob exists**.
///
/// Verified by INODE IDENTITY, never by byte equality: a copy has identical bytes,
/// which is precisely why the copying defect this replaces survived a review that
/// checked the bytes. `ino()` is the only signal that separates the two.
///
/// Both materialization branches are covered, because both were wrong: the
/// multi-file prefix (the normal path — under the artifact model every Zarr
/// artifact is multi-file) and the single blob.
///
/// The negative control is the last section: a store that cannot link still
/// produces byte-correct inputs. Without it a green run would not distinguish
/// "hardlinks work" from "the fallback is unreachable".
#[cfg(unix)]
#[tokio::test]
async fn test22_inputs_are_hardlinked_from_the_pool_never_copied() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let owner = admin_user_id(&server, &token).await;
    let project = create_project(&server, &token, "item16").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let store_root = server.data_dir().join("workstore");
    let repo = CatalogRepository::new(pool.clone());

    // A multi-file artifact (a Zarr-shaped prefix) + a single-blob artifact, both
    // in the SERVER's real pool.
    let members: Vec<(String, Vec<u8>)> = vec![
        ("zarr.json".to_string(), br#"{"zarr_format":3}"#.to_vec()),
        ("c/0".to_string(), (0u8..255).cycle().take(70_000).collect()),
        ("c/1".to_string(), (7u8..200).cycle().take(50_000).collect()),
    ];
    let put = store.put_prefix(&members).await.expect("put_prefix");
    let multi = repo
        .insert_artifact(&new_artifact(
            project,
            "counts",
            put.object_key.as_str(),
            &put.content_hash,
            true,
        ))
        .await
        .expect("insert multifile artifact");

    let solo_bytes: Vec<u8> = (0u8..251).cycle().take(120_000).collect();
    let solo_key = store.put(&solo_bytes).await.expect("put blob");
    let solo = repo
        .insert_artifact(&new_artifact(
            project,
            "labels",
            solo_key.as_str(),
            solo_key.as_str(),
            false,
        ))
        .await
        .expect("insert single-file artifact");

    let (pool_set, pool_files_before) = pool_inodes(&store_root);

    // Stage exactly as the runner does: under `<data>/sandboxes/<job>/inputs`.
    let ws = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string());
    let inputs_dir = ws.join("inputs");
    // The two `sandbox_subpath`s are DELIBERATELY WRONG for these artifacts, and
    // deliberately kept: ITEM-23 makes an artifact-backed mount name a derivation from
    // the ARTIFACT (`derive_artifact_mount_name` = sanitized slot + a suffix read off
    // `structure.encoding`), so a manifest string is ignored. Both fixtures declare
    // `encoding: "opaque"` (see `new_artifact`), so neither earns a suffix — `counts.zarr`
    // would name an opaque blob as a Zarr store, which is the class of lie the derivation
    // exists to make unrepresentable.
    let spec = AnalysisSpec::parse(&json!({
        "language": "python", "script": "print(1)",
        "inputs": [
            { "slot": "counts", "artifact_ref": multi.id, "sandbox_subpath": "counts.zarr" },
            { "slot": "labels", "artifact_ref": solo.id, "sandbox_subpath": "labels.bin" },
        ],
    }))
    .expect("spec parses");

    let staged = materialize_inputs(&spec, &inputs_dir, owner, &[], &pool, &store)
        .await
        .expect("materialize inputs");
    assert_eq!(staged.len(), 2);

    // ── the mount NAME comes from the artifact, not from the declared string ────
    // Asserted as the PROPERTY, on both artifacts at once: every staged name is
    // `<slot><suffix-for-its-declared-encoding>`, and the declared `sandbox_subpath` of
    // an artifact-backed input reaches nothing. Every path assertion below is then taken
    // from `staged` (the runner's own report of where it put the bytes), so this is the
    // ONE place a naming change has to be re-agreed — the rest of the test can never
    // silently watch a path nothing writes to.
    let host_by_slot: HashMap<&str, &std::path::Path> = staged
        .iter()
        .map(|m| (m.slot.as_str(), m.host_path.as_path()))
        .collect();
    let artifact_by_slot: HashMap<&str, &Value> =
        [("counts", &multi.structure), ("labels", &solo.structure)]
            .into_iter()
            .collect();
    for m in &staged {
        let encoding = artifact_by_slot[m.slot.as_str()]["encoding"]
            .as_str()
            .expect("the consumed artifact declares an encoding");
        let suffix = if encoding == "zarr_v3" { ".zarr" } else { "" };
        assert_eq!(
            m.sandbox_path,
            format!("/inputs/{}{suffix}", m.slot),
            "slot {:?}: the mount name is derived from the artifact's declared encoding \
             ({encoding:?}), never from the spec's `sandbox_subpath`",
            m.slot
        );
        assert_eq!(
            m.host_path,
            inputs_dir.join(m.sandbox_path.trim_start_matches("/inputs/")),
            "slot {:?}: the host path is that same name under the run's inputs dir",
            m.slot
        );
    }
    assert!(
        !inputs_dir.join("counts.zarr").exists() && !inputs_dir.join("labels.bin").exists(),
        "the WRONG declared subpaths must reach the workspace under no name at all"
    );

    // ── every multi-file MEMBER is the pooled blob itself ───────────────────────
    for (rel, bytes) in &members {
        let at = host_by_slot["counts"].join(rel);
        assert_eq!(
            &std::fs::read(&at).expect("read member"),
            bytes,
            "member {rel} bytes"
        );
        assert!(
            pool_set.contains(&dev_ino(&at)),
            "staged member {rel} must BE a pooled blob (same inode), not a copy of one"
        );
        assert!(
            nlink(&at) >= 2,
            "member {rel} must have ≥2 names (pool + staging), got {}",
            nlink(&at)
        );
    }

    // ── the single blob likewise ───────────────────────────────────────────────
    let solo_at = host_by_slot["labels"].to_path_buf();
    assert_eq!(std::fs::read(&solo_at).expect("read blob"), solo_bytes);
    assert!(
        pool_set.contains(&dev_ino(&solo_at)),
        "a single-blob input must BE the pooled blob, not a copy of it"
    );
    assert!(nlink(&solo_at) >= 2);

    // ── NO second copy exists anywhere ─────────────────────────────────────────
    // Staging created no new blobs in the pool, and (the assertions above) no
    // independent bytes outside it. The whole staging tree is `n` extra directory
    // entries, not `n` extra files' worth of disk.
    let (pool_after, pool_files_after) = pool_inodes(&store_root);
    assert_eq!(
        pool_files_after, pool_files_before,
        "staging must not add blobs to the pool"
    );
    assert_eq!(pool_after, pool_set, "…and must not replace any either");

    // ── the identity recorded for the run is unchanged by HOW it was staged ────
    let by_slot: HashMap<&str, &str> = staged
        .iter()
        .map(|m| (m.slot.as_str(), m.content_hash.as_str()))
        .collect();
    assert_eq!(
        by_slot["counts"], put.content_hash,
        "prefix keeps its merkle identity"
    );
    assert_eq!(
        by_slot["labels"],
        solo_key.as_str(),
        "a single blob's identity is its content address — the same value the old \
         re-hash of the fetched bytes produced"
    );

    // ── WRITABILITY: the link is bound READ-ONLY ───────────────────────────────
    // This matters more than it did before. With a copy, a writable bind risked
    // only the staged copy; with a hardlink the inode IS the stored artifact, so
    // the read-only bind is now what keeps an immutable content-addressed blob
    // immutable. (Note the mode bits cannot help: they live on the shared inode,
    // so `chmod`ing the link would `chmod` the pool.)
    let mounts = input_mounts(&staged, &inputs_dir);
    assert!(
        mounts.iter().all(|m| m.mode == MountMode::ReadOnly),
        "every input bind — including the hardlinked ones — is read-only"
    );
    // …and the multi-file prefix is bound at the SAME pair the materializer reported —
    // taken from `staged`, so the bind and the staging can never drift apart silently.
    let counts = staged
        .iter()
        .find(|m| m.slot == "counts")
        .expect("counts staged");
    assert!(mounts
        .iter()
        .any(|m| m.sandbox_path == counts.sandbox_path && m.host_path == counts.host_path));

    // ── cleanup: dropping the workspace frees the staging NAMES, not the pool ──
    tokio::fs::remove_dir_all(&ws)
        .await
        .expect("workspace cleanup");
    for (rel, bytes) in &members {
        let blob = store
            .resolve_member(&put.object_key, rel)
            .await
            .expect("member still resolvable");
        assert_eq!(
            &store.get(&blob).await.expect("pooled member survives"),
            bytes,
            "removing a job workspace must never touch the pooled blob it linked"
        );
    }

    // ── NEGATIVE CONTROL: a backend that cannot link still stages correctly ────
    let no_link = NoLinkStore(server_store(&server));
    let ws2 = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string());
    let fallback_dir = ws2.join("inputs");
    let staged2 = materialize_inputs(&spec, &fallback_dir, owner, &[], &pool, &no_link)
        .await
        .expect("fallback materialize");

    let fallback_counts = staged2
        .iter()
        .find(|m| m.slot == "counts")
        .expect("counts staged by the fallback");
    assert_eq!(
        fallback_counts.sandbox_path, counts.sandbox_path,
        "the mount name is a property of the ARTIFACT, so it does not change with the \
         store's link capability"
    );
    for (rel, bytes) in &members {
        let at = fallback_counts.host_path.join(rel);
        assert_eq!(
            &std::fs::read(&at).expect("read member"),
            bytes,
            "fallback bytes are correct"
        );
        assert!(
            !pool_set.contains(&dev_ino(&at)),
            "the fallback really COPIED ({rel} shares no inode with the pool) — so the \
             assertions above are testing hardlinking, not a vacuously-true property"
        );
        assert_eq!(nlink(&at), 1, "a copy has exactly one name");
    }
    // …and the run records the identical content identity either way, so
    // `inputs.json` cannot betray which path ran.
    let by_slot2: HashMap<&str, &str> = staged2
        .iter()
        .map(|m| (m.slot.as_str(), m.content_hash.as_str()))
        .collect();
    assert_eq!(
        by_slot2, by_slot,
        "the fallback records the same content identities"
    );

    let _ = tokio::fs::remove_dir_all(&ws2).await;
}

/// A **repeated SLOT** (`multiple: true`, e.g. QC's `matrices`) stages every binding at
/// its OWN mount, holding its OWN bytes, in the caller's order.
///
/// ## Why this test, and why in this shape
///
/// `derive_artifact_mount_name(slot, structure)` is a pure function of the slot and the
/// declared encoding, so N bindings of ONE slot all derive the SAME name. If the runner
/// stopped there the second staging would overwrite the first and `inputs.json` would
/// record several entries with an identical `sandbox_path` — read naively, the same
/// matrix twice, reported under two modality prefixes. That is a WRONG ANSWER WITH NO
/// SYMPTOM: no error, no missing file, just modality B's metrics silently being modality
/// A's numbers. `materialize_inputs` therefore disambiguates (`unique_mount_name`), and
/// the disambiguation had NO test — which is why a reader of the derivation alone
/// concluded the collision was live.
///
/// The assertions are shaped so the vacuous versions cannot pass:
///
///  * "two entries exist" and "the names differ" are both true of two names pointing at
///    the SAME content, so each staged path is READ BACK and proved to hold its own,
///    DIFFERENT bytes;
///  * a set-like or hash-ordered assignment would satisfy "distinct" while destroying the
///    positional alignment the compute depends on (`params.matrix_modalities` is aligned
///    with the `matrices` bindings BY POSITION), so the negative control binds the SAME
///    two artifacts in the OPPOSITE order and requires the OPPOSITE assignment.
///
/// The fixtures declare `encoding: "zarr_v3"` — the real QC shape, and the case where the
/// ordinal has to be inserted BEFORE the store suffix (`matrices_1.zarr`, never
/// `matrices.zarr_1`, which would name a Zarr store with a suffix nothing recognises).
#[cfg(unix)]
#[tokio::test]
async fn repeated_slot_bindings_stage_to_distinct_mounts_in_binding_order() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let owner = admin_user_id(&server, &token).await;
    let project = create_project(&server, &token, "multi-slot").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    // Two Zarr-shaped prefixes whose payload member differs, so "which one landed here"
    // is answerable from the bytes alone.
    const MEMBER: &str = "c/0";
    let mut ids = Vec::new();
    let mut payloads = Vec::new();
    for tag in ["MODALITY-A-COUNTS", "MODALITY-B-COUNTS"] {
        let members: Vec<(String, Vec<u8>)> = vec![
            ("zarr.json".to_string(), br#"{"zarr_format":3}"#.to_vec()),
            (MEMBER.to_string(), tag.as_bytes().to_vec()),
        ];
        let put = store.put_prefix(&members).await.expect("put_prefix");
        let mut na = new_artifact(
            project,
            tag,
            put.object_key.as_str(),
            &put.content_hash,
            true,
        );
        na.structure = json!({ "encoding": "zarr_v3", "kind": "table" });
        let row = repo.insert_artifact(&na).await.expect("insert artifact");
        ids.push(row.id);
        payloads.push(tag.as_bytes().to_vec());
    }

    // Per leg: the `(mount name, payload it ended up holding)` assignment. The two legs
    // bind the SAME artifacts in OPPOSITE orders, so a mapping driven by BINDING ORDER
    // hands the same names out in the same sequence with the contents swapped, while a
    // mapping driven by artifact IDENTITY (a content hash, a UUID, a set iteration) hands
    // each artifact the same name in both legs. Only the first is acceptable: the compute
    // aligns `params.matrix_modalities` with the bindings BY POSITION.
    let mut assignment_per_leg: Vec<Vec<(String, Vec<u8>)>> = Vec::new();

    // `order` is the binding order; `order[pos]` is the artifact bound at position `pos`.
    for order in [[0usize, 1usize], [1, 0]] {
        let inputs_dir = server
            .data_dir()
            .join("sandboxes")
            .join(Uuid::new_v4().to_string())
            .join("inputs");
        let spec = AnalysisSpec::parse(&json!({
            "language": "python", "script": "print(1)",
            "inputs": [
                { "slot": "matrices", "artifact_ref": ids[order[0]] },
                { "slot": "matrices", "artifact_ref": ids[order[1]] },
            ],
        }))
        .expect("spec parses");

        let staged = materialize_inputs(&spec, &inputs_dir, owner, &[], &pool, &store)
            .await
            .expect("materialize inputs");
        assert_eq!(staged.len(), 2, "{order:?}: both bindings materialize");
        assert!(
            staged.iter().all(|m| m.slot == "matrices"),
            "{order:?}: both keep the SLOT they were bound on — the slot is the compute's \
             lookup key, and only the mount NAME may be disambiguated"
        );

        // ── distinct mounts ────────────────────────────────────────────────────
        assert_ne!(
            staged[0].sandbox_path, staged[1].sandbox_path,
            "{order:?}: N bindings of one slot must produce N distinct mounts, or the \
             second stages over the first"
        );
        assert_ne!(
            staged[0].host_path, staged[1].host_path,
            "{order:?}: …on the host too"
        );
        // The ordinal goes before the store suffix, so every binding still WEARS its
        // store form (a Zarr reader opens `*.zarr`, not `*.zarr_1`).
        for m in &staged {
            assert!(
                m.sandbox_path.ends_with(".zarr"),
                "{order:?}: {} must keep the suffix its artifact declares",
                m.sandbox_path
            );
        }

        // ── each mount holds ITS OWN bytes ─────────────────────────────────────
        // The assertion that "distinct names" alone cannot make: two names for one
        // store would pass everything above and fail here.
        let mut assignment: Vec<(String, Vec<u8>)> = Vec::new();
        for (pos, m) in staged.iter().enumerate() {
            let want = &payloads[order[pos]];
            let got = std::fs::read(m.host_path.join(MEMBER))
                .unwrap_or_else(|e| panic!("{order:?}: read {} member: {e}", m.sandbox_path));
            assert_eq!(
                &got, want,
                "{order:?}: binding {pos} must hold the bytes of the artifact bound at \
                 that POSITION — a positionally-misaligned mount is the silent-wrong-answer \
                 case (`params.matrix_modalities` is aligned with these bindings by index)"
            );
            assignment.push((m.sandbox_path.clone(), got));
        }
        assignment_per_leg.push(assignment);

        // ── the RECORD the compute reads carries the same, distinctly ──────────
        let rendered = cytoanalyst::modules::sandbox::inputs::render_inputs_json(&staged);
        let doc: Value = serde_json::from_slice(&rendered).expect("inputs.json parses");
        let paths: Vec<&str> = doc["inputs"]
            .as_array()
            .expect("inputs array")
            .iter()
            .map(|e| e["sandbox_path"].as_str().expect("sandbox_path"))
            .collect();
        assert_eq!(paths.len(), 2, "{order:?}: inputs.json lists both bindings");
        assert_ne!(
            paths[0], paths[1],
            "{order:?}: …at distinct sandbox paths — an identical pair here reads to the \
             compute as the same artifact twice"
        );
        assert_eq!(
            paths,
            vec![
                staged[0].sandbox_path.as_str(),
                staged[1].sandbox_path.as_str()
            ],
            "{order:?}: …in binding order"
        );

        let _ = tokio::fs::remove_dir_all(inputs_dir.parent().expect("ws")).await;
    }

    // ── NEGATIVE CONTROL: the assignment is ORDER-carrying, not identity-carrying ──
    // Same two artifacts, opposite binding order. The names must come out in the SAME
    // sequence (they are a function of position) while their CONTENTS swap. A scheme
    // that named each mount after its artifact — a content hash, the artifact UUID, a
    // set/hash iteration order — would satisfy every "distinct" assertion above and fail
    // exactly here, which is the point of having this leg.
    let (fwd, rev) = (&assignment_per_leg[0], &assignment_per_leg[1]);
    let names = |leg: &Vec<(String, Vec<u8>)>| -> Vec<String> {
        leg.iter().map(|(n, _)| n.clone()).collect()
    };
    assert_eq!(
        names(fwd),
        names(rev),
        "the mount names are handed out by POSITION, so reversing the bindings must reuse \
         the same two names — a name that travels with its artifact is identity-keyed, and \
         the compute's positional alignment cannot survive that"
    );
    for pos in 0..2 {
        assert_ne!(
            fwd[pos].1, rev[pos].1,
            "…and the CONTENT at position {pos} must swap with the binding order (mount \
             {}); equal content here means the reversal changed nothing, i.e. the mapping \
             is keyed on the artifact rather than on where the caller put it",
            fwd[pos].0
        );
        assert_eq!(
            fwd[pos].1,
            rev[1 - pos].1,
            "…and it must be exactly the OTHER position's content, not merely different"
        );
    }
}

// ───── A dangling artifact blob fails with a DIAGNOSIS, not with `Blob not found` ─────

/// The whole failure reason a user got for a run whose input artifact had no blob was
/// the string `Blob not found`. Observed live: `jobs.error = 'Blob not found'` on three
/// `analysis` rows, rendered verbatim by the jobs drawer (`JobDetail.tsx`), the workbench
/// jobs pane (`JobsPane.tsx`), the completion toast and — via
/// `dataset::models::map_processing_status` — the dataset processing badge and alert.
/// Six surfaces, all fed by the ONE `jobs.error` column, so they are all fixed by fixing
/// what is written into it.
///
/// ## Why the test drives `materialize_inputs` and not the pure composer
///
/// `describe_artifact_staging_failure`'s own unit tests (in `sandbox::inputs`) already
/// pin what the sentence SAYS, and they would stay green if the `.map_err` that invokes
/// it were deleted — a composer nothing calls is exactly the shape of the bug being
/// fixed. This exercises the real chokepoint both the runner and the provenance verify
/// re-run funnel through, against a real catalog row and the server's real blob pool, so
/// it fails if the composer is not WIRED.
///
/// ## The fixture is the live situation, not an approximation
///
/// A `ready`, multi-file catalog row whose `object_key` names a manifest blob that was
/// never stored — dev data with 3 blob files against 140 artifact rows, the bytes
/// orphaned long ago. Nothing is deleted to arrange it: the row is simply written without
/// its blob, which is the state the store was found in.
///
/// It needs no sandbox and no rootfs (staging fails before any process is spawned), so it
/// runs everywhere rather than self-skipping.
#[tokio::test]
async fn a_dangling_artifact_blob_fails_naming_the_slot_and_the_artifact() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let owner = admin_user_id(&server, &token).await;
    let project = create_project(&server, &token, "dangling blob").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    // A multi-file artifact whose manifest blob is NOT in the pool. `put_prefix` is
    // deliberately not called: the row is the only thing that exists.
    let orphan_key = format!("sha256:{:064x}", 0x831e51a0u64);
    let artifact = repo
        .insert_artifact(&new_artifact(
            project,
            "expression",
            &orphan_key,
            &orphan_key,
            true,
        ))
        .await
        .expect("insert artifact row with no blob");
    assert!(
        !store
            .exists(&ContentKey::parse(&orphan_key))
            .await
            .expect("exists"),
        "fixture precondition: the manifest blob really is absent from the pool"
    );

    let ws = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string());
    let spec = AnalysisSpec::parse(&json!({
        "language": "python", "script": "print(1)",
        "inputs": [{ "slot": "matrix", "artifact_ref": artifact.id }],
    }))
    .expect("spec parses");

    let err = materialize_inputs(&spec, &ws.join("inputs"), owner, &[], &pool, &store)
        .await
        .expect_err("an artifact with no blob cannot be staged");
    let msg = err.to_string();

    // THE REGRESSION. The old behaviour was this string and nothing else; a message that
    // is still only this is the defect, whatever else changed around it.
    assert_ne!(
        msg, "Blob not found",
        "the bare store error must not be the user's whole diagnosis"
    );

    // The two facts the brief requires by name, asserted individually so a message that
    // grew without gaining them cannot pass.
    assert!(
        msg.contains("matrix"),
        "the failure names the input SLOT that could not be bound: {msg}"
    );
    assert!(
        msg.contains(&artifact.id.to_string()),
        "…and the ARTIFACT that slot was bound to: {msg}"
    );
    // And that it is the BYTES that are gone, not the row — the distinction that decides
    // whether the user re-imports or files a bug about a missing artifact.
    assert!(
        msg.contains("stored bytes") && msg.contains("MISSING"),
        "…and that the stored bytes, not the catalog row, are what is missing: {msg}"
    );

    // The failure is NOT weakened: nothing was staged, and no placeholder stands in for
    // the absent input.
    assert!(
        !ws.join("inputs").join("matrix").exists(),
        "a missing blob must leave no staged input behind"
    );

    let _ = tokio::fs::remove_dir_all(&ws).await;
}

// ───────── TEST-23 (ITEM-17): outputs stage OUTSIDE the sandbox workspace ─────────
//
// ITEM-17: "Outputs go to a staging dir outside the sandbox workspace, with cleanup
// after ingest on success, immediately on error, and a periodic sweep for crashes."
//
// This file had NO test for that property because the property was FALSE: outputs
// were `<workspace>/outputs` at four independent sites, so any test that passed
// would have been asserting the opposite of the plan. The three legs below are the
// three cleanup paths, plus the path check the item leads with.
//
// Every path assertion here is computed — `starts_with` over real `PathBuf`s, or a
// `strip_prefix` of the PRODUCTION derivation — never a comment claiming a layout.

/// The two per-run roots as THIS server sees them.
///
/// The relative component of each is taken from the production derivation
/// (`sandbox::outputs::staging_root()` under `rootfs::data_root()`) and re-rooted at
/// the spawned server's own data dir, because the server is a subprocess with its
/// own `CYTO_APP_DATA_DIR`. Renaming the staging root in production therefore moves
/// this test with it instead of leaving it watching a dir nothing writes to.
fn run_roots(server: &TestServer) -> (std::path::PathBuf, std::path::PathBuf) {
    let data_root = cytoanalyst::modules::rootfs::data_root();
    let staging_rel = cytoanalyst::modules::sandbox::outputs::staging_root()
        .strip_prefix(&data_root)
        .expect("the staging root is derived under the app data root")
        .to_path_buf();
    assert_ne!(
        staging_rel,
        std::path::PathBuf::from("sandboxes"),
        "the output staging root must not BE the sandbox workspace root"
    );
    (
        server.data_dir().join("sandboxes"),
        server.data_dir().join(staging_rel),
    )
}

/// Wait until `p` exists, up to `timeout`. Returns whether it appeared.
async fn wait_exists(p: &Path, timeout: Duration) -> bool {
    let start = tokio::time::Instant::now();
    loop {
        if tokio::fs::try_exists(p).await.unwrap_or(false) {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Whether this host can actually EXECUTE in the sandbox (`echo probe` → exit 0).
///
/// The ITEM-17 legs below are meaningless without it, and a self-skip that reports
/// `ok` is worse than a failure — a skipping run and a real run are then
/// indistinguishable in cargo's output, which is exactly how a converter regression
/// stayed invisible on this branch. So this routes through
/// [`record_skip`](crate::dataset::hardening_common::record_skip) like every other
/// gate in the suite.
///
/// Its defences, honestly stated:
///  * **The skip LEDGER (`target/test-skip-ledger.tsv`) — the only one that works
///    unattended.** libtest CAPTURES stdout/stderr for a test that PASSES, and a
///    self-skip passes, so the `eprintln!` is discarded unless someone thought to
///    pass `--nocapture`. The ledger line is written to a file and survives, so a
///    run's skips can be COUNTED after the fact.
///  * `CYTO_TEST_NO_SKIP=1` turns the skip into a hard failure. This is an
///    **operator-invoked** defence only: nothing in the repo sets that variable
///    (see the R6-D1 note in the `justfile`), so it defends nothing on its own.
///
/// Point `CYTO_ENV_ROOTFS_SQUASHFS` at a rootfs.squashfs (or `CYTO_ENV_ROOTFS_DIR`
/// at a pre-mounted rootfs) to make these actually run.
async fn sandbox_executes(server: &TestServer, admin: &str, test: &str) -> bool {
    let probe: Value = match server
        .client
        .post(server.api_url("/sandbox/execute"))
        .bearer_auth(admin)
        .json(&json!({ "command": "echo probe" }))
        .send()
        .await
    {
        Ok(r) => r.json().await.unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    if probe["exit_code"] == json!(0) {
        return true;
    }
    // `record_skip` owns BOTH channels (stderr + the ledger) and the
    // `CYTO_TEST_NO_SKIP=1` hard failure — never hand-roll a partial one here.
    record_skip(
        test,
        "the sandbox cannot execute here (GET /sandbox/status not ready, or the `echo probe` \
         execute failed). Point CYTO_ENV_ROOTFS_SQUASHFS at a rootfs.squashfs, or \
         CYTO_ENV_ROOTFS_DIR at a pre-mounted rootfs",
    );
    false
}

/// Submit an analysis job scoped to `project`, returning its id.
async fn create_scoped_analysis(
    server: &TestServer,
    token: &str,
    project: Uuid,
    name: &str,
    script: &str,
) -> Uuid {
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({
            "job_type": "analysis",
            "name": name,
            "project_id": project,
            "params": { "language": "python", "script": script }
        }))
        .send()
        .await
        .expect("create analysis job");
    assert_eq!(resp.status().as_u16(), 201, "scoped analysis job created");
    let body: Value = resp.json().await.expect("job json");
    Uuid::parse_str(body["id"].as_str().expect("job id")).expect("uuid")
}

/// TEST-23 [covers: ITEM-17], leg 1/3 — a REAL run's outputs land OUTSIDE its
/// workspace, and BOTH dirs are gone once ingest has consumed them.
///
/// The path claim is checked twice and neither check is a comment:
///  * `staging_root` does not start with the workspace root (the roots are separate
///    trees), and
///  * during the run, `<staging_root>/<job>/outputs` EXISTS while
///    `<workspace_root>/<job>/outputs` does NOT — while `<workspace_root>/<job>`
///    itself does. That triple is what separates "outputs moved" from "the sandbox
///    never ran": a re-coupled `assemble_mounts` puts the dir back under the
///    workspace and fails the second and third clauses.
///
/// The mid-run observation is also what makes the cleanup assertion non-vacuous. A
/// bare "the staging dir is gone at the end" passes trivially if the dir was never
/// created; here the dir is watched into existence first, and the run's artifact is
/// cataloged FROM it, so its absence afterwards can only be the cleanup.
#[tokio::test]
async fn outputs_stage_outside_the_workspace_and_are_cleaned_on_success() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let (ws_root, staging_root) = run_roots(&server);
    assert!(
        !staging_root.starts_with(&ws_root),
        "the output staging root ({}) is OUTSIDE the sandbox workspace root ({})",
        staging_root.display(),
        ws_root.display()
    );

    if !sandbox_executes(&server, &admin, "outputs_stage_outside_the_workspace").await {
        return;
    }

    let project = create_project(&server, &admin, "item17 success").await;
    // Writes its declared output early, then holds the process open long enough for
    // the host-side observation below, then exits 0.
    let script = "import os, json, time\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/result.txt', 'w').write('ok')\n\
json.dump({'outputs': [{'id':'r','datatype':'file/upload','path':'result.txt','layout':'opaque','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'artifact'}]}, open('/outputs/manifest.json','w'))\n\
time.sleep(8)\n\
print('analysis done')\n";
    let job = create_scoped_analysis(&server, &admin, project, "item17-ok", script).await;

    let staging = cytoanalyst::modules::sandbox::outputs::staging_dir(&staging_root, job);
    let outputs = cytoanalyst::modules::sandbox::outputs::outputs_dir(&staging);
    let workspace = ws_root.join(job.to_string());

    // MID-RUN: the outputs are in the staging tree, and NOT in the workspace.
    assert!(
        wait_exists(&outputs, Duration::from_secs(120)).await,
        "the run's /outputs is staged at {} — if this dir never appears, outputs are \
         still being written somewhere else",
        outputs.display()
    );
    assert!(
        workspace.exists(),
        "the run has a workspace at {} (so the next assertion is about WHERE outputs \
         are, not about whether the run happened)",
        workspace.display()
    );
    assert!(
        !workspace.join("outputs").exists(),
        "no `outputs` dir under the workspace at {} — that is the coupling ITEM-17 removes",
        workspace.display()
    );

    // TERMINAL: completed, artifact cataloged, and BOTH run dirs reclaimed.
    let detail = poll_job(
        &server,
        &admin,
        &job.to_string(),
        &["completed", "failed"],
        Duration::from_secs(180),
    )
    .await;
    assert_eq!(
        detail["job"]["status"],
        json!("completed"),
        "the run completes (detail: {detail})"
    );

    let pool = pool_for(&server).await;
    let cataloged: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(job)
        .fetch_one(&pool)
        .await
        .expect("count artifacts");
    assert_eq!(
        cataloged, 1,
        "the declared output was ingested FROM the staging dir — so the staging dir \
         outlived the workspace long enough to be consumed"
    );

    assert!(
        !staging.exists(),
        "the staging dir {} is removed after a successful ingest",
        staging.display()
    );
    assert!(
        !workspace.exists(),
        "the workspace {} is removed too",
        workspace.display()
    );
}

/// TEST-23 [covers: ITEM-17], leg 2/3 — a run that ERRORS has its staging dir
/// reclaimed IMMEDIATELY, not left for the next boot.
///
/// The script writes into `/outputs` and then exits non-zero: nothing about that run
/// will ever be ingested, so there is nothing for its staging dir to outlive. The
/// dir is watched into existence first (same non-vacuity control as leg 1), so its
/// absence at the terminal state is attributable to the error-path cleanup — and a
/// build with that cleanup removed fails here while leg 1 still passes.
#[tokio::test]
async fn output_staging_is_reclaimed_immediately_on_error() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (ws_root, staging_root) = run_roots(&server);

    if !sandbox_executes(&server, &admin, "output_staging_reclaimed_on_error").await {
        return;
    }

    let project = create_project(&server, &admin, "item17 error").await;
    // Produces output bytes, holds long enough to be observed, then FAILS.
    let script = "import os, sys, time\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/partial.bin', 'w').write('half')\n\
time.sleep(8)\n\
sys.exit(3)\n";
    let job = create_scoped_analysis(&server, &admin, project, "item17-err", script).await;

    let staging = cytoanalyst::modules::sandbox::outputs::staging_dir(&staging_root, job);
    let outputs = cytoanalyst::modules::sandbox::outputs::outputs_dir(&staging);
    let workspace = ws_root.join(job.to_string());

    assert!(
        wait_exists(&outputs.join("partial.bin"), Duration::from_secs(120)).await,
        "the failing run really wrote into its staging dir at {}",
        outputs.display()
    );

    let detail = poll_job(
        &server,
        &admin,
        &job.to_string(),
        &["completed", "failed"],
        Duration::from_secs(180),
    )
    .await;
    assert_eq!(
        detail["job"]["status"],
        json!("failed"),
        "a non-zero exit fails the job (detail: {detail})"
    );

    assert!(
        !staging.exists(),
        "the staging dir {} is reclaimed immediately on the error path — not left to \
         the boot sweep",
        staging.display()
    );
    assert!(
        !workspace.exists(),
        "the workspace {} is reclaimed with it",
        workspace.display()
    );

    // NEGATIVE CONTROL on the error path itself: an ingest FAILURE is NOT this case.
    // There, the outputs are the sole copy of work that succeeded, so both dirs are
    // PRESERVED — asserted by `tests/jobs` TEST-62's fail-preserve leg. If the error
    // path ever reclaimed indiscriminately, that assertion is what catches it.
}

/// TEST-23 [covers: ITEM-17], leg 3/3 — the CRASH path: the boot sweep reclaims an
/// orphaned staging dir, and only an orphaned one.
///
/// A crash has no natural trigger in-process (it is, definitionally, the case where
/// neither in-process cleanup ran), so this drives the production entry point
/// `sweep_stale_run_dirs` — the one `JobsModule::init` calls — against planted
/// orphans in a pair of temp roots.
///
/// Three controls make it a test rather than a demonstration that `remove_dir_all`
/// works:
///  * a LIVE job's staging dir (its id in the keep-set) survives;
///  * a dir held by `hold_live_workspace` survives — the register is consulted for
///    the STAGING root too. This is the regression ITEM-17 could have introduced:
///    the verification path hashes outputs, those outputs now live in the staging
///    tree, and a sweep that skipped the register there would delete them under a
///    live run and report a reproducible run as irreproducible;
///  * the workspace root is still swept by the same call, so separating the trees
///    did not leave one of them unreclaimed.
#[tokio::test]
async fn boot_sweep_reclaims_a_crashed_runs_staging_dir() {
    use cytoanalyst::modules::jobs::scheduler::{hold_live_workspace, sweep_stale_run_dirs};
    use cytoanalyst::modules::sandbox::outputs::{outputs_dir, staging_dir};

    let base = std::env::temp_dir().join(format!("cyto-item17-sweep-{}", Uuid::new_v4()));
    let ws_root = base.join("sandboxes");
    let staging_root = base.join("run-staging");
    assert!(
        !staging_root.starts_with(&ws_root),
        "the planted roots mirror production: separate trees"
    );

    let crashed = Uuid::new_v4();
    let live = Uuid::new_v4();
    let held = Uuid::new_v4();

    // Plant a staging dir (with real bytes in it) for each case, plus a workspace
    // for the crashed one so the workspace leg is covered by the same call.
    for id in [crashed, live, held] {
        let out = outputs_dir(&staging_dir(&staging_root, id));
        tokio::fs::create_dir_all(&out).await.unwrap();
        tokio::fs::write(out.join("result.bin"), b"bytes")
            .await
            .unwrap();
    }
    let crashed_ws = ws_root.join(crashed.to_string());
    tokio::fs::create_dir_all(&crashed_ws).await.unwrap();
    // A non-UUID dir is never a per-run dir and must survive in EITHER tree.
    tokio::fs::create_dir_all(staging_root.join("identity"))
        .await
        .unwrap();

    let guard = hold_live_workspace(held);
    sweep_stale_run_dirs(&ws_root, &staging_root, &[live]).await;

    assert!(
        !staging_dir(&staging_root, crashed).exists(),
        "the crashed run's staging dir is reclaimed"
    );
    assert!(
        !crashed_ws.exists(),
        "…and so is its workspace, by the same call — neither tree is left unswept"
    );
    assert!(
        staging_dir(&staging_root, live).exists(),
        "a LIVE job's staging dir is spared (the keep-set is honored in the staging \
         tree, not just the workspace tree)"
    );
    assert!(
        staging_dir(&staging_root, held).exists(),
        "a staging dir held by an in-process run is spared — `hold_live_workspace` \
         covers the staging tree, which is where a verification run's outputs now are"
    );
    assert!(
        staging_root.join("identity").exists(),
        "a non-UUID dir is never swept"
    );

    // Once the hold is released the same sweep reclaims it — the guard bounds a live
    // run, it does not leak a dir forever.
    drop(guard);
    sweep_stale_run_dirs(&ws_root, &staging_root, &[live]).await;
    assert!(
        !staging_dir(&staging_root, held).exists(),
        "a released hold makes the dir stale again"
    );

    let _ = tokio::fs::remove_dir_all(&base).await;
}
