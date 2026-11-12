//! TEST-5/6 (ITEM-1/2/5) — the OciEnvImageProvider end-to-end against a LOCAL
//! registry: publish a signed rootfs → the provider resolves the moving tag →
//! pulls by digest → cosign-verifies → stages into the digest cache → mounts it.
//! Tool-gated (docker+oras+cosign+squashfuse); NO GHCR.
//!
//! **Nothing here mutates the PROCESS environment.** It used to: the registry, the
//! cosign key and the app-data dir were `set_var`'d, and `env_image::registry_base`
//! reads its configuration LIVE and in-process — so for the whole minutes-long pull
//! every sibling test in this binary that resolved an env-ref resolved it against
//! this test's loopback registry. That was measured, not theoretical: in round 15
//! `sandbox::env_image_test` failed its per-env-repo assertion, its `left` carrying
//! the loopback host where the `right` expected the product registry base, having
//! overlapped this test.
//! Configuration is passed EXPLICITLY now — [`EnvImageSeams`] into the provider,
//! [`rootfs::scoped_data_root`] (thread-scoped) for the cache dir — so a sibling
//! cannot observe it at all. Do not reintroduce a `set_var` here: a scopeguard that
//! clears afterwards does not close the window, it only shortens it.

use std::path::Path;
use std::process::Command;

use txresbench::modules::rootfs;
use txresbench::modules::rootfs::version::ROOTFS_SCHEMA_VERSION;
use txresbench::modules::sandbox::env_image::{
    EnvImageProvider, EnvImageSeams, OciEnvImageProvider,
};

// Every gate below routes through the SHARED skip recorder, never a bare `eprintln!` +
// `return`. A bare print reports a PASS to libtest, writes no ledger line, and — the part
// that matters — ignores `TXR_TEST_NO_SKIP=1`, so a tier that has quietly stopped running
// is indistinguishable from one that ran. `record_skip` writes
// `target/test-skip-ledger.tsv` and PANICS under `TXR_TEST_NO_SKIP=1`.
use crate::dataset::hardening_common::record_skip;

