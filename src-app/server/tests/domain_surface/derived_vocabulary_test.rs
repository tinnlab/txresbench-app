//! TEST-6 (ITEM-21) [acceptance] [invariant: INV-5] — the DERIVED-vocabulary guard
//! catches the **N+1** term.
//!
//! ── WHAT WOULD MAKE THIS TEST HOLLOW ────────────────────────────────────────────
//! Asserting that `scripts/check-derived-vocabulary.sh` is green against today's
//! processors. That passes for `check-kinds-zero-core.sh` too, and that guard is
//! exactly the thing ITEM-21 exists to replace: it HARD-CODES three kind ids, so it
//! only ever catches the domain terms somebody remembered to type into it. The term
//! contributed TOMORROW leaks past it in silence, and a green test over today's tree
//! is precisely the evidence that fails to notice.
//!
//! So the property under test is the one that distinguishes a derived guard from a
//! hard-coded one:
//!
//!   a processor manifest declaring a PREVIOUSLY-UNSEEN term makes that term
//!   forbidden in app-core immediately, **with the guard file byte-identical**.
//!
//! Every case below runs against a synthetic repo — the guard is a `cd $(git
//! rev-parse --show-toplevel)` shell script, so a fixture repo is the only way to
//! plant a leak without dirtying the real tree (and the only way to plant one at all:
//! the real tree is green and must stay that way).
//!
//! ── CASES ───────────────────────────────────────────────────────────────────────
//!   control      a well-formed fixture, no leak                              → PASS
//!   N+1          a NEW package declares `novelfam/widget`; it is planted in
//!                an app-core file; the guard is NOT edited                   → FAIL
//!   negative 1   the same term only under a `tests/` path                    → PASS
//!   negative 2   the same term only inside `#[cfg(test)]` in an app-core file → PASS
//!   negative 3   the same term only in the DATA manifest that declares it    → PASS
//!   boundary     a LONGER distinct token (`novelfam/widget-extended`)        → PASS
//!   floors       a collapsed manifest set / a collapsed app-core set         → FAIL
//!   derived-2    the term in the SECOND reserved framework package           → FAIL
//!   derived-3    a reserved package the SERVER names that the glob misses     → FAIL
//!
//! The last two are the same N+1 property applied one ring out. The framework surface
//! was itself a hard-coded LIST of one root (`_lib`) — so the framework package added
//! later (`_helpers`, staged into every Python entry) went unscanned for four rounds,
//! with three contributed-datatype literals in it and the guard printing PASS. The
//! surface is now DERIVED from `packages/_*/manifest.yaml`, and `derived-3` pins the
//! cross-check that keeps the derivation itself from falling behind.
//!
//! Negatives 1-3 are what stop the guard being a blunt `grep` that fires on its own
//! source of truth; the boundary case is what stops it firing on
//! `metadata-column-family` (a registry capability id) because the datatype id
//! `metadata-column` is a prefix of it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// ── local scaffolding ───────────────────────────────────────────────────────────
// `TmpRepo` is duplicated (minimally) in `tests/workstore/dependency_guard_test.rs`.
// That is deliberate: the two suites are unrelated, there is no test-util module both
// may edit without touching a file another agent owns, and a `workstore` test reaching
// into a `domain_surface` module would break the moment either is renamed. Forty lines
// of independent scaffolding is the cheaper coupling.

/// `<repo>` — `CARGO_MANIFEST_DIR` is `<repo>/src-app/server`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("CARGO_MANIFEST_DIR is <repo>/src-app/server")
        .to_path_buf()
}

/// A throwaway git repo. Every guard here starts with `cd $(git rev-parse
/// --show-toplevel)`, so a real repo — not just a directory — is the minimum fixture.
struct TmpRepo {
    root: PathBuf,
}

impl TmpRepo {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("txr-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&root).expect("create fixture root");
        let st = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .expect("git must be available to run a repo-rooted guard");
        assert!(st.success(), "git init failed in {}", root.display());
        Self { root }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn write(&self, rel: &str, body: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().expect("has a parent")).expect("mkdir -p");
        fs::write(&p, body).unwrap_or_else(|e| panic!("write {}: {e}", p.display()));
    }

    fn copy_in(&self, src: &Path, rel: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().expect("has a parent")).expect("mkdir -p");
        fs::copy(src, &p)
            .unwrap_or_else(|e| panic!("copy {} -> {}: {e}", src.display(), p.display()));
    }
}

impl Drop for TmpRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// The guard under test, as committed.
fn guard_src() -> PathBuf {
    repo_root().join("scripts/check-derived-vocabulary.sh")
}

const GUARD_REL: &str = "scripts/check-derived-vocabulary.sh";
const NOVEL_TERM: &str = "novelfam/widget";

/// The fixture's two RESERVED (`_`-prefixed) framework packages. The guard DERIVES its
/// framework surface from `packages/_*/manifest.yaml` rather than from a root list, so a
/// fixture needs more than one of them for "derived" to be distinguishable from "listed".
/// Deliberately not the real package names: the fixture is a synthetic repo, and a case
/// that happens to name the real tree's packages invites reading a fixture result as a
/// statement about the tree.
/// A `scripts/` directory that is NOT the repo root's, inside a declared scan root. #324's
/// whole mechanism was that such a directory sat inside the wholesale pytest's surface and
/// outside this guard's, so a fixture without one cannot distinguish the repaired guard from
/// the one that leaked.
const NESTED_SCRIPTS: &str = "src-app/libs/synth/scripts";

const RESERVED_A: &str = "_lib";
const RESERVED_B: &str = "_aux";

