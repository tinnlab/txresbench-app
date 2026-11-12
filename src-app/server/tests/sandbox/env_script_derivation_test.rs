//! **#196 / E8 — PROV-E8-2.** The build-tier SCRIPTS derive the env set from the same
//! union the binary reads, and refuse rather than guess.
//!
//! ── why these are worth testing at all ──────────────────────────────────────────
//! `scripts/fetch-env-rootfs.sh` and `scripts/publish-env-rootfs.sh` sit outside every
//! Rust gate: nothing compiles them, no suite ran them, and `check-derived-vocabulary.sh`
//! only proves they contain no env-name LITERAL — not that their derivation is correct.
//! That is precisely the gap #196 was filed for. The fetch script's reader was scoped to
//! the `converters:` block, so the script whose entire job is to fetch an env would report
//! *"no processor manifest declares an env image"* about a manifest that declares exactly
//! that, and its refuse-and-name path would list half the candidates. A script that reads
//! one half of a union fails while LOOKING like it derived.
//!
//! ── the fixture ────────────────────────────────────────────────────────────────
//! Both scripts resolve their repo root as `dirname $0/..`, so a synthetic tree with the
//! script copied into `<tmp>/scripts/` is enough — no git repo, no network. `--print-path`
//! and the refusal paths both exit before anything is fetched or built.
//!
//! **No env-id, and no manifest of the real tree, is named here.** The fixtures declare
//! their own synthetic ids, so these cases keep meaning what they mean when the real tree
//! grows a second env.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("CARGO_MANIFEST_DIR is <repo>/src-app/server")
        .to_path_buf()
}

/// A synthetic repo root holding a copy of the script under test.
struct ScriptFixture {
    root: PathBuf,
}

impl ScriptFixture {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("txr-envscript-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(root.join("scripts")).expect("create fixture root");
        // The schema constant `fetch-env-rootfs.sh` reads rather than duplicating.
        Self::put(
            &root,
            "src-app/server/src/modules/rootfs/version.rs",
            "pub const ROOTFS_SCHEMA_VERSION: u32 = 5;\n",
        );
        Self { root }
    }

    fn put(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().expect("has a parent")).expect("mkdir -p");
        fs::write(&p, body).unwrap_or_else(|e| panic!("write {}: {e}", p.display()));
    }

    fn write(&self, rel: &str, body: &str) -> &Self {
        Self::put(&self.root, rel, body);
        self
    }

    /// Copy the COMMITTED script under test in, so these cases run its real bytes.
    fn with_script(&self, name: &str) -> &Self {
        let src = repo_root().join("scripts").join(name);
        let dst = self.root.join("scripts").join(name);
        fs::copy(&src, &dst).unwrap_or_else(|e| panic!("copy {}: {e}", src.display()));
        let mut perms = fs::metadata(&dst).expect("stat").permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
        }
        fs::set_permissions(&dst, perms).expect("chmod");

        // #196 R7 — the scripts now source `scripts/lib/*.sh` (the env-id grammar, the
        // behavioural image verifier). A fixture that copies only the entry script would
        // make every one of these tests fail on a missing source, which is a fixture gap
        // rather than a finding. Copy the whole lib dir, DERIVED — naming the files here
        // would be the enumeration this item exists to retire, one level down in the test.
        let lib_src = repo_root().join("scripts").join("lib");
        if lib_src.is_dir() {
            let lib_dst = self.root.join("scripts").join("lib");
            fs::create_dir_all(&lib_dst).expect("mkdir scripts/lib");
            for entry in fs::read_dir(&lib_src).expect("read scripts/lib").flatten() {
                let from = entry.path();
                if from.extension().and_then(|e| e.to_str()) == Some("sh") {
                    let to = lib_dst.join(entry.file_name());
                    fs::copy(&from, &to)
                        .unwrap_or_else(|e| panic!("copy {}: {e}", from.display()));
                }
            }
        }
        self
    }

    /// A package manifest declaring `env` on the given contribution kind(s).
    fn manifest(&self, pkg: &str, body: &str) -> &Self {
        self.write(&format!("src-app/packages/{pkg}/manifest.yaml"), body)
    }

    /// An env recipe on disk (what the PUBLISH script derives from — the recipe tree,
    /// not the manifests).
    fn recipe(&self, id: &str) -> &Self {
        self.write(
            &format!("src-app/env-rootfs/{id}/Dockerfile"),
            "FROM scratch\nARG ROOTFS_SCHEMA_VERSION=5\n",
        )
    }

    fn run(&self, script: &str, args: &[&str]) -> (Output, String) {
        let out = Command::new("bash")
            .arg(format!("scripts/{script}"))
            .args(args)
            .current_dir(&self.root)
            // A stray operator override in the ambient environment would make the
            // derivation moot — these cases are about what the MANIFESTS say.
            .env_remove("TXR_SANDBOX_ENV_ID")
            .env_remove("TXR_ENV_ROOTFS_CACHE")
            .output()
            .unwrap_or_else(|e| panic!("run scripts/{script}: {e}"));
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        (out, text)
    }
}