fn have(tool: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {tool}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a shell line, panic with stderr on failure.
fn sh(line: &str) {
    let out = Command::new("sh")
        .arg("-c")
        .arg(line)
        .output()
        .expect("spawn sh");
    assert!(
        out.status.success(),
        "cmd failed: {line}\n--- stderr ---\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn sh_out(line: &str) -> String {
    let out = Command::new("sh")
        .arg("-c")
        .arg(line)
        .output()
        .expect("spawn sh");
    assert!(
        out.status.success(),
        "cmd failed: {line}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// **E5 / #193 — TEST-10 [covers: ITEM-2].** This pre-existing end-to-end is E5's evidence
/// for ITEM-2 (the local-registry path: resolve → cosign-verify → pull → cache → mount,
/// plus the NEVER-MOUNT-UNVERIFIED negative arm), and the citation is here rather than
/// only in E5's artifacts on purpose: `TEST-N` is scoped PER LIFECYCLE ITEM, and every
/// item restarts its numbering from 1 — so a recorded PASS matched by a bare grep can
/// bind to a stranger's test under another item's directory. E5 re-ran this on its own
/// branch —
/// 1 passed, 39.5 s, empty skip ledger — so the PASS is earned rather than inherited.
/// E5 changes nothing in this test; it asserts that the path still holds under the
/// branch's changes.
#[test]
fn oci_provider_lazy_fetch_verify_mount() {
    if !(have("docker") && have("oras") && have("cosign") && have("squashfuse")) {
        record_skip(
            "oci_provider_lazy_fetch_verify_mount",
            "needs docker+oras+cosign+squashfuse on PATH (this is the real OCI end-to-end)",
        );
        return;
    }
    let work = std::env::temp_dir().join(format!("env-oci-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    let data = work.join("appdata");
    let reg = "localhost:5001"; // dedicated port so we don't collide with a stray :5000
    let repo = format!("{reg}/single-cell");
    let tag = format!("schema{ROOTFS_SCHEMA_VERSION}-latest-amd64");
    let pull_ref = format!("{repo}:{tag}");

    // Cleanup guard (registry container + fuse mounts) on every exit.
    let _guard = scopeguard(work.clone());

    // 1. Build a tiny rootfs squashfs (debian-slim /, has usr/) inside a container.
    sh(&format!(
        "docker run --rm --privileged -v {w}:/out debian:bookworm-slim sh -c \
         'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq squashfs-tools >/dev/null 2>&1; \
          mksquashfs / /out/rootfs.squashfs -comp zstd -noappend -no-progress -e out -e proc -e sys -e dev >/dev/null 2>&1'",
        w = work.display()
    ));
    assert!(
        work.join("rootfs.squashfs").exists(),
        "fixture squashfs built"
    );

    // 2. Local registry + publish the artifact at the exact moving tag the provider resolves.
    sh("docker rm -f env-oci-reg >/dev/null 2>&1; docker run -d --name env-oci-reg -p 5001:5000 registry:2 >/dev/null && sleep 2");
    sh(&format!(
        "cd {w} && oras push --plain-http --artifact-type application/vnd.txresbench.env-rootfs.squashfs.v1 \
         {pull_ref} rootfs.squashfs:application/vnd.txresbench.env-rootfs.squashfs.v1 >/dev/null",
        w = work.display()
    ));
    let digest = sh_out(&format!("oras resolve --plain-http {pull_ref}"));
    assert!(digest.starts_with("sha256:"), "published digest: {digest}");

    // 3. cosign key-sign the digest (the provider key-verifies via the debug seam).
    sh(&format!(
        "cd {w} && COSIGN_PASSWORD='' cosign generate-key-pair >/dev/null 2>&1 && \
         COSIGN_PASSWORD='' cosign sign --yes --key cosign.key --allow-insecure-registry --tlog-upload=false {repo}@{digest} >/dev/null 2>&1",
        w = work.display()
    ));

    // 4. Point the provider at the local registry + the cosign pubkey (debug-only
    //    seams, passed EXPLICITLY — never through the process env), isolate its cache
    //    to our temp app-data dir on THIS THREAD only, then drive the REAL provider.
    let local = || EnvImageSeams {
        registry: Some(reg.to_string()),
        cosign_key: Some(work.join("cosign.pub")),
        identity_regexp: None,
        // Drive the REAL resolve → cosign-verify → pull → mount path even when the
        // process was started with the air-gap seam set. That seam
        // (`TXR_ENV_ROOTFS_SQUASHFS`) is the DOCUMENTED way to run the rootfs-gated
        // tests, `provide()` consults it FIRST, and one test binary is one process — so
        // without this the documented procedure turned this test into a no-op that
        // returned the operator's squashfs, failed at the cache assertion below, and
        // took the cosign NEVER-MOUNT-UNVERIFIED arm down with it. Unsetting the var
        // here is not the alternative: see the module header on why `set_var` in this
        // file is forbidden.
        bypass_air_gap_env: true,
    };
    let data_guard = rootfs::scoped_data_root(&data);

    let mount = OciEnvImageProvider::with_seams(local())
        .provide("single-cell", std::time::Duration::from_secs(300))
        .expect("provider lazy-fetches + verifies + mounts the newest image");

    // 5. It pulled → verified → staged → mounted: the mount dir has a usr/ (what the
    //    sandbox binds), and the squashfs landed in the digest cache.
    assert!(
        mount.rootfs_dir.join("usr").is_dir(),
        "mounted rootfs exposes usr/ at {}",
        mount.rootfs_dir.display()
    );
    let hex = digest.trim_start_matches("sha256:");
    assert!(
        txresbench::modules::rootfs::cache::has_digest(hex),
        "the pulled squashfs is staged in the content-digest cache"
    );

    // cleanup the positive-path mount before the negative-path assertion.
    let _ = Command::new("fusermount")
        .args(["-u", &mount.rootfs_dir.to_string_lossy()])
        .output();

    // 6. NEVER MOUNT UNVERIFIED (security-critical negative path, asserted here
    //    end-to-end — the unit test covers the error MAPPING, this covers the
    //    real provider path). OVERWRITE the moving tag with an UNSIGNED artifact,
    //    point the provider at a FRESH app-data dir (forces a cache miss so it
    //    actually re-fetches + re-verifies), and confirm `provide()` returns Err
    //    (cosign verify fails → no mount) instead of Ok.
    sh(&format!(
        "cd {w} && head -c 65536 /dev/urandom > unsigned.squashfs && \
         oras push --plain-http --artifact-type application/vnd.txresbench.env-rootfs.squashfs.v1 \
         {pull_ref} unsigned.squashfs:application/vnd.txresbench.env-rootfs.squashfs.v1 >/dev/null",
        w = work.display()
    ));
    let bad_digest = sh_out(&format!("oras resolve --plain-http {pull_ref}"));
    assert_ne!(
        bad_digest, digest,
        "the moving tag now points at the UNSIGNED image"
    );
    drop(data_guard); // the positive-path cache dir is done with
    let _neg_guard = rootfs::scoped_data_root(work.join("appdata-neg")); // fresh cache → forces re-verify
    let rejected = OciEnvImageProvider::with_seams(local())
        .provide("single-cell", std::time::Duration::from_secs(300));
    assert!(
        rejected.is_err(),
        "an UNSIGNED image at the moving tag must be REJECTED (never mounted), got Ok"
    );
    let bad_hex = bad_digest.trim_start_matches("sha256:");
    assert!(
        !txresbench::modules::rootfs::cache::has_digest(bad_hex),
        "the rejected unsigned image was NOT staged into the cache"
    );
}

/// TEST-10 (ITEM-6/8) — GOLD tier IMPORT-SMOKE: the provider pulls+verifies+mounts
/// the REAL scientific rootfs, and the rootfs's Python stack IMPORTS + a python
/// invocation RUNS under bwrap. HONEST SCOPE (do not overstate): this binds the
/// HOST `/proc` read-only (`--ro-bind /proc /proc`) — it is NOT the production
/// sandbox path (which uses `--unshare-pid` + a fresh `/proc` mount, needing
/// `CAP_SYS_ADMIN`), and it does NOT run a real processor (`import_h5ad`) on real
/// data through the product path. It PROVES the OCI-pulled environment is complete
/// + importable + executable; the full-PID-ns product-path run is the
/// `CAP_SYS_ADMIN`-gated leg (DEC-P) that self-skips on a capability-limited host.
/// Env-gated on `TXR_REAL_ROOTFS_SQUASHFS`; an UNSET run no-ops and is NOT evidence.
#[test]
fn oci_provider_runs_real_scientific_stack() {
    let Some(sqfs) = std::env::var_os("TXR_REAL_ROOTFS_SQUASHFS") else {
        record_skip(
            "oci_provider_runs_real_scientific_stack",
            "set TXR_REAL_ROOTFS_SQUASHFS=<path> to a built single-cell rootfs squashfs",
        );
        return;
    };
    let sqfs = std::path::PathBuf::from(sqfs);
    if !(sqfs.exists()
        && have("docker")
        && have("oras")
        && have("cosign")
        && have("squashfuse")
        && have("bwrap"))
    {
        record_skip(
            "oci_provider_runs_real_scientific_stack",
            "needs the real rootfs (TXR_REAL_ROOTFS_SQUASHFS must point at an existing \
             file) + docker+oras+cosign+squashfuse+bwrap on PATH",
        );
        return;
    }
    let work = std::env::temp_dir().join(format!("env-oci-real-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    std::fs::copy(&sqfs, work.join("rootfs.squashfs")).expect("stage real squashfs");
    let _guard = scopeguard(work.clone());
    let reg = "localhost:5002";
    let repo = format!("{reg}/single-cell");
    let tag = format!("schema{ROOTFS_SCHEMA_VERSION}-latest-amd64");

    sh("docker rm -f env-oci-reg >/dev/null 2>&1; docker run -d --name env-oci-reg -p 5002:5000 registry:2 >/dev/null && sleep 2");
    sh(&format!(
        "cd {w} && oras push --plain-http --artifact-type application/vnd.txresbench.env-rootfs.squashfs.v1 \
         {repo}:{tag} rootfs.squashfs:application/vnd.txresbench.env-rootfs.squashfs.v1 >/dev/null",
        w = work.display()
    ));
    let digest = sh_out(&format!("oras resolve --plain-http {repo}:{tag}"));
    sh(&format!(
        "cd {w} && COSIGN_PASSWORD='' cosign generate-key-pair >/dev/null 2>&1 && \
         COSIGN_PASSWORD='' cosign sign --yes --key cosign.key --allow-insecure-registry --tlog-upload=false {repo}@{digest} >/dev/null 2>&1",
        w = work.display()
    ));

    let _data_guard = rootfs::scoped_data_root(work.join("appdata"));

    // The REAL provider pulls + verifies + mounts the REAL rootfs. Registry + key are
    // passed explicitly (see the module header) — no process env is touched.
    let mount = OciEnvImageProvider::with_seams(EnvImageSeams {
        registry: Some(reg.to_string()),
        cosign_key: Some(work.join("cosign.pub")),
        identity_regexp: None,
        // Same reason as the test above: the ambient air-gap seam would otherwise hand
        // back the operator's squashfs and this would assert nothing about the OCI path.
        bypass_air_gap_env: true,
    })
    .provide("single-cell", std::time::Duration::from_secs(300))
    .expect("pull+verify+mount real rootfs");

    // IMPORT-SMOKE: the rootfs's scientific stack imports + a python invocation
    // runs under bwrap. NOTE the `--ro-bind /proc /proc` (host /proc) — this is
    // NOT the production PID-ns sandbox and NOT a real processor on real data.
    let m = mount.rootfs_dir.to_string_lossy();
    let run = format!(
        "bwrap --ro-bind {m}/usr /usr --ro-bind-try {m}/opt /opt \
         --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
         --ro-bind /proc /proc --dev /dev --tmpfs /tmp \
         --setenv PATH /opt/venv/bin:/usr/local/bin:/usr/bin:/bin --die-with-parent \
         /opt/venv/bin/python -c 'import scanpy, anndata, spatialdata; print(\"STACK IMPORT OK\", scanpy.__version__)'"
    );
    let out = sh_out(&run);
    assert!(
        out.contains("STACK IMPORT OK"),
        "the scientific stack imported+ran under bwrap against the OCI-pulled rootfs: {out}"
    );
    let _ = Command::new("fusermount").args(["-u", &m]).output();
}

/// TEST-15 (ITEM-3) — RELEASE-mode verification against the REAL signed GHCR image
/// (the pre-merge delivery proof; NOT the debug-key seam). Build + run with
/// `cargo test --release` so the `cfg!(debug_assertions)` cosign-key / local-registry
/// seams are COMPILED OUT — the provider targets the real `ghcr.io/tinnlab/txresbench-env`
/// and keyless-verifies the CI OIDC identity (ref-flexible regexp). Gated on
/// `TXR_REAL_GHCR_VERIFY=1`; requires host oras+cosign+squashfuse+bwrap and GHCR read
/// creds (`oras login ghcr.io` — the package is private). Drives the real provider:
/// resolve moving tag → keyless cosign-verify → pull → mount → import the stack.
#[test]
fn oci_provider_verifies_real_signed_ghcr_image() {
    if std::env::var("TXR_REAL_GHCR_VERIFY").ok().as_deref() != Some("1") {
        record_skip(
            "oci_provider_verifies_real_signed_ghcr_image",
            "set TXR_REAL_GHCR_VERIFY=1 (+ `cargo test --release` + `oras login ghcr.io`) \
             to verify the REAL signed GHCR image",
        );
        return;
    }
    if !(have("oras") && have("cosign") && have("squashfuse") && have("bwrap")) {
        record_skip(
            "oci_provider_verifies_real_signed_ghcr_image",
            "needs oras+cosign+squashfuse+bwrap on PATH",
        );
        return;
    }
    // This arm's whole subject is KEYLESS VERIFICATION of the real GHCR image, and it
    // runs `--release`, where `bypass_air_gap_env` is compiled out on purpose (a release
    // binary must always honor an operator's air-gap configuration). So an ambient
    // `TXR_ENV_ROOTFS_SQUASHFS` would hand `provide()` the operator's own file, WITH a
    // recorded digest and a mountable `usr/` — i.e. this test would report PASS having
    // resolved nothing, pulled nothing and verified nothing. A false green on a signature
    // check is worse than a red, so the precondition is stated and gated rather than
    // assumed. The debug arms above do not need this: they declare the bypass.
    for seam in ["TXR_ENV_ROOTFS_SQUASHFS", "TXR_ENV_ROOTFS_DIR"] {
        if std::env::var_os(seam).is_some_and(|v| !v.is_empty()) {
            record_skip(
                "oci_provider_verifies_real_signed_ghcr_image",
                "an air-gap seam is set in this process and the release build honors it \
                 before the OCI path, so nothing would be resolved, pulled or \
                 cosign-verified — unset it for this run",
            );
            return;
        }
    }
    let work = std::env::temp_dir().join(format!("env-ghcr-verify-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    let _guard = scopeguard(work.clone());
    // Isolate the digest cache. `registry`/`cosign_key` stay `None` → the provider
    // targets the real ghcr.io and keyless-verifies (the release path). Leaving them
    // None is now sufficient on its own: those two seams are read ONLY off the seam
    // struct, so no ambient environment can redirect the pull or swap in a key —
    // which is why this arm no longer needs `remove_var` to defend itself.
    let _data_guard = rootfs::scoped_data_root(&work);
    // Production defaults to the STRICT `@refs/heads/main` identity; this image was
    // signed from the `env-v0-test` TAG (`@refs/tags/env-v0-test`), so we exercise the
    // documented STAGING OVERRIDE to widen the accepted ref to tags — exactly the
    // intended pre-merge flow (prod strict; staging verifies a tag-signed build).
    // Release-honored, so it is the one seam this `--release` arm can set.
    let mount = OciEnvImageProvider::with_seams(EnvImageSeams {
        registry: None,
        cosign_key: None,
        identity_regexp: Some(
            r"^https://github\.com/tinnlab/txresbench/\.github/workflows/env-images\.yml@refs/tags/env-v.*$"
                .to_string(),
        ),
        // Declared for the same reason as its siblings, and a NO-OP here by design: this
        // arm runs `--release`, where the field's reader is compiled out and an
        // operator's air-gap configuration is always honored. Set anyway so the three
        // OCI arms read alike and a future debug-mode run of this one is not surprised.
        bypass_air_gap_env: true,
    })
    .provide("single-cell", std::time::Duration::from_secs(300))
    .expect("release provider resolves → keyless-verifies → pulls → mounts the REAL signed GHCR image");
    assert!(
        mount.rootfs_dir.join("usr").is_dir(),
        "mounted rootfs exposes usr/ at {}",
        mount.rootfs_dir.display()
    );
    assert!(
        txresbench::modules::sandbox::env_image::last_resolved_digest().is_some(),
        "the resolved GHCR content digest is recorded for provenance"
    );

    // The signed+verified+mounted rootfs's stack imports under bwrap.
    let m = mount.rootfs_dir.to_string_lossy();
    let run = format!(
        "bwrap --ro-bind {m}/usr /usr --ro-bind-try {m}/opt /opt \
         --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
         --ro-bind /proc /proc --dev /dev --tmpfs /tmp \
         --setenv PATH /opt/venv/bin:/usr/local/bin:/usr/bin:/bin --die-with-parent \
         /opt/venv/bin/python -c 'import scanpy, anndata, spatialdata; print(\"STACK IMPORT OK\", scanpy.__version__)'"
    );
    let out = sh_out(&run);
    assert!(
        out.contains("STACK IMPORT OK"),
        "the signed+verified GHCR rootfs runs: {out}"
    );
    let _ = Command::new("fusermount").args(["-u", &m]).output();
}

/// RAII: tear down the registry container + any fuse mounts + the temp dir.
///
/// It clears no environment variables because these tests set none — every seam is
/// passed explicitly and the app-data override is thread-scoped, so both revert with
/// their own guards. The unmount sweep walks the WHOLE work dir rather than a single
/// `appdata` child: one test uses two cache roots (`appdata` + `appdata-neg`) and
/// another puts the cache at the work root, and a mount missed here survives the
/// `remove_dir_all` as a live squashfuse daemon over a deleted path.
fn scopeguard(work: std::path::PathBuf) -> impl Drop {
    struct G(std::path::PathBuf);
    impl Drop for G {
        fn drop(&mut self) {
            let _ = Command::new("sh")
                .arg("-c")
                .arg("docker rm -f env-oci-reg >/dev/null 2>&1")
                .output();
            // best-effort unmount anything under any of this test's cache roots
            if self.0.exists() {
                unmount_recursive(&self.0);
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    G(work)
}

fn unmount_recursive(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n == "mnt") {
                    let _ = Command::new("fusermount")
                        .args(["-u", &p.to_string_lossy()])
                        .output();
                } else {
                    unmount_recursive(&p);
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// E5 / #193 — the LOCAL build + run loop, asserted against REAL locally built artifacts.
//
// TEST-2 / TEST-3 / TEST-11. What these add over
// `env_image::each_shipped_env_id_resolves_to_its_own_staged_rootfs` (the E1 unit test)
// is the SUBJECT, not the mechanism: that one stages synthetic directories through the
// LEGACY dir seam inside this process; these stage the REAL multi-hundred-MB squashfs
// artifacts `scripts/build-env-rootfs-local.sh` just built, through SEAM 1 — the seam
// `env_image`'s own docs call *preferred*, and the one the substitution defect
// (#189/PROV-E1-5) actually lived on. A mechanism proven on a fixture and a mechanism
// proven on the artifact a developer will really stage are different claims.
//
// ── WHY A CHILD PROCESS, AND NOT `set_var` ──────────────────────────────────────────
// The air-gap seams are read off the PROCESS environment, and this file's header
// forbids `set_var` outright: `env_image` reads its configuration LIVE and in-process,
// so for as long as a setter runs, every sibling test in this binary resolving an
// env-ref sees it. That was measured, not theoretical (round-15 cross-test
// contamination). `scoped_data_root` solves it for the data dir because that has a
// thread-local seam; the seam VARIABLES have none, by design — they are what an
// operator sets.
//
// So the seams are set the way an operator sets them: on a CHILD PROCESS. The child is
// this same test binary re-executed with `--exact` and a probe marker, which means the
// code under test is the real `OciEnvImageProvider::provide` with DEFAULT seams
// (`air_gap` ON — no `bypass_air_gap_env` here, that would skip the very branch under
// test), driven exactly as a deployment drives it. Nothing in this process's
// environment is touched.
//
// It also makes the ITEM-7 hazard unavoidable rather than incidental: the per-env seam
// key contains the env id, every id this tree ships contains `-`, and a `-` is not legal
// in a shell identifier — so `Command::env` (like `env(1)`) is the ONLY way to set it.
// A test that used `export` could not have been written at all.

/// The child-mode marker: when set, the test below is a PROBE rather than the driver.
const PROBE_ENV: &str = "TXR_E5_PROBE_ENV";

/// `<repo>/.txr-cache/env-rootfs/<id>-schema<N>-<arch>.squashfs` — the layout
/// `fetch-env-rootfs.sh` owns and `build-env-rootfs-local.sh` writes into, so a locally
/// built artifact and a fetched one are interchangeable here.
fn staged_artifact(env_id: &str) -> std::path::PathBuf {
    let arch = cache_arch().unwrap_or_else(|| {
        panic!(
            "this host's architecture is not one the env-rootfs scripts support, so no \
             artifact filename can exist for it. Set TXR_ENV_ARCH to name one \
             explicitly. Refusing to guess a filename and then report a skip about it."
        )
    });
    repo_root()
        .join(".txr-cache/env-rootfs")
        .join(format!("{env_id}-schema{ROOTFS_SCHEMA_VERSION}-{arch}.squashfs"))
}

/// The arch component of the cache filename, DERIVED rather than typed. It was the
/// literal `amd64`, which on an arm64 host would have made this test look for a file the
/// loop never writes and `record_skip` forever — per-env coverage silently absent on a
/// whole class of machine, the same "green while nothing ran" shape the rest of this file
/// is careful about.
///
/// **It asks `uname -m`, not `std::env::consts::ARCH`.** The scripts that WRITE this
/// filename ask the host; `consts::ARCH` is this binary's COMPILE TARGET, and the two
/// diverge under cross-compilation or emulation — where the script would write the host's
/// name and this would look for the target's, reintroducing the permanent skip by a
/// subtler route. `TXR_ENV_ARCH` overrides both, exactly as it does in the scripts.
///
/// An architecture the scripts refuse (they map anything but x86_64/aarch64 to an empty
/// value and die) yields `None` here rather than a made-up name, so the caller reports a
/// clear precondition failure instead of hunting for a filename that cannot exist.
fn cache_arch() -> Option<String> {
    if let Ok(a) = std::env::var("TXR_ENV_ARCH") {
        if !a.trim().is_empty() {
            return Some(a.trim().to_string());
        }
    }
    let uname = Command::new("uname").arg("-m").output().ok()?;
    match String::from_utf8_lossy(&uname.stdout).trim() {
        "x86_64" | "amd64" => Some("amd64".to_string()),
        "aarch64" | "arm64" => Some("arm64".to_string()),
        _ => None,
    }
}

fn repo_root() -> std::path::PathBuf {
    // `CARGO_MANIFEST_DIR` is `<repo>/src-app/server`.
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// The env ids this tree SHIPS RECIPES FOR — derived, never typed. Same discovery the
/// publisher and the parked workflow use.
fn shipped_env_ids() -> Vec<String> {
    txresbench::modules::rootfs::version::discover_env_recipes(
        &repo_root().join("src-app/env-rootfs"),
    )
}

/// One probe run: a child process asking `provide()` for ONE env, with whatever seam
/// variables the parent handed it. Prints a single machine-readable line and exits 0
/// either way — success and refusal are both OUTCOMES, and the parent distinguishes them
/// by content. A non-zero exit therefore means the probe did not run, which the parent
/// treats as a hard failure rather than as "refused" (the exact confusion
/// `verify-r-rootfs-local.sh`'s network probe was rewritten to remove).
fn probe_child(env_id: &str) {
    match OciEnvImageProvider::new().provide(env_id, std::time::Duration::from_secs(600)) {
        Ok(p) => println!(
            "PROBE_OK env={env_id} digest={} dir={}",
            p.digest.unwrap_or_default(),
            p.rootfs_dir.display()
        ),
        Err(e) => println!(
            "PROBE_ERR env={env_id} code={} msg={}",
            e.error_code(),
            e.to_string().replace('\n', " ")
        ),
    }
}

/// Outcome of one child probe.
enum Probe {
    Ok { digest: String },
    Err { code: String, msg: String },
}

/// Re-exec THIS test binary in probe mode with `seams` on its environment.
///
/// `data_dir` is passed as `TXR_APP_DATA_DIR` — the documented SUBPROCESS counterpart of
/// `scoped_data_root` — and is shared across every probe so the digest cache is populated
/// once. Staging hard-links rather than copying, so a second probe over the same artifact
/// costs a hash, not a gigabyte.
fn run_probe(env_id: &str, data_dir: &Path, seams: &[(String, String)]) -> Probe {
    let exe = std::env::current_exe().expect("test binary path");
    let mut cmd = Command::new(exe);
    cmd.args([
        "--exact",
        "sandbox::env_image_oci_test::each_locally_built_env_resolves_to_its_own_artifact",
        "--nocapture",
        "--test-threads=1",
    ])
    .env(PROBE_ENV, env_id)
    .env("TXR_APP_DATA_DIR", data_dir)
    // The child must start from a CLEAN seam environment: whatever this box exported to
    // run the rootfs-gated tiers would otherwise leak in and decide the outcome, which is
    // precisely the no-op trap this test exists to close.
    .env_remove("TXR_ENV_ROOTFS_SQUASHFS")
    .env_remove("TXR_ENV_ROOTFS_SQUASHFS_ENV")
    .env_remove("TXR_ENV_ROOTFS_DIR")
    .env_remove("TXR_ENV_ROOTFS_DIR_ENV")
    .env_remove("TXR_SANDBOX_ENV_ID");
    for id in shipped_env_ids() {
        cmd.env_remove(format!("TXR_ENV_ROOTFS_SQUASHFS__{id}"));
        cmd.env_remove(format!("TXR_ENV_ROOTFS_DIR__{id}"));
    }
    for (k, v) in seams {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("spawn the probe child");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        out.status.success(),
        "the probe child exited {:?} — it did not RUN, so its silence says nothing about \
         the seam. A refusal is reported as PROBE_ERR on stdout with exit 0.\n\
         --- stdout ---\n{stdout}\n--- stderr ---\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    // The marker is located by SUBSTRING, not by `starts_with`: under `--nocapture`
    // libtest writes the probe's `println!` onto its own unterminated
    // `test <name> ... ` progress line, so the probe output is mid-line. Anchoring at
    // the start of a line looked correct and found nothing — and the failure it produced
    // ("no probe line") is indistinguishable from the real thing this guard is for, a
    // child that selected zero tests. Both are still caught; only the parse changed.
    let start = stdout
        .find("PROBE_OK ")
        .or_else(|| stdout.find("PROBE_ERR "))
        .unwrap_or_else(|| {
            panic!(
                "the probe child emitted NO probe line — libtest most likely selected zero \
                 tests, which would make every assertion below range over nothing.\n\
                 --- stdout ---\n{stdout}"
            )
        });
    let line = stdout[start..]
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    // Anti-vacuity for the OTHER half of the same worry: a child that ran zero tests
    // cannot have printed a marker, but a child that ran the WRONG test could. libtest's
    // own summary is the witness, and it is asserted rather than assumed.
    // ANCHORED, not a substring: `contains("1 passed")` is satisfied by libtest's
    // `11 passed`, `21 passed`, `41 passed` — so "exactly one passing test" was not what
    // it asserted. The justfile twin for the same hazard already anchors on the line
    // start; this one now matches it.
    assert!(
        stdout
            .lines()
            .any(|l| l.starts_with("test result: ok. 1 passed")),
        "the probe child did not report EXACTLY one passing test, so the marker above may \
         not be this probe's:\n--- stdout ---\n{stdout}"
    );
    // Echo every probe outcome into the PARENT's output. The child's stdout is captured
    // by `output()`, so without this the run log records only "ok" and the evidence for
    // what was actually resolved or refused lives nowhere. A test whose log cannot show
    // what it observed is a test nobody can audit after the fact.
    eprintln!(
        "[E5 probe] requested={env_id} seams=[{}] -> {}",
        seams
            .iter()
            .map(|(k, _)| k.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        line
    );
    let field = |k: &str| -> String {
        line.split(&format!("{k}="))
            .nth(1)
            .map(|r| r.split(' ').next().unwrap_or("").to_string())
            .unwrap_or_default()
    };
    if line.starts_with("PROBE_OK ") {
        Probe::Ok { digest: field("digest") }
    } else {
        Probe::Err {
            code: field("code"),
            msg: line
                .split_once(" msg=")
                .map(|(_, m)| m.to_string())
                .unwrap_or_default(),
        }
    }
}

fn expect_ok(p: Probe, what: &str) -> String {
    match p {
        Probe::Ok { digest } => digest,
        Probe::Err { code, msg } => panic!("{what}: expected a mount, got refusal {code}: {msg}"),
    }
}

fn expect_err(p: Probe, what: &str) -> (String, String) {
    match p {
        Probe::Err { code, msg } => (code, msg),
        Probe::Ok { digest } => panic!(
            "{what}: expected a REFUSAL, got a mount at digest {digest}. This is the \
             silent-substitution defect: a job asking for an env with no local artifact \
             was served some OTHER env's rootfs, and would run its code against the wrong \
             interpreter and report the result as though the analysis were broken."
        ),
    }
}

/// **TEST-2 [acceptance] [invariant: INV-2] · TEST-3 · TEST-11** — two REAL locally built
/// env images, staged through seam 1; each env resolves to ITS OWN artifact, and an env
/// with no local artifact is REFUSED BY NAME.
#[test]
fn each_locally_built_env_resolves_to_its_own_artifact() {
    // ── CHILD MODE ──────────────────────────────────────────────────────────────
    if let Some(id) = std::env::var_os(PROBE_ENV) {
        return probe_child(&id.to_string_lossy());
    }

    // ── PARENT MODE ─────────────────────────────────────────────────────────────
    if !have("squashfuse") {
        record_skip(
            "each_locally_built_env_resolves_to_its_own_artifact",
            "needs squashfuse on PATH (the provider mounts the staged squashfs by digest)",
        );
        return;
    }
    let ids = shipped_env_ids();
    assert!(
        ids.len() >= 2,
        "this test is about telling two envs APART and needs two recipes; the tree \
         declares {ids:?}. Deriving over an empty or single-element set would make every \
         assertion below vacuous."
    );
    // Artifacts are the LOOP's output, not this test's — it asserts about what the loop
    // produced. A missing artifact is a recorded skip naming the exact command, never a
    // silent pass.
    for id in &ids {
        let p = staged_artifact(id);
        if !p.is_file() {
            record_skip(
                "each_locally_built_env_resolves_to_its_own_artifact",
                &format!(
                    "no locally built artifact at {} — build them first: \
                     scripts/build-env-rootfs-local.sh --all",
                    p.display()
                ),
            );
            return;
        }
    }

    // The sha256 the LOOP recorded beside each artifact. Read from the sidecar rather
    // than recomputed here on purpose: TEST-11's claim is that the identity the loop
    // REPORTS is the identity the runtime RECORDS. Recomputing it here would compare the
    // runtime against this test instead, and the two could then agree while the number a
    // developer reads on their terminal was something else entirely.
    let reported: Vec<String> = ids
        .iter()
        .map(|id| {
            let side = staged_artifact(id).with_extension("sha256");
            std::fs::read_to_string(&side)
                .unwrap_or_else(|e| panic!("read {}: {e}", side.display()))
                .trim()
                .to_string()
        })
        .collect();
    assert_ne!(
        reported[0], reported[1],
        "the two locally built artifacts hash the same, so nothing below could tell them \
         apart. Rebuild them: scripts/build-env-rootfs-local.sh --all"
    );

    let work = std::env::temp_dir().join(format!("e5-local-loop-{}", uuid::Uuid::new_v4()));
    let data = work.join("appdata");
    std::fs::create_dir_all(&data).unwrap();
    let _guard = scopeguard(work.clone());

    let sq = |id: &str| -> (String, String) {
        (
            format!("TXR_ENV_ROOTFS_SQUASHFS__{id}"),
            staged_artifact(id).to_string_lossy().to_string(),
        )
    };

    // ── 1. BOTH staged, each under its own env's seam key ───────────────────────
    let both = vec![sq(&ids[0]), sq(&ids[1])];
    let got_0 = expect_ok(run_probe(&ids[0], &data, &both), &format!("env {:?}", ids[0]));
    let got_1 = expect_ok(run_probe(&ids[1], &data, &both), &format!("env {:?}", ids[1]));
    assert_eq!(
        got_0, reported[0],
        "env {:?} mounted a rootfs whose content digest is not the one the local loop \
         staged and reported for it",
        ids[0]
    );
    assert_eq!(
        got_1, reported[1],
        "env {:?} mounted a rootfs whose content digest is not the one the local loop \
         staged and reported for it — this is the silent substitution the whole epic is \
         about, and it presents as the ENVIRONMENT being broken rather than as a resolver \
         returning the wrong thing",
        ids[1]
    );
    assert_ne!(got_0, got_1, "two envs, two artifacts, two digests");

    // ── 2. Only ONE staged: the other must REFUSE, by name, in BOTH directions ──
    // Both directions, because the shipped ids are `<x>` and `<x>-<suffix>` — one is a
    // PREFIX of the other — so a check that only ever asks in the direction where the
    // requested id is the longer one is a check whose removal step does the work by
    // accident. Quoted forms are used because that is how the message renders an id.
    for (staged, requested) in [(0usize, 1usize), (1usize, 0usize)] {
        let only = vec![sq(&ids[staged])];
        let (code, msg) = expect_err(
            run_probe(&ids[requested], &data, &only),
            &format!("env {:?} with only {:?} staged", ids[requested], ids[staged]),
        );
        assert_eq!(
            code,
            txresbench::modules::sandbox::env_image::ENV_STAGED_MISMATCH_CODE,
            "the refusal must carry the typed staged-env-mismatch code, not a generic one: {msg}"
        );
        let q_req = format!("{:?}", ids[requested]);
        let q_staged = format!("{:?}", ids[staged]);
        assert!(
            msg.contains(&q_req),
            "the refusal must name the env that was REQUESTED: {msg}"
        );
        assert!(
            msg.replace(&q_req, "").contains(&q_staged),
            "the refusal must name the env that IS STAGED, independently of the requested \
             one — checked with the requested id removed first, because one shipped id is a \
             prefix of the other and a plain `contains` would pass on the requested id \
             alone. message: {msg}"
        );

        // CONTROL. Without it, "the other env errored" is indistinguishable from "the seam
        // is broken", and this whole block would pass with the env scoping deleted.
        let still = expect_ok(
            run_probe(&ids[staged], &data, &only),
            &format!("the STAGED env {:?} must still resolve", ids[staged]),
        );
        assert_eq!(still, reported[staged]);
    }

    // ── 3. TEST-3 — the no-op trap, on the BARE variable ────────────────────────
    // This is the shape `just e2e-processors` uses today (one bare seam), and the shape
    // the pre-#189 defect lived in: the bare variable was consulted before `env_id` was
    // read at all. The assertion is on the OUTCOME — which artifact came back — never on
    // whether a variable was consulted.
    let bare = vec![
        (
            "TXR_ENV_ROOTFS_SQUASHFS".to_string(),
            staged_artifact(&ids[0]).to_string_lossy().to_string(),
        ),
        ("TXR_ENV_ROOTFS_SQUASHFS_ENV".to_string(), ids[0].clone()),
    ];
    let served = expect_ok(
        run_probe(&ids[0], &data, &bare),
        "the bare seam must still serve the single env it declares (back-compat, DEC-3)",
    );
    assert_eq!(served, reported[0]);
    let (code, msg) = expect_err(
        run_probe(&ids[1], &data, &bare),
        "a DIFFERENT env must not be served the bare seam's artifact",
    );
    assert_eq!(code, txresbench::modules::sandbox::env_image::ENV_STAGED_MISMATCH_CODE);
    assert!(
        msg.contains(&format!("{:?}", ids[1])),
        "the refusal must name the requested env: {msg}"
    );
}