/// A synthetic repo shaped like this one: a `src-app/packages/*/manifest.yaml`
/// vocabulary source, an app-core Rust tree, and the guard itself — nothing else.
/// Sized to clear the guard's own floors so a FAIL is unambiguously a LEAK and never
/// a collapsed scan set.
fn fixture() -> TmpRepo {
    let repo = TmpRepo::new("derived-vocab");
    repo.copy_in(&guard_src(), GUARD_REL);
    // #196 R7 — the guard now sources `scripts/lib/*.sh` (the env-id grammar). A fixture
    // repo without them makes the source fail, the predicate undefined, and EVERY derived
    // id read as malformed — a fixture gap that looks exactly like a finding. Copied
    // DERIVED rather than by name, for the same reason the guard derives its vocabulary.
    let lib_src = repo_root().join("scripts/lib");
    if lib_src.is_dir() {
        for entry in fs::read_dir(&lib_src).expect("read scripts/lib").flatten() {
            let from = entry.path();
            if from.extension().and_then(|e| e.to_str()) == Some("sh") {
                let rel = format!("scripts/lib/{}", entry.file_name().to_string_lossy());
                repo.copy_in(&from, &rel);
            }
        }
    }

    // ── the BUILD surface the guard grew, which this fixture did not ────────────────
    //
    // `b5443cd8` extended the guard to scan the recipes + shell that stand up the app
    // (`BUILD_SURFACE_GLOBS`, `MIN_BUILD_FILES`, `GUARD_MANIFEST`, and an env-id tier
    // derived from `contributes.converters[].env`). The fixture was not extended with it,
    // so every case here — including `control_a_clean_fixture_passes` — failed on a
    // MISSING SCAFFOLD rather than on anything it asserts. A guard hardened without its
    // fixture is the same "one ring behind what it mirrors" shape this guard exists to
    // catch, which is why the repair is to SYNTHESIZE what the guard now requires rather
    // than to lower a floor.
    //
    // Each piece below exists because the guard names it in a specific FAIL, and the
    // control test is what proves the set is complete: if a future tier adds a fourth
    // requirement, the control goes red first and says which.

    // 1. The guard manifest — a `<sha256>  <path>` list; only column 2 is read
    //    (`awk 'NF == 2 { print $2 }'`), to decide which shell files are GUARDS. A guard
    //    must spell the vocabulary it hunts, so it has to be exempt from its own scan.
    //    The digest is not verified by THIS guard, so a placeholder is honest here rather
    //    than a real hash that would rot on every guard edit.
    repo.write(
        "scripts/guard-hashes.txt",
        &format!(
            "# fixture manifest — only the PATH column is read.\n{}  {GUARD_REL}\n",
            "0".repeat(64)
        ),
    );

    // 2. At least `MIN_BUILD_FILES` build files, and the count moved because the SURFACE did.
    //
    //    #304 derived the build surface instead of enumerating it: it is now `justfile` plus
    //    EVERY file git tracks under `scripts/`, so the real tree measures 42 and the floor
    //    sits at 27. Two consequences for this fixture, both of which it must model rather
    //    than dodge:
    //      * the guard script itself, and `scripts/guard-hashes.txt`, are now COUNTED. Being
    //        pinned no longer exempts a whole file from the scan — only the lines inside a
    //        declared `txr:guard-vocabulary` block are blanked — so a guard is scanned like
    //        any build file and simply happens to be vocabulary-free unless it declares one;
    //      * the floor is 27, not 4.
    //
    //    This block therefore synthesizes enough vocabulary-free build files to clear it. That
    //    is this fixture's own stated rule, from the paragraph above: "the repair is to
    //    SYNTHESIZE what the guard now requires rather than to lower a floor", and "if a future
    //    tier adds a fourth requirement, the control goes red first and says which". It did
    //    exactly that — all seventeen cases went red on `the build scan set resolved to 8
    //    file(s), below the floor of 27`, naming the missing scaffold.
    //
    //    They are deliberately vocabulary-free; a build file that NAMES a domain term is what
    //    the negative cases inject.
    //
    //    NOTE on the `.mjs` tier the same change added: this fixture has none, and that is
    //    correct rather than a gap. `MIN_JS_TEST_FILES` applies only where a `scripts/*.mjs`
    //    tier EXISTS — a tree with none has nothing to exclude — which is the same
    //    legitimate-zero rule the guard already applies to `MIN_ENV_RECIPES`.
    //    #324 moved both numbers again, and in a way this fixture has to model rather than
    //    dodge — which is the whole reason `control_a_clean_fixture_passes` exists and is why
    //    it is what went red first, naming both:
    //      * the surface is now every `scripts/` directory AT ANY DEPTH inside the declared
    //        scan roots, and `MIN_SURFACE_DIRS` floors that walk at >= 2 precisely to assert it
    //        CROSSES THE REPO ROOT. A fixture with one `scripts/` directory cannot tell "walks
    //        every depth" from "still only walks the root" — the same distinction the two
    //        RESERVED packages above exist for, one tier out — so the fixture grows a SECOND
    //        one, nested, and the negative cases below can plant in it;
    //      * `MIN_BUILD_FILES` moved 27 -> 90 with the real surface, so the synthesized count
    //        moves with it.
    repo.write("justfile", "default:\n\t@echo build\n");
    for i in 0..60 {
        repo.write(
            &format!("scripts/build-{i:02}.sh"),
            "#!/usr/bin/env bash\nset -euo pipefail\necho ok\n",
        );
    }
    for i in 0..35 {
        repo.write(
            &format!("{NESTED_SCRIPTS}/tool-{i:02}.sh"),
            "#!/usr/bin/env bash\nset -euo pipefail\necho ok\n",
        );
    }

    // 2b. THE SHARED DECLARATION (#311/#324), which the guard now reads its SURFACE and its
    //     exemption rule from instead of carrying them as literals. It is SYNTHESIZED here
    //     rather than copied from the tree, and that is the point rather than a shortcut: the
    //     shipped declaration names real paths (`src-app/ui/scripts/...`) that this synthetic
    //     repo does not have, and the guard verifies — ungated — that every declared path
    //     names something. A fixture that copied the real file would fail on the fixture's own
    //     shape, which is the "one ring behind what it mirrors" failure this whole file exists
    //     to catch, arriving through the fixture instead of the guard.
    //
    //     It is also why the `scripts/lib` copy above filters on `.sh` and this is a WRITE: the
    //     env-id grammar is guard LOGIC the fixture wants verbatim; the declaration is guard
    //     DATA the fixture must state for itself. If a future field is added to the
    //     declaration, `control_a_clean_fixture_passes` goes red first and names it — which is
    //     exactly what happened here, and is this fixture's stated design.
    repo.write(
        "scripts/lib/zero-core-surface.txt",
        concat!(
            "# fixture declaration — the same grammar the shipped one uses, over this\n",
            "# synthetic tree's own paths.\n",
            "scan_root src-app\n",
            "scan_root scripts\n",
            "scan_root justfile\n",
            "data_root src-app/packages\n",
            // Three, not four: `__tests__` was deleted from the shipped declaration because a
            // capped exemption slot matching zero tracked files is an exemption already paid
            // for. Every declared segment must now CLASSIFY SOMETHING, so this fixture carries
            // a path for each of the three below — synthesized, the way this suite's header
            // says to meet a new requirement rather than lower it.
            "test_path_segment tests\n",
            "test_path_segment testdata\n",
            "test_path_segment fixtures\n",
            "surface_root justfile\n",
            "surface_dir scripts\n",
            "vocab_block_open txr:guard-vocabulary\n",
            "vocab_block_close txr:end-guard-vocabulary\n",
            "vocab_block_pins scripts/guard-hashes.txt\n",
        ),
    );
    // Each declared `test_path_segment` must CLASSIFY SOMETHING — a capped slot naming nothing
    // is an exemption already paid for, so the guard refuses one. These three are the paths
    // that make `tests`, `testdata` and `fixtures` mean what the declaration says they mean.
    // Clean files: they exist to be classified, not to be scanned for anything. (The first cut
    // synthesized only two, on the assumption that `tests/` arrived with an app-core fixture —
    // which is written by ONE case rather than by the builder, so the BASE fixture had no such
    // path and `control_a_clean_fixture_passes` went red naming it. Which is that control's
    // whole job.)
    repo.write("src-app/testdata/corpus.json", "{}\n");
    repo.write(
        "src-app/server/src/modules/core/tests/helper.rs",
        "pub fn helper() {}\n",
    );
    // NOT the obvious placeholder word: `src-app/ui/scripts/lint-no-domain-in-builtin.mjs` — the sibling guard over
    // this same invariant — reads that word as domain vocabulary, and flagged these two lines the first
    // time `just check` saw them. The name of a file that exists only to be CLASSIFIED must not
    // itself carry vocabulary, which is the whole invariant, one level down.
    repo.write(
        "src-app/server/src/modules/core/fixtures/holder.rs",
        "pub fn holder() {}\n",
    );

    // 3. The declared env-ids, from the same UNION `env_image::declared_envs_in()` reads.
    //    Absence read as "the manifests moved or their shape changed", which is exactly
    //    what had happened — to the fixture, not to the tree.
    //
    //    #196: TWO declarations, one on a CONVERTER and one on an ANALYSIS, and they are
    //    in ONE manifest with the `analyses:` block immediately after the `converters:`
    //    one. Every part of that is load-bearing:
    //      * two kinds, because the reader is a UNION and a fixture declaring only
    //        converters cannot tell "reads both" from "still reads the half it always did";
    //      * ADJACENT blocks, because a `  analyses:` line both closes the converters
    //        block and opens its own — an awk that `next`s on the dedent silently drops
    //        whichever block came second, and that bug passes a fixture whose blocks are
    //        in separate files;
    //      * two SITES, because `MIN_ENV_DECLS` floors the declaration count, and the
    //        deletion case below removes one of them.
    repo.write(
        "src-app/packages/pkg-env/manifest.yaml",
        concat!(
            "id: pkg-env\n",
            "contributes:\n",
            "  converters:\n",
            "    - id: conv-1\n",
            "      env: env-alpha\n",
            "  analyses:\n",
            "    - id: ana-1\n",
            "      env: env-beta\n",
        ),
    );

    // 3 packages x 7 datatypes = 21 declared terms (floors: 14 terms / 2 packages).
    for pkg in ["pkg-a", "pkg-b", "pkg-c"] {
        let mut m = String::from("id: ");
        m.push_str(pkg);
        m.push_str("\ncontributes:\n  datatypes:\n");
        for i in 1..=7 {
            m.push_str(&format!("    - id: fam-{pkg}/type{i}\n      title: T{i}\n"));
        }
        repo.write(&format!("src-app/packages/{pkg}/manifest.yaml"), &m);
    }

    // 130 app-core files (floor: 120).
    for i in 1..=130 {
        repo.write(
            &format!("src-app/server/src/modules/core/m{i}.rs"),
            &format!("pub fn f{i}() -> u32 {{ {i} }}\n"),
        );
    }

    // The FRAMEWORK surface (floors: 7 non-test modules across 2 reserved packages).
    // A reserved (`_`-prefixed) package is staged into every processor's `/code`, so it is
    // app-core in every sense except its path — and `packages/**` used to be excluded
    // wholesale, which is how a framework library came to default a producer's axis to a
    // domain name with the guard green. `pytest.ini` is what defines a test module here:
    // the guard reads `python_files` from it rather than hard-coding a pattern.
    //
    // TWO reserved packages, because the guard no longer takes the framework surface from
    // a hard-coded root LIST — it DERIVES it from `packages/_*/manifest.yaml`. A fixture
    // with one reserved package could not tell "derives every reserved package" from
    // "still only looks at the one that used to be listed", which is the exact
    // one-ring-behind defect the derivation closes (`_helpers` was unscanned for four
    // rounds because it was not in that list).
    for (pkg, modules) in [(RESERVED_A, 5), (RESERVED_B, 3)] {
        repo.write(
            &format!("src-app/packages/{pkg}/pytest.ini"),
            "[pytest]\npython_files = test_*.py\n",
        );
        repo.write(
            &format!("src-app/packages/{pkg}/manifest.yaml"),
            &format!("id: {pkg}\ncontributes: {{}}\n"),
        );
        for i in 1..=modules {
            repo.write(
                &format!("src-app/packages/{pkg}/fmt{i}.py"),
                &format!("def write{i}(x):\n    return x\n"),
            );
        }
        repo.write(
            &format!("src-app/packages/{pkg}/test_fmt.py"),
            "def test_ok():\n    assert True\n",
        );
    }

    // The server source that NAMES the reserved packages. The guard reads it to CHECK its
    // own derivation one ring in: a package the app reserves but the glob did not find is a
    // FAIL rather than a silently smaller surface. So the fixture has to carry it, the same
    // way it carries the manifests and the `pytest.ini` the guard also derives from.
    repo.write(
        "src-app/server/src/modules/sandbox/processors/mod.rs",
        &format!(
            "pub const RESERVED_A_PACKAGE: &str = \"{RESERVED_A}\";\n\
             pub const RESERVED_B_PACKAGE: &str = \"{RESERVED_B}\";\n"
        ),
    );
    repo
}