impl Drop for ScriptFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

const FETCH: &str = "fetch-env-rootfs.sh";
const PUBLISH: &str = "publish-env-rootfs.sh";

/// One converter-declared env and one analysis-declared env, in ONE manifest with the
/// blocks ADJACENT. The adjacency is deliberate: a `  analyses:` line both closes the
/// `converters:` block and opens its own, and an awk that `next`s on that dedent silently
/// drops whichever block came second — a bug two separate manifests would hide.
const TWO_KINDS: &str = "id: pkg-two\n\
                         contributes:\n\
                         \x20 converters:\n\
                         \x20   - id: conv-1\n\
                         \x20     env: envfix-conv\n\
                         \x20 analyses:\n\
                         \x20   - id: ana-1\n\
                         \x20     env: envfix-ana\n";

/// **TEST-3 [acceptance] [invariant: INV-1]**, part 1 — an env declared ONLY by an
/// ANALYSIS is DERIVED by the fetch script. Before #196 this fixture produced
/// *"no processor manifest declares an env image"*.
#[test]
fn the_fetch_script_derives_an_analysis_declared_env() {
    let fx = ScriptFixture::new("fetch-analysis");
    fx.with_script(FETCH).manifest(
        "pkg-ana",
        "id: pkg-ana\ncontributes:\n  analyses:\n    - id: ana-1\n      env: envfix-ana\n",
    );

    let (out, text) = fx.run(FETCH, &["--print-path"]);
    assert!(
        out.status.success(),
        "the sole declared env came from an ANALYSIS and the script refused to see it. \
         The reader is still scoped to the converters block.\n{text}"
    );
    assert!(
        text.contains("envfix-ana"),
        "the resolved cache path must name the analysis-declared env:\n{text}"
    );
}

/// **TEST-3**, part 2 — with one env from EACH contribution kind, the script refuses and
/// names BOTH. Naming half the candidates is the failure that looks like success: the
/// operator picks from the list they were shown.
#[test]
fn the_fetch_script_refuses_naming_every_declared_env_from_both_kinds() {
    let fx = ScriptFixture::new("fetch-both");
    fx.with_script(FETCH).manifest("pkg-two", TWO_KINDS);

    let (out, text) = fx.run(FETCH, &["--print-path"]);
    assert!(
        !out.status.success(),
        "two envs are declared, so which to fetch is a CHOICE the script must refuse to \
         make.\n{text}"
    );
    assert!(
        text.contains("2 env images are declared"),
        "the refusal must count BOTH kinds — a count of 1 means half the union is \
         unread:\n{text}"
    );
    for id in ["envfix-conv", "envfix-ana"] {
        assert!(
            text.contains(id),
            "the refusal must NAME `{id}`; an operator can only choose from what they are \
             shown, so a half-list silently steers them:\n{text}"
        );
    }
}

/// **TEST-3**, part 3 — naming the analysis-declared env explicitly RESOLVES it, so the
/// candidate the refusal above printed is actually usable. A list naming an id the script
/// then rejects would be a worse bug than the one this fixes.
#[test]
fn the_fetch_script_resolves_the_analysis_declared_env_by_name() {
    let fx = ScriptFixture::new("fetch-byname");
    fx.with_script(FETCH).manifest("pkg-two", TWO_KINDS);

    let (out, text) = fx.run(FETCH, &["--print-path", "envfix-ana"]);
    assert!(out.status.success(), "naming a declared env must resolve it:\n{text}");
    assert!(text.contains("envfix-ana"), "{text}");
    assert!(
        !text.contains("envfix-conv"),
        "it must resolve the env NAMED, not the first one declared:\n{text}"
    );
}

/// **TEST-3**, part 4 — ANTI-VACUITY (ITEM-8). With nothing declared the script REFUSES;
/// it never falls back to a guessed id. This is the branch a collapsed reader lands in, so
/// it must be a loud refusal rather than a default.
#[test]
fn the_fetch_script_refuses_rather_than_guessing_when_nothing_is_declared() {
    let fx = ScriptFixture::new("fetch-none");
    fx.with_script(FETCH)
        .manifest("pkg-bare", "id: pkg-bare\ncontributes:\n  analyses:\n    - id: ana-1\n");

    let (out, text) = fx.run(FETCH, &["--print-path"]);
    assert!(!out.status.success(), "an empty derivation must FAIL:\n{text}");
    assert!(
        text.contains("no processor manifest declares an env image"),
        "{text}"
    );
    assert!(
        text.contains("CONVERTER") && text.contains("ANALYSIS"),
        "the remediation must name BOTH places an env may be declared, or it sends the \
         reader to fix half the problem:\n{text}"
    );
}

/// **TEST-4 [covers: ITEM-4]** — the PUBLISH script was ALREADY multi-env-correct before
/// #196 (it derives from the recipe tree, not the manifests, and refuses when the choice is
/// real). ITEM-4 is therefore verification, not change — and this is the pin that keeps it
/// verification: the publish path writes the MOVING tag running deployments resolve, so a
/// regression to "publish whichever recipe sorts first" is not a recoverable mistake.
#[test]
fn the_publish_script_refuses_and_names_every_recipe_when_the_choice_is_real() {
    let fx = ScriptFixture::new("publish-two");
    fx.with_script(PUBLISH).recipe("envfix-alpha").recipe("envfix-beta");

    let (out, text) = fx.run(PUBLISH, &["--dry-run"]);
    assert!(
        !out.status.success(),
        "two recipes are on disk; publishing one of them is a CHOICE:\n{text}"
    );
    assert!(text.contains("2 env recipes are available"), "{text}");
    for id in ["envfix-alpha", "envfix-beta"] {
        assert!(text.contains(id), "the refusal must name `{id}`:\n{text}");
    }
}

/// **TEST-4**, part 2 — an `--env` naming no recipe is refused, naming what does exist.
/// Without this the derived candidate list could be correct while the selector silently
/// accepted anything and failed much later, inside docker.
#[test]
fn the_publish_script_refuses_an_env_that_names_no_recipe() {
    let fx = ScriptFixture::new("publish-unknown");
    fx.with_script(PUBLISH).recipe("envfix-alpha");

    let (out, text) = fx.run(PUBLISH, &["--env", "envfix-nonesuch", "--dry-run"]);
    assert!(!out.status.success(), "an unknown env must be refused:\n{text}");
    assert!(text.contains("envfix-nonesuch"), "names what was asked for:\n{text}");
    assert!(text.contains("envfix-alpha"), "names what exists:\n{text}");
}