fn run_guard(repo: &TmpRepo) -> (bool, String) {
    let out = Command::new("bash")
        .arg(GUARD_REL)
        .current_dir(repo.root())
        .output()
        .expect("the derived-vocabulary guard must be runnable under bash");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

/// Declare `NOVEL_TERM` from a package that did not exist a moment ago. No guard edit.
fn declare_novel_term(repo: &TmpRepo) {
    repo.write(
        "src-app/packages/pkg-novel/manifest.yaml",
        &format!("id: pkg-novel\ncontributes:\n  datatypes:\n    - id: {NOVEL_TERM}\n      title: Widget\n"),
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  the control — a clean fixture passes, so every FAIL below means something
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn control_a_clean_fixture_passes() {
    let repo = fixture();
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "the fixture itself must be clean, or every negative result below is \
         indistinguishable from a broken fixture.\n{out}"
    );
    assert!(out.contains("PASS"), "expected a PASS line, got:\n{out}");
    // A guard that scanned nothing would also print no leaks. Pin the positive counts.
    assert!(
        out.contains("21 derived term(s) from 3 package(s)"),
        "the guard must report the vocabulary it DERIVED, so a short parse is visible:\n{out}"
    );
    // 130 generated modules PLUS the reserved-package source the guard reads to check its
    // own derivation — it lives under `src-app/server/src`, so it is app-core too.
    assert!(
        out.contains("scanned 131 app-core file(s)"),
        "the guard must report the surface it scanned:\n{out}"
    );
    // The framework surface is counted SEPARATELY, so a collapse in either one is visible
    // on its own rather than hidden inside a single total. 5 + 3 modules across the two
    // reserved packages; the `test_fmt.py` beside each is excluded per `python_files`.
    assert!(
        out.contains("8 framework file(s) across 2 derived reserved package(s)"),
        "the guard must report the framework surface it scanned AND how many reserved \
         packages it derived — 8 modules across 2 packages, NOT the pytest test module \
         beside each:\n{out}"
    );
    // #196: the ENV derivation is counted separately again, and BOTH numbers are pinned.
    // The distinct-id count alone cannot distinguish "read the union" from "read the
    // converters block twice"; the declaration-site count is what carries the deletion
    // floor. The fixture declares env-alpha (converter) + env-beta (analysis).
    assert!(
        out.contains("derived term(s) from 3 package(s)") && out.contains(" 2 env id(s)"),
        "the guard must report the UNION of both contribution kinds — 2 ids from a \
         converter and an analysis. Seeing 1 means one half of the union is unread:\n{out}"
    );
    assert!(
        out.contains("from 2 converter/analysis env declaration(s)"),
        "the guard must report the declaration-SITE count its deletion floor ranges \
         over:\n{out}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  TEST-6 — the N+1 case. This is the whole point of the item.
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn a_newly_declared_term_is_forbidden_without_editing_the_guard() {
    let repo = fixture();
    let before = fs::read(repo.root().join(GUARD_REL)).expect("guard readable");

    // 1. a NEW processor declares a term this guard has never seen.
    declare_novel_term(&repo);
    // 2. that term is planted in an app-core production file.
    repo.write(
        "src-app/server/src/modules/core/leak.rs",
        &format!("pub const KIND: &str = \"{NOVEL_TERM}\";\n"),
    );

    let (ok, out) = run_guard(&repo);

    assert!(
        !ok,
        "a term declared by a processor manifest MUST be forbidden in app-core on \
         arrival. This is the exact case `check-kinds-zero-core.sh` cannot catch: its \
         three ids are typed into the guard, so term N+1 is invisible to it.\n{out}"
    );
    // The failure must say WHAT leaked and WHERE — a guard whose message does not
    // locate the leak costs more time than it saves.
    assert!(
        out.contains(NOVEL_TERM),
        "the failure must name the leaked TERM:\n{out}"
    );
    assert!(
        out.contains("src-app/server/src/modules/core/leak.rs:1"),
        "the failure must name the FILE and LINE:\n{out}"
    );
    assert!(
        out.contains("pub const KIND"),
        "the failure must show the offending SOURCE LINE:\n{out}"
    );

    // 3. and the guard is byte-identical to the one committed in this repo.
    let after = fs::read(repo.root().join(GUARD_REL)).expect("guard readable");
    assert_eq!(
        before, after,
        "the guard must not have rewritten itself during the run"
    );
    assert_eq!(
        after,
        fs::read(guard_src()).expect("committed guard readable"),
        "the fixture ran the COMMITTED guard, unmodified — 'without editing the guard' \
         is the property, so it is asserted rather than assumed"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  negative controls — the guard must not fire on its own source of truth,
//  nor on test code. Without these, TEST-6 would pass for a `grep -r` that
//  simply cannot tell the difference.
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn the_same_term_in_a_test_path_does_not_fire() {
    let repo = fixture();
    declare_novel_term(&repo);
    repo.write(
        "src-app/server/src/modules/core/tests/fixture.rs",
        &format!("pub const KIND: &str = \"{NOVEL_TERM}\";\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "a `tests/` path is excluded BY CONSTRUCTION (a path segment, not a name \
         allow-list): a fixture must be able to spell the vocabulary.\n{out}"
    );
}

#[test]
fn the_same_term_inside_cfg_test_does_not_fire() {
    let repo = fixture();
    declare_novel_term(&repo);
    // In-source test module in a PRODUCTION file. This is the shape of the sibling
    // grep-guard `workstore/no_legacy_wire.rs`, which must SPELL the vocabulary it
    // searches for; if the stripper missed it, the guard would flag its own twin.
    repo.write(
        "src-app/server/src/modules/core/with_tests.rs",
        &format!(
            "pub fn production() -> u32 {{ 1 }}\n\
             #[cfg(test)]\n\
             mod tests {{\n    const KIND: &str = \"{NOVEL_TERM}\";\n}}\n"
        ),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "`#[cfg(test)]` items are blanked before matching — test code is not the \
         production surface.\n{out}"
    );

    // POSITIVE CONTROL for the stripper: the SAME file, same term, outside the
    // cfg(test) block, must fire. Otherwise "does not fire" could mean the stripper
    // blanked the entire file.
    repo.write(
        "src-app/server/src/modules/core/with_tests.rs",
        &format!(
            "pub const KIND: &str = \"{NOVEL_TERM}\";\n\
             #[cfg(test)]\n\
             mod tests {{\n    const OTHER: &str = \"x\";\n}}\n"
        ),
    );
    let (ok2, out2) = run_guard(&repo);
    assert!(
        !ok2,
        "the stripper must blank ONLY the test item — production code in the same \
         file is still scanned.\n{out2}"
    );
}

#[test]
fn the_term_in_the_data_manifest_alone_does_not_fire() {
    let repo = fixture();
    // The manifest DECLARES the term and nothing else mentions it. `src-app/packages`
    // is not a scanned root at all, so the guard structurally cannot flag the very file
    // it derives its vocabulary from.
    declare_novel_term(&repo);
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "the DATA manifest is the declaration, never a leak — it is excluded by \
         construction (not a SURFACE_ROOT).\n{out}"
    );
    assert!(
        out.contains("22 derived term(s) from 4 package(s)"),
        "the new package must still have WIDENED the forbidden vocabulary:\n{out}"
    );
}

#[test]
fn a_longer_distinct_token_does_not_fire() {
    let repo = fixture();
    declare_novel_term(&repo);
    // `metadata-column-family` (a registry CAPABILITY id) vs the datatype id
    // `metadata-column`, generalized. Token-boundary matching, both sides.
    repo.write(
        "src-app/server/src/modules/core/capability.rs",
        &format!("pub const CAP: &str = \"{NOVEL_TERM}-extended\";\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "a longer, distinct token is not the declared id — matching is \
         token-bounded on both sides.\n{out}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  the FRAMEWORK-LIBRARY surface — the blind spot that let a domain default
//  live in code staged into every processor, with this guard printing PASS
// ════════════════════════════════════════════════════════════════════════════
//
// `packages/**` was excluded WHOLESALE as "the DATA". `packages/_lib/` is not data:
// it is the framework output-format library the server stages into every processor's
// `/code`, so anything it names, it names for every producer that will ever exist.
// Measured cost of the gap: the framework column-writer defaulted a producer's `axis` to a
// domain axis name, and defaulted an array member's `name` plus its emitted `meta.kind` to
// a contributed datatype id — the guard was green throughout. (Named by description rather
// than spelled: the noun-scan ratchet holds this file to its committed prose tier, which is
// the same discipline the guard now imposes on the framework library itself.)
//
// The line is OWNERSHIP, not location, and all three sides are asserted below:
// framework code is scanned, a CONTRIBUTED package's own vocabulary still is not, and a
// pytest test module inside the framework tree is still excluded.

#[test]
fn a_domain_term_in_the_framework_library_fires() {
    let repo = fixture();
    declare_novel_term(&repo);
    repo.write(
        "src-app/packages/_lib/fmt1.py",
        &format!("DEFAULT = {{\"kind\": \"{NOVEL_TERM}\"}}\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "framework code staged into EVERY processor must not name a contributed domain \
         id (INV-5). This is the exact shape that shipped: a default in `_lib` authoring \
         the producer's declaration, invisible because `packages/**` was excluded \
         wholesale.\n{out}"
    );
    assert!(
        out.contains(NOVEL_TERM) && out.contains("src-app/packages/_lib/fmt1.py:1"),
        "the failure must name the term, the file and the line:\n{out}"
    );
}

#[test]
fn a_domain_term_in_a_framework_library_docstring_fires() {
    let repo = fixture();
    declare_novel_term(&repo);
    // Deliberate, and documented in the guard: a Python docstring is a STRING, not a
    // comment. A triple-quoted block can be parsed or emitted, so exempting it would be a
    // real fail-open. The cost is that framework prose must DESCRIBE a contributed id
    // rather than spell it — fail-CLOSED, which is the correct direction.
    repo.write(
        "src-app/packages/_lib/fmt2.py",
        &format!("def f():\n    \"\"\"prose naming a \"{NOVEL_TERM}\" id\"\"\"\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "a docstring is a string object, not a comment — exempting it would fail \
         open.\n{out}"
    );
}

#[test]
fn a_domain_term_in_a_framework_library_pytest_module_does_not_fire() {
    let repo = fixture();
    declare_novel_term(&repo);
    // Excluded per PYTEST'S OWN declaration of what a test module is (`python_files` in
    // the package's `pytest.ini`), not per a pattern typed into the guard. A fixture must
    // be able to spell the vocabulary — the same exemption `#[cfg(test)]` gets.
    repo.write(
        "src-app/packages/_lib/test_fmt.py",
        &format!("FIXTURE = {{\"kind\": \"{NOVEL_TERM}\"}}\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "a pytest test module in the framework tree is test code, and test code is not \
         the production surface.\n{out}"
    );

    // POSITIVE CONTROL: a NON-test module in the same directory, same term, must fire —
    // otherwise "does not fire" could mean the whole directory stopped being scanned.
    repo.write(
        "src-app/packages/_lib/fmt3.py",
        &format!("DEFAULT = \"{NOVEL_TERM}\"\n"),
    );
    let (ok2, out2) = run_guard(&repo);
    assert!(
        !ok2,
        "the exclusion must cover the TEST MODULE only, never the directory:\n{out2}"
    );
}

#[test]
fn a_domain_term_in_a_contributed_packages_own_code_does_not_fire() {
    let repo = fixture();
    declare_novel_term(&repo);
    // A contributed package's own domain vocabulary is exactly what the package is FOR.
    // Widening the framework-library surface must not have widened to `packages/**`.
    repo.write(
        "src-app/packages/pkg-novel/compute/run.py",
        &format!("DATATYPE = \"{NOVEL_TERM}\"\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "a CONTRIBUTED package declaring and using its own datatype id is legitimate — \
         the framework-library surface is scoped by OWNERSHIP, not by living under \
         `packages/`.\n{out}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  fail-CLOSED — a guard that scans nothing must not congratulate itself
//  (the ITEM-37 property, applied to the three scan sets this guard derives)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn a_collapsed_vocabulary_source_fails_instead_of_forbidding_less() {
    let repo = fixture();
    fs::remove_dir_all(repo.root().join("src-app/packages")).expect("drop the manifests");
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "with the manifests gone the forbidden set is EMPTY: the guard would forbid \
         nothing while printing PASS. It must fail instead.\n{out}"
    );
    assert!(
        out.contains("below the committed floor of"),
        "the failure must say the DERIVATION collapsed, not report a phantom leak:\n{out}"
    );
}

#[test]
fn a_collapsed_app_core_surface_fails_instead_of_scanning_nothing() {
    let repo = fixture();
    fs::remove_dir_all(repo.root().join("src-app/server")).expect("drop the app core");
    let (ok, out) = run_guard(&repo);
    assert!(!ok, "a scan set of ~0 files must not PASS.\n{out}");
    assert!(
        out.contains("below the floor of"),
        "the failure must say the SURFACE collapsed:\n{out}"
    );
}

#[test]
fn a_collapsed_framework_library_surface_fails_instead_of_scanning_nothing() {
    let repo = fixture();
    fs::remove_dir_all(repo.root().join(format!("src-app/packages/{RESERVED_A}")))
        .expect("drop a reserved package");
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "the framework library moving/renaming must FAIL, not silently return the guard \
         to the state in which a domain default lived there unnoticed.\n{out}"
    );
    assert!(
        out.contains("framework scan set resolved to 3 file(s)"),
        "the failure must say WHICH surface collapsed, and by how much:\n{out}"
    );
    // …and it must name the package the SERVER still reserves. This is the half a floor
    // alone cannot give: a floor says "fewer files than expected", the derivation
    // cross-check says WHICH package the app stages that this guard did not scan.
    assert!(
        out.contains(&format!(
            "names a RESERVED processor package `{RESERVED_A}`"
        )),
        "the derivation cross-check must name the package the server reserves but the \
         glob did not find:\n{out}"
    );
}

#[test]
fn a_reserved_package_the_server_names_but_the_glob_misses_is_a_failure() {
    let repo = fixture();
    // A THIRD reserved package appears in the server's own constants — the app stages/runs
    // it — but it ships no `manifest.yaml`, so the glob the surface is derived from cannot
    // see it. That is a surface one ring behind the tree, which is exactly the condition
    // that kept `_helpers` unscanned; it must FAIL rather than scan one package fewer.
    repo.write(
        "src-app/server/src/modules/sandbox/processors/mod.rs",
        &format!(
            "pub const RESERVED_A_PACKAGE: &str = \"{RESERVED_A}\";\n\
             pub const RESERVED_B_PACKAGE: &str = \"{RESERVED_B}\";\n\
             pub const RESERVED_C_PACKAGE: &str = \"_unmanifested\";\n"
        ),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "a reserved package the server names but the derived surface does not contain must \
         FAIL — otherwise the derivation silently covers less than the app ships.\n{out}"
    );
    assert!(
        out.contains("names a RESERVED processor package `_unmanifested`"),
        "the failure must name the package:\n{out}"
    );
}

#[test]
fn the_framework_surface_covers_every_reserved_package_not_just_the_first() {
    let repo = fixture();
    declare_novel_term(&repo);
    // The SECOND reserved package. Under the previous hard-coded single-root list this
    // planted leak was invisible — the guard printed PASS with a domain literal sitting in
    // framework code staged into every processor. This is the fourth-instance case, pinned.
    repo.write(
        &format!("src-app/packages/{RESERVED_B}/fmt1.py"),
        &format!("DEFAULT = \"{NOVEL_TERM}\"\n"),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "a contributed domain id in the SECOND reserved package must fire — a framework \
         surface that only covers the package somebody remembered to list is the \
         one-ring-behind defect this derivation exists to retire.\n{out}"
    );
    assert!(
        out.contains(NOVEL_TERM)
            && out.contains(&format!("src-app/packages/{RESERVED_B}/fmt1.py:1")),
        "the failure must name the term, the file and the line:\n{out}"
    );
}

#[test]
fn a_pytest_glob_that_swallows_the_modules_fails_instead_of_excluding_everything() {
    let repo = fixture();
    // The test-module exclusion is DERIVED from `python_files`, so widening that glob is
    // the cheapest way past the new surface: `*.py` excludes every module as "a test".
    // The floor is what makes that a FAIL rather than a silent, total exemption.
    repo.write(
        "src-app/packages/_lib/pytest.ini",
        "[pytest]\npython_files = *.py\n",
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "a `python_files` glob wide enough to classify the framework modules themselves \
         as tests must trip the floor — otherwise the exclusion is a one-line opt-out \
         from the whole surface.\n{out}"
    );
    assert!(out.contains("framework scan set resolved to"), "{out}");
}

// ════════════════════════════════════════════════════════════════════════════
//  #196 / E8 — the ENV tier. Same N+1 property, on the slice next door.
//
//  The env vocabulary is derived from a DIFFERENT slice than the datatype one
//  (`contributes.{converters,analyses}[].env`, not `contributes.datatypes[].id`) and is
//  scanned against a DIFFERENT surface (the BUILD tier — `justfile` + non-guard
//  `scripts/*.sh` — not app-core). So every case above could pass with the env reader
//  completely broken; these are what cover it.
// ════════════════════════════════════════════════════════════════════════════

/// The env-id under test is declared ONLY by an ANALYSIS, in a package that did not exist
/// a moment ago. Before #196 both shell readers matched the `converters:` block alone, so
/// this id was absent from the forbidden vocabulary and could be typed into a recipe with
/// no guard — while the guard printed PASS and named the app function it claimed to mirror.
const NOVEL_ANALYSIS_ENV: &str = "novelenv-analysis";

fn declare_novel_analysis_env(repo: &TmpRepo) {
    repo.write(
        "src-app/packages/pkg-novel-env/manifest.yaml",
        &format!(
            "id: pkg-novel-env\ncontributes:\n  analyses:\n    - id: ana-novel\n      \
             env: {NOVEL_ANALYSIS_ENV}\n"
        ),
    );
}

/// **TEST-1 [acceptance] [invariant: INV-1]** — an env declared by an ANALYSIS is
/// forbidden in the BUILD surface the moment it is declared, with the guard byte-identical.
#[test]
fn an_analysis_declared_env_is_forbidden_without_editing_the_guard() {
    let repo = fixture();
    let before = fs::read(repo.root().join(GUARD_REL)).expect("guard readable");

    declare_novel_analysis_env(&repo);
    repo.write(
        "scripts/build-leak.sh",
        &format!("#!/usr/bin/env bash\nENV_ID=\"{NOVEL_ANALYSIS_ENV}\"\necho \"$ENV_ID\"\n"),
    );

    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "an env-id declared by an ANALYSIS must be forbidden in the build surface. It was \
         not — the reader is still scoped to the converters block.\n{out}"
    );
    assert!(
        out.contains("scripts/build-leak.sh") && out.contains(NOVEL_ANALYSIS_ENV),
        "the failure must name the file and the leaked env-id:\n{out}"
    );

    let after = fs::read(repo.root().join(GUARD_REL)).expect("guard readable");
    assert_eq!(
        before, after,
        "the guard must not have been edited — deriving is the whole claim"
    );
}

/// **TEST-2** — the CONVERTER half still fires. A union that lost its first half would
/// pass TEST-1 alone; this is what distinguishes "widened the reader" from "re-pointed it".
#[test]
fn a_converter_declared_env_still_fires_after_the_union_change() {
    let repo = fixture();
    // `env-alpha` is the fixture's CONVERTER-declared env (its analysis-declared sibling
    // is `env-beta`). The literal below is DUPLICATED from the fixture, so assert the two
    // agree rather than merely saying they do — a comment claiming a derivation the code
    // does not perform is the exact defect this branch exists to retire, and one was
    // written right here.
    let manifest = fs::read_to_string(repo.root().join("src-app/packages/pkg-env/manifest.yaml"))
        .expect("fixture manifest readable");
    assert!(
        manifest.contains("env: env-alpha"),
        "the fixture no longer declares the converter env this case plants; re-derive it"
    );
    repo.write(
        "scripts/build-leak.sh",
        "#!/usr/bin/env bash\necho \"env-alpha\"\n",
    );
    let (ok, out) = run_guard(&repo);
    assert!(!ok, "the converter-declared env must still be forbidden:\n{out}");
    assert!(out.contains("env-alpha"), "{out}");
}

/// **TEST-5 [acceptance] [invariant: INV-3]** — ANTI-VACUITY. A collapsed env parse must
/// FAIL with a diagnosis, not report a clean, empty env vocabulary.
///
/// The mutation is the realistic one: the manifests are all still there and the datatype
/// tier still parses perfectly — only the `env:` slice becomes unreadable, as it would if
/// the manifest shape moved or a block matcher were mis-set. Everything else about the
/// guard stays green, which is exactly what makes this failure mode silent without a floor.
#[test]
fn a_collapsed_env_parse_fails_instead_of_forbidding_an_empty_env_vocabulary() {
    let repo = fixture();
    // Re-indent the env declarations out of the reader's reach: still valid-looking YAML
    // prose, no env id derivable.
    repo.write(
        "src-app/packages/pkg-env/manifest.yaml",
        "id: pkg-env\ncontributes:\n  converters:\n    - id: conv-1\n  analyses:\n    - id: ana-1\n",
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "with zero env-ids derived the build surface forbids NO env vocabulary; the guard \
         would print PASS having checked nothing.\n{out}"
    );
    assert!(
        out.contains("distinct declared env-id(s)") || out.contains("env DECLARATION site(s)"),
        "the failure must say the ENV derivation collapsed, and which floor caught it:\n{out}"
    );
    assert!(
        out.contains("BOTH block matchers") || out.contains("declared_envs_in"),
        "the diagnosis must name the UNION slice, so the next reader is sent to the right \
         reader rather than to the converters-only one:\n{out}"
    );
}

/// **TEST-6 [acceptance] [invariant: INV-6]** — THE DELETION DIRECTION.
///
/// This is the case `docs/design/derived-guards.md` §4 was written for, and the one a
/// derivation cannot see on its own: the reader re-reads the very manifests that DEFINE
/// the vocabulary, so removing a declaration shrinks the forbidden set and the thing it
/// is checked against together, in silence.
///
/// ── WHY THIS TEST CHANGED SHAPE (#196 R7) ─────────────────────────────────────
/// It used to assert that deleting ONE of two declarations of the same env failed, which
/// is what a floor on the repo-wide TOTAL number of declaration sites did. A blind audit
/// then showed that floor defended no PARTICULAR declaration: the total is global, so
/// declarations added by an UNRELATED package create permanent slack and BOTH shipped
/// declarations could be deleted at exit 0.
///
/// The anchor is now a derived cross-check against a SECOND, INDEPENDENT source — the
/// recipe tree. So the asserted property is stronger and differently shaped:
///   * deleting the LAST declaration of an env whose recipe SHIPS is caught, and
///   * it CANNOT be masked by unrelated declarations elsewhere.
/// Deleting one of several redundant declarations of the same env is deliberately NOT an
/// error: the env is still declared, still fetchable, still publishable.
#[test]
fn deleting_the_last_declaration_of_a_shipped_recipe_fails_and_slack_cannot_mask_it() {
    let repo = fixture();
    // The recipe SHIPS — this is the independent source that does not move when a
    // manifest line is deleted.
    repo.write("src-app/env-rootfs/env-alpha/Dockerfile", "FROM scratch\n");

    // Sanity: with the declaration present the pair agrees and the guard is green.
    let (ok, out) = run_guard(&repo);
    assert!(ok, "a shipped recipe that IS declared must pass:\n{out}");

    // The mutation: remove EVERY declaration of `env-alpha`, and simultaneously add two
    // unrelated ones. Total declaration sites is UNCHANGED, which is exactly the shape
    // the old global floor accepted at exit 0.
    repo.write(
        "src-app/packages/pkg-env/manifest.yaml",
        concat!(
            "id: pkg-env\n",
            "contributes:\n",
            "  converters:\n",
            "    - id: conv-1\n",
            "      env: unrelated-one\n",
            "  analyses:\n",
            "    - id: ana-1\n",
            "      env: unrelated-two\n",
        ),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "the LAST declaration of a SHIPPED recipe was removed and the guard passed. The \
         derived set moved with the manifests, so only a cross-check against the recipe \
         tree — a source that does NOT move — can see this (derived-guards.md §4).\n{out}"
    );
    assert!(
        out.contains("env-alpha"),
        "the failure must NAME the recipe nothing declares, or the reader cannot act:\n{out}"
    );
    assert!(
        out.contains("no processor manifest declares"),
        "the diagnosis must say what is wrong — a shipped image nothing can ask for:\n{out}"
    );
    // And the slack must genuinely not have masked it: the unrelated declarations ARE
    // present and counted, so a total-based floor would have been satisfied.
    assert!(
        out.contains("unrelated-one") || out.contains("2 converter/analysis env declaration"),
        "the unrelated declarations must be visible in the report, proving the failure is \
         NOT merely a count falling below a floor:\n{out}"
    );
}

/// **TEST-9 [acceptance] [invariant: INV-5]** — the env tier stays SEPARATE from `$TERMS`.
///
/// An env-id is a bare-looking compound that is also a PREFIX of the datatype ids
/// (the env id is a strict PREFIX of the datatype ids), and the compound matcher treats `/` as a
/// boundary. Merging the env vocabulary into the app-core/framework scan would therefore
/// newly flag prose in framework docstrings — 3 measured hits in `_lib/txr_columns.py`,
/// which describe the very defect they exist to warn about. The guard records that as a
/// deliberate divergence; this pins it, in both directions at once.
#[test]
fn an_env_id_is_forbidden_on_the_build_surface_but_not_in_framework_prose() {
    let repo = fixture();
    // The same literal, in the two places. Framework prose: must NOT fire.
    repo.write(
        &format!("src-app/packages/{RESERVED_A}/fmt_prose.py"),
        "def note():\n    \"\"\"Runs in the env-alpha image; see the runbook.\"\"\"\n    return 1\n",
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        ok,
        "an env-id in FRAMEWORK prose must not fire — the env tier is scoped to the BUILD \
         surface, and widening it would flag the docstrings that warn about this very \
         defect.\n{out}"
    );
    // …and the file was actually SCANNED. Without this the "does not fire" half passes
    // vacuously the day that path stops entering the framework surface: 8 modules in the
    // control fixture, 9 with this one added.
    assert!(
        out.contains("9 framework file(s)"),
        "the prose file must have ENTERED the framework scan set, or 'it did not fire' \
         says nothing:\n{out}"
    );

    // …and the SAME literal on the build surface must fire, so the case above is a scoping
    // rule and not a broken reader.
    repo.write(
        "scripts/build-leak.sh",
        "#!/usr/bin/env bash\necho \"env-alpha\"\n",
    );
    let (ok2, out2) = run_guard(&repo);
    assert!(
        !ok2,
        "the same env-id on the BUILD surface must fire; otherwise the case above proves \
         nothing about scoping.\n{out2}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  #196 — INV-2 and INV-4, asserted against the REAL tree
// ════════════════════════════════════════════════════════════════════════════

/// The file whose CREATION identifies this branch — the add-only marker of §3.
///
/// Add-only, never "touched": `test_zero_src_app_diff.py`'s own
/// `_is_dependency_contract_branch` docstring reasons this out for the #80 exemption, and
/// the reasoning is the same one level up — keying on a MODIFICATION would let routine
/// maintenance silently re-arm a check that exists for exactly one branch.
const THIS_BRANCHES_OWN_SUBJECT: &str = "src-app/server/tests/sandbox/env_script_derivation_test.rs";

/// **TEST-7 [acceptance] [invariant: INV-2]** — this branch does not duplicate
/// `fix/zero-core-derived`.
///
/// Two branches repairing overlapping derivation defects is exactly how a duplicate lands,
/// and a duplicate is worse than either fix alone: the merge of two independent edits to
/// one guard is the "clean textual merge that loses a change" failure.
///
/// ── WHY THIS IS SELF-LIMITING, AND WHY THAT IS NOT OPTIONAL HERE ────────────────
/// This asserts a property of a **change**, not of the code: *"the branch that fixed the
/// env slice touched nothing the zero-core branch owns."* `derived-guards.md` §3 is
/// explicit that such a proof is meaningful ONLY on the branch whose diff it describes —
/// asserted unconditionally it re-executes forever and demands that every LATER branch's
/// diff also avoid files it has nothing to do with. The escapes then available are the two
/// §5 forbids: edit another item's acceptance test, or widen an allowlist.
///
/// The first cut of this test WAS unconditional, and it would have gone falsely red on:
/// the branch that retires `check-kinds-zero-core.sh` (§7 records that as open), and every
/// branch adding a package — since a new package brings a new `test_zero_src_app_diff.py`
/// that `git ls-files` picks up and `git diff origin/main` then reports as changed. Writing
/// §1's failure class into the branch whose subject IS that failure class is the kind of
/// thing a guard's own design doc exists to prevent.
///
/// So it detects, add-only from the diff, whether this is the branch that introduces its
/// own subject, and elsewhere it SKIPS VISIBLY (`record_skip`) with a stated reason —
/// never a silent pass, which §3 calls the vacuous-green failure in a different costume.
#[test]
fn this_branch_does_not_touch_the_files_the_zero_core_branch_owns() {
    // ADD-ONLY detection: is this the branch that CREATED this item's own test file?
    let added = Command::new("git")
        .args([
            "diff",
            "--name-only",
            "--diff-filter=A",
            "origin/main...HEAD",
            "--",
            THIS_BRANCHES_OWN_SUBJECT,
        ])
        .current_dir(repo_root())
        .output();
    let is_this_branch = added
        .as_ref()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);

    if !is_this_branch {
        crate::dataset::hardening_common::record_skip(
            "this_branch_does_not_touch_the_files_the_zero_core_branch_owns",
            "this is not the branch that introduces the derived-env-vocabulary work \
             (its own test file is not ADDED in this diff), so its no-duplicate-work \
             claim describes a change that is not in front of us — derived-guards.md §3",
        );
        return;
    }

    // Only from here on is the premise true, and here it must fail LOUDLY (§6 INV-4:
    // "a self-limiting guard still fails loudly on the branch where its premise does hold").
    //
    // The two paths are LITERAL because they are the OTHER branch's subject — there is no
    // declaration in this tree from which "what fix/zero-core-derived owns" can be derived;
    // `derived-guards.md` §7 is that declaration and it is prose. A literal list is
    // acceptable precisely because this test is scoped to one branch: it can never fall
    // behind a tree it does not outlive.
    let owned = [
        "scripts/check-kinds-zero-core.sh",
        "src-app/server/src/modules/datatype/tests/lattice_golden.json",
    ];
    // The `test_zero_src_app_diff.py` copies ARE derived — there are three today and the
    // count is not this branch's business to know.
    let listed = Command::new("git")
        .args(["ls-files", "src-app/packages/*/tests/test_zero_src_app_diff.py"])
        .current_dir(repo_root())
        .output()
        .expect("git ls-files");
    let copies: Vec<String> = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    assert!(
        !copies.is_empty(),
        "no test_zero_src_app_diff.py copy found — this check would range over nothing"
    );

    for path in owned.iter().map(|s| s.to_string()).chain(copies) {
        let out = Command::new("git")
            .args(["diff", "--exit-code", "origin/main...HEAD", "--", &path])
            .current_dir(repo_root())
            .output()
            .expect("git diff");
        assert!(
            out.status.success(),
            "`{path}` is owned by fix/zero-core-derived (docs/design/derived-guards.md §7) \
             and must be untouched by this branch. Diff:\n{}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}

/// **TEST-8 [acceptance] [invariant: INV-4]** — every guard is pinned and every pin
/// matches, in the SAME commit as the guard edit.
///
/// `check-guard-integrity.sh` check 1 fails on an edited-but-unre-pinned guard and check 2
/// on an unpinned one. Running it from a test is what makes the re-pin part of this
/// branch's own evidence rather than a chore someone remembers — commit `5d73351e` is the
/// in-repo precedent for forgetting it.
#[test]
fn every_guard_is_pinned_and_matches_its_pin() {
    let out = Command::new("bash")
        .arg("scripts/check-guard-integrity.sh")
        .current_dir(repo_root())
        .output()
        .expect("guard-integrity runnable");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success(),
        "a guard was edited without re-pinning scripts/guard-hashes.txt in the same \
         commit:\n{text}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  the real tree — last, because on its own it proves nothing (see the header)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn the_real_app_core_surface_is_clean() {
    let out = Command::new("bash")
        .arg("scripts/check-derived-vocabulary.sh")
        .current_dir(repo_root())
        .output()
        .expect("guard runnable");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success(),
        "contributed domain vocabulary leaked into app-core (INV-5):\n{text}"
    );
}

// A compile-time nudge: if the guard is ever renamed, this test file stops finding it
// and every case above turns into a spawn error rather than a silent skip.
#[test]
fn the_guard_exists_where_this_test_expects_it() {
    let p: &Path = &guard_src();
    assert!(p.is_file(), "missing guard: {}", p.display());
}

/// **TEST-17** [ITEM-13] — the recipe cross-check discovers what the PUBLISHER discovers.
///
/// The set "which env recipes ship" has three readers: this guard, `publish-env-rootfs.sh`
/// (`find -mindepth 2 -maxdepth 2 -name Dockerfile`) and Rust's `discover_env_recipes`
/// (`read_dir`). Neither sibling is glob-filtered, so both see a DOT-directory; a `*/`
/// glob does not. That disagreement was a fail-open in the very check added to close one:
/// a dot-recipe would be built and pushed, and walked by the Rust guards, while this
/// cross-check quietly did not require it to be declared.
///
/// A set with more than one reader, and readers that disagree, is this whole item's
/// subject matter — so it is pinned rather than left to a comment.
#[test]
fn a_dot_directory_recipe_is_discovered_exactly_as_the_publisher_discovers_it() {
    let repo = fixture();
    // A recipe the publisher's `find` WOULD return and a `*/` glob would not.
    repo.write("src-app/env-rootfs/.hidden-recipe/Dockerfile", "FROM scratch\n");

    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "a dot-directory recipe SHIPS (the publisher's find returns it) but nothing \
         declares it, and the guard passed — the cross-check is not reading the same set \
         its siblings read.\n{out}"
    );
    assert!(
        out.contains(".hidden-recipe"),
        "the failure must NAME the undeclared recipe, or the reader cannot act:\n{out}"
    );

    // Declaring it makes the pair agree again — the check is a cross-check, not a ban on
    // dot-directories.
    repo.write(
        "src-app/packages/pkg-env/manifest.yaml",
        concat!(
            "id: pkg-env\n",
            "contributes:\n",
            "  converters:\n",
            "    - id: conv-1\n",
            "      env: .hidden-recipe\n",
        ),
    );
    let (_ok2, out2) = run_guard(&repo);
    assert!(
        !out2.contains("no processor manifest declares"),
        "once declared, the recipe must stop being reported as undeclared:\n{out2}"
    );
}

/// **TEST-18** [ITEM-12] — a malformed derived env id makes the guard EXIT NON-ZERO.
///
/// This exists because the first version did not. The validation printed its FAIL text and
/// then a later `fail=0` clobbered the flag, so the guard reported the failure and exited
/// **0** — self-contradicting output, and CI keys on the exit code. A blind verifier found
/// it and observed that nothing covered it: the grammar parity test exercises the shell
/// FUNCTION in isolation, which cannot see a wiring bug in the guard that calls it.
///
/// So this asserts the EXIT STATUS, not the message. A test that only grepped the output
/// would have passed against the broken version.
#[test]
fn a_malformed_derived_env_id_fails_the_guard_not_just_its_output() {
    let repo = fixture();
    // A folded scalar — a legal YAML shape the indentation-exact reader mis-parses into
    // the id `>-`. Exactly what LEDGER round 4 recorded as deriving garbage in silence.
    repo.write(
        "src-app/packages/pkg-env/manifest.yaml",
        concat!(
            "id: pkg-env\n",
            "contributes:\n",
            "  converters:\n",
            "    - id: conv-1\n",
            "      env: >-\n",
            "        env-alpha\n",
        ),
    );
    let (ok, out) = run_guard(&repo);
    assert!(
        !ok,
        "a malformed derived env id must make the guard EXIT NON-ZERO. Printing FAIL and \
         exiting 0 is worse than not checking: CI reads the exit code.\n{out}"
    );
    assert!(
        out.contains("malformed env id"),
        "the failure must name what it rejected:\n{out}"
    );
    assert!(
        !out.contains("PASS: 0 contributed domain-vocabulary leaks"),
        "the guard must not ALSO print its PASS banner — a self-contradicting report is \
         how the clobbered-flag bug hid:\n{out}"
    );
}

/// **TEST-19** [ITEM-12] — a recipe may DECLARE that it is operator-selected, and prose
/// mentioning that marker must not do it accidentally.
///
/// `processor_manifest.rs` documents that a contribution declaring no env resolves against
/// EVERY recipe and the deployment picks one via `TXR_SANDBOX_ENV_ID`. So a recipe that no
/// manifest names is a SUPPORTED configuration, and failing it would be this guard failing
/// correct input — the way a guard gets switched off. The escape hatch is declared in the
/// recipe itself, which keeps the anti-deletion property: removing the last declaration
/// still fails unless the same commit also adds the marker.
#[test]
fn a_recipe_may_declare_itself_operator_selected_but_prose_must_not_do_it() {
    let repo = fixture();

    // Unmarked and undeclared -> the anchor fires.
    repo.write("src-app/env-rootfs/env-lite/Dockerfile", "FROM scratch\n");
    let (ok, out) = run_guard(&repo);
    assert!(!ok, "an undeclared, unmarked recipe must fail:\n{out}");
    assert!(out.contains("env-lite"), "{out}");

    // Marked -> the documented operator-selected configuration passes.
    repo.write(
        "src-app/env-rootfs/env-lite/Dockerfile",
        "FROM scratch\n# txr:env-operator-selected\n",
    );
    let (ok2, out2) = run_guard(&repo);
    assert!(
        ok2,
        "a recipe that declares itself operator-selected is a SUPPORTED configuration and \
         the guard must EXIT 0. Asserting only on message absence would be the same \
         exit-status-vs-output confusion this round was hunting, moved into the test.\n{out2}"
    );
    assert!(
        !out2.contains("no processor manifest declares"),
        "...and it must not be reported as undeclared:\n{out2}"
    );

    // Prose mentioning the marker must NOT mark it — the same discipline `is_smoke_marker`
    // learned the hard way, applied to this marker from the start.
    repo.write(
        "src-app/env-rootfs/env-lite/Dockerfile",
        "FROM scratch\n# see the txr:env-operator-selected marker docs\n",
    );
    let (ok3, out3) = run_guard(&repo);
    assert!(
        !ok3,
        "prose MENTIONING the marker must not mark the recipe — that is the \
         prose-satisfiability this whole item exists to retire:\n{out3}"
    );
    assert!(out3.contains("env-lite"), "{out3}");
}

/// **TEST-21** [ITEM-14] — the operator-selected marker must not SHRINK the vocabulary.
///
/// The marker exempts a recipe from the declaration anchor. Its first version did that by
/// `continue`-ing, which also dropped the env id out of `$ENVS` — derived from manifests
/// alone — so the forbidden set shrank while the recipe still shipped and its id stayed
/// live and operator-selectable. A two-line diff (delete one `env:` line, add the marker)
/// turned a hard INV-5 leak failure into a PASS, with nothing observing it. That is the
/// "vocabulary shrinks in silence" direction `docs/design/derived-guards.md` §4 exists to
/// close, reopened through the escape hatch added to close its sibling.
///
/// ── THE ISOLATION THIS TEST NEEDS, AND WHY ─────────────────────────────────────
/// `fixture()`'s own `pkg-env` manifest declares BOTH `env-alpha` and `env-beta`. The
/// first version of this test relied on that, so `env-beta` was in the vocabulary from the
/// fixture no matter what the marker did — and the test PASSED with the fix reverted. It
/// was vacuous, and it is exactly the "coverage on paper" failure this branch keeps
/// finding in other people's guards.
///
/// So both cases REWRITE `pkg-env` to declare `env-alpha` only. Then the sole route by
/// which `env-beta` can enter the forbidden set in case B is the marker's contribution,
/// and reverting that one line turns this test red.
#[test]
fn an_operator_selected_recipe_still_contributes_its_id_to_the_forbidden_vocabulary() {
    let leak = "scripts/zz-build-leak.sh";
    let literal = "#!/usr/bin/env bash\nENV_ID=\"${ENV_ID:-env-beta}\"\n";
    // Declares env-alpha ONLY — so `MIN_ENVS` stays satisfied while `env-beta` is left to
    // be supplied (or not) by the thing each case is actually testing.
    const ONLY_ALPHA: &str = concat!(
        "id: pkg-env\n",
        "contributes:\n",
        "  converters:\n",
        "    - id: conv-1\n",
        "      env: env-alpha\n",
    );

    // A — `env-beta` declared by a MANIFEST, recipe unmarked. The literal leaks.
    let repo_a = fixture();
    repo_a.write("src-app/packages/pkg-env/manifest.yaml", ONLY_ALPHA);
    repo_a.write("src-app/env-rootfs/env-beta/Dockerfile", "FROM scratch\n");
    repo_a.write(
        "src-app/packages/pkg-beta/manifest.yaml",
        concat!(
            "id: pkg-beta\n",
            "contributes:\n",
            "  analyses:\n",
            "    - id: ana-beta\n",
            "      env: env-beta\n",
        ),
    );
    repo_a.write(leak, literal);
    let (ok_a, out_a) = run_guard(&repo_a);
    assert!(!ok_a, "the manifest-declared case must catch the leak:\n{out_a}");
    assert!(
        out_a.contains("zz-build-leak.sh"),
        "and must name the leaking build file:\n{out_a}"
    );

    // B — `env-beta` declared by the RECIPE instead (the marker). NOTHING else declares
    // it, so the vocabulary can only learn it from the marker's contribution.
    let repo_b = fixture();
    repo_b.write("src-app/packages/pkg-env/manifest.yaml", ONLY_ALPHA);
    repo_b.write(
        "src-app/env-rootfs/env-beta/Dockerfile",
        "FROM scratch\n# txr:env-operator-selected\n",
    );
    repo_b.write(leak, literal);
    let (ok_b, out_b) = run_guard(&repo_b);
    assert!(
        !ok_b,
        "an OPERATOR-SELECTED env is still a contributed env id, and the build surface \
         must not be allowed to spell it. The marker declares the env from the recipe tree \
         instead of from a manifest — it is not permission to drop the id from the \
         forbidden vocabulary (derived-guards.md §4, the shrink direction).\n{out_b}"
    );
    assert!(
        out_b.contains("zz-build-leak.sh"),
        "the failure must name the leaking build file in the marked case too — if it fails \
         for any OTHER reason this test is not observing the shrink:\n{out_b}"
    );

    // C — marked, and NO leak. Must PASS: the marker is a declaration channel, not a ban.
    let repo_c = fixture();
    repo_c.write("src-app/packages/pkg-env/manifest.yaml", ONLY_ALPHA);
    repo_c.write(
        "src-app/env-rootfs/env-beta/Dockerfile",
        "FROM scratch\n# txr:env-operator-selected\n",
    );
    let (ok_c, out_c) = run_guard(&repo_c);
    assert!(ok_c, "a marked recipe with no leak must PASS:\n{out_c}");
}

/// **TEST-22** [ITEM-1, ITEM-14] — with TWO recipes, the derived env count is TWO.
///
/// E3 measured the defect on main as a number: *"2 recipes on disk, `n_envs = 1`."* The
/// guard scraped `contributes.converters[].env` ONLY, so a second env declared on an
/// ANALYSIS was a live, operator-selectable id the forbidden-vocabulary guard did not know
/// existed — and `MIN_ENVS=1` could not notice, because a floor cannot see a count that
/// never rises. **A missed ADDITION is invisible to a minimum by construction**, which is
/// the mirror of the §4 deletion blind spot.
///
/// Asserting the COUNT is what makes this unable to pass vacuously: a test that only
/// checked "some failure happened" would pass against a guard that had never seen the
/// second env at all. Note the app-side union (`default_env_id`) was fixed separately by
/// E1 — the guard is a different reader, and this is the guard's.
#[test]
fn two_recipes_with_an_analysis_declared_env_derive_two_env_ids_not_one() {
    let repo = fixture();
    // Exactly one CONVERTER-declared env, so a converters-only scraper measures 1.
    repo.write(
        "src-app/packages/pkg-env/manifest.yaml",
        concat!(
            "id: pkg-env\n",
            "contributes:\n",
            "  converters:\n",
            "    - id: conv-1\n",
            "      env: env-alpha\n",
        ),
    );
    repo.write("src-app/env-rootfs/env-alpha/Dockerfile", "FROM scratch\n");
    // The second recipe, declared ONLY by an analysis — the shape a converters-only
    // reader cannot see, and the shape E3's R env has by construction (no converter
    // declares it, and none can at this point in the DAG).
    repo.write("src-app/env-rootfs/env-beta/Dockerfile", "FROM scratch\n");
    repo.write(
        "src-app/packages/pkg-beta/manifest.yaml",
        concat!(
            "id: pkg-beta\n",
            "contributes:\n",
            "  analyses:\n",
            "    - id: ana-beta\n",
            "      env: env-beta\n",
        ),
    );

    let (ok, out) = run_guard(&repo);
    assert!(ok, "two declared recipes, both accounted for, must PASS:\n{out}");
    assert!(
        out.contains("2 env id(s)"),
        "the derivation must report TWO env ids. A converters-only scraper reports ONE \
         here, which is exactly the measurement E3 took against main — and no floor can \
         catch it, because a MISSED ADDITION is invisible to a minimum.\n{out}"
    );

    // The deletion direction, on the analysis-declared one: remove the declaration and the
    // recipe is orphaned. Must go red NAMING which one vanished.
    repo.write(
        "src-app/packages/pkg-beta/manifest.yaml",
        concat!("id: pkg-beta\n", "contributes:\n", "  analyses:\n", "    - id: ana-beta\n"),
    );
    let (ok2, out2) = run_guard(&repo);
    assert!(!ok2, "deleting the analysis declaration must be caught:\n{out2}");
    assert!(
        out2.contains("env-beta"),
        "the failure must NAME the recipe whose declaration vanished:\n{out2}"
    );
    assert!(
        !out2.contains("env-alpha\n"),
        "and must not implicate the recipe that is still declared:\n{out2}"
    );
}