/// **TEST-16** [ITEM-12] — the SHELL env-id grammar and the RUST one agree.
///
/// `is_valid_env_id` (`sandbox/env_id.rs`) is single-sourced between the runtime and the
/// build lint by a `#[path]` include, because a grammar spelled twice drifts and the
/// drift that matters is silent. Shell cannot include Rust, so `scripts/lib/`
/// `env-id-grammar.sh` is a second implementation — and this test is what stops it being
/// a MIRROR. It runs the real shell function over the same table the Rust grammar test
/// uses and demands identical verdicts.
///
/// The table deliberately includes the shapes a mis-parsed YAML value actually produces
/// (`>-`, `*E`, `x  # note`), because refusing those is the whole point of validating a
/// derived id at all (#196 R7).
#[test]
fn the_shell_env_id_grammar_matches_the_rust_one() {
    // (case, expected-valid) — the Rust side of each is asserted by
    // `env_image::tests::is_valid_env_id_grammar` and `env_id`'s own unit tests.
    let cases: &[(&str, bool)] = &[
        ("demo-env", true),
        ("env-two", true),
        ("env.three", true),
        ("env_four", true),
        ("a", true),
        ("x.y_z-1", true),
        ("0", true),
        ("", false),
        ("Mixed-Case", false),
        ("UP", false),
        ("a/b", false),
        ("x:tag", false),
        ("y@sha256:abc", false),
        ("has space", false),
        // The shapes a mis-parsed YAML value yields — the reason this validation exists.
        (">-", false),
        ("*E", false),
        ("x  # note", false),
        ("{id:", false),
    ];

    let lib = repo_root().join("scripts/lib/env-id-grammar.sh");
    assert!(lib.is_file(), "the shell grammar must exist at {}", lib.display());

    for (case, want) in cases {
        // `--` and a positional keep a leading-dash case from being read as a flag.
        let out: Output = Command::new("bash")
            .arg("-c")
            .arg(format!(
                ". {} && txr_is_valid_env_id \"$1\"",
                lib.display()
            ))
            .arg("bash")
            .arg(case)
            .output()
            .expect("run the shell grammar");
        let got = out.status.success();
        assert_eq!(
            got,
            *want,
            "shell grammar disagrees with the Rust grammar on {case:?}: shell says \
             {got}, Rust says {want}. These two must not drift — change both, or change \
             neither (see scripts/lib/env-id-grammar.sh)."
        );
    }
}

/// **TEST-20** [ITEM-12] — the env-id grammar gates the OPERATOR channel too.
///
/// The first version validated only DERIVED ids, so a positional argument or
/// `TXR_SANDBOX_ENV_ID` flowed unvalidated into the pull reference and the cache path —
/// a value ending `:evil` smuggles a tag into the OCI reference, `../../../x` escapes the
/// cache directory. `env_id.rs` states that stopping exactly that is the grammar's whole
/// purpose, and the operator channel is the one that most needs it. A blind verifier found
/// the gap; this is what keeps it shut.
#[test]
fn a_malformed_operator_supplied_env_id_is_refused_before_it_reaches_a_pull_ref() {
    let fx = ScriptFixture::new("operator-id");
    fx.with_script(FETCH).recipe("envfix-alpha");

    for bad in [
        "envfix-alpha:evil",       // smuggles a TAG into the reference
        "../../../other/repo",     // escapes the cache directory
        "ghcr.io/elsewhere/x",     // smuggles a REGISTRY HOST
        "UPPER",                   // not a legal OCI path component
    ] {
        let (out, text) = fx.run(FETCH, &[bad]);
        assert!(
            !out.status.success(),
            "an operator-supplied `{bad}` must be REFUSED, not built into a pull ref:\n{text}"
        );
        assert!(
            text.contains("malformed env id"),
            "the refusal must say what it rejected, for `{bad}`:\n{text}"
        );
        assert!(
            text.contains(bad),
            "the refusal must echo the offending value `{bad}`:\n{text}"
        );
    }
}
