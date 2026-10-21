//! TEST-16 [acceptance] [invariant: INV-4] [covers: ITEM-17, ITEM-18, ITEM-19] — the
//! MANUAL env-image publish path is real, and cannot drift from the CI workflow it stands
//! in for (#80).
//!
//! ## The invariant, and why a test rather than a paragraph
//!
//! #80 asks to "re-enable `env-images.yml`, **or** document the manual republish path so
//! an analysis that needs a new library is schedulable." Re-enabling is not available:
//! commit `3f6452b8` disabled every workflow in the repository because the organization's
//! Actions billing is off, so a live workflow accrues failed and queued runs and publishes
//! nothing. The second arm was taken — a runbook plus an executable script.
//!
//! A written-down procedure decays silently. What keeps this one honest is that the
//! workflow it mirrors is still in the tree, `.disabled` but intact (that was the point of
//! renaming rather than deleting), so the two can be compared. These assertions read BOTH
//! and require the script to encode the same publish sequence: the same registry
//! repository shape, the same artifact media type, BOTH tags — the immutable
//! `schema<N>-<sha>-<arch>` provenance tag and the moving `schema<N>-latest-<arch>` tag the
//! runtime actually resolves — and the signing step.
//!
//! The moving tag is the one that matters most and is the easiest to leave out of a manual
//! procedure: everything before it publishes bytes that nothing resolves. A manual path
//! that pushed the immutable tag and forgot to re-point the moving one would look
//! successful and change nothing, which is precisely the class of failure #80 is about.
//!
//! No server, no database: these are file-parity assertions over the repository.

use std::path::{Path, PathBuf};

/// The repository root, from this crate's manifest dir (`src-app/server`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root resolves")
}

fn read(rel: &str) -> String {
    let p = repo_root().join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()))
}

const WORKFLOW: &str = ".github/workflows/env-images.yml.disabled";
const SCRIPT: &str = "scripts/publish-env-rootfs.sh";
const RUNBOOK: &str = "docs/runbooks/env-image-republish.md";
/// E5 / #193 — the LOCAL build + stage loop. It is a third derive-from-the-tree
/// consumer of the env set, and it is held to the same no-literal rule as the two
/// publishers below.
const LOCAL_LOOP: &str = "scripts/build-env-rootfs-local.sh";

#[test]
fn the_publish_workflow_is_parked_not_deleted() {
    // The rename is what makes every other assertion in this file possible, and what makes
    // re-enabling a one-line change once billing returns. A DELETED workflow would have to
    // be rebuilt from the runbook, which is the wrong direction of trust.
    assert!(
        repo_root().join(WORKFLOW).is_file(),
        "the publish workflow must remain in the tree, disabled — it is the reference the \
         manual path is checked against, and re-enabling must stay a pure rename"
    );
    assert!(
        !repo_root().join(".github/workflows/env-images.yml").exists(),
        "the workflow is expected to be DISABLED; if it has been re-enabled, this file's \
         premise has changed and the runbook should be re-scoped to break-glass"
    );
}

#[test]
fn the_manual_publish_script_exists_and_is_runnable_posix_shell() {
    let script = read(SCRIPT);
    assert!(
        script.starts_with("#!/usr/bin/env sh"),
        "POSIX sh, matching the other scripts in this directory"
    );
    // A procedure you cannot rehearse is a procedure nobody runs correctly the first time,
    // and the first time is a production publish.
    assert!(
        script.contains("--dry-run"),
        "the script must support a dry run — the first real execution of a publish should \
         not be the first execution of the script"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(repo_root().join(SCRIPT))
            .expect("stat the script")
            .permissions()
            .mode();
        assert!(mode & 0o111 != 0, "the script must be executable");
    }
}

#[test]
fn the_manual_path_encodes_the_same_publish_sequence_as_the_workflow() {
    let workflow = read(WORKFLOW);
    let script = read(SCRIPT);

    // Each of these is read out of the WORKFLOW first, so the assertion is "the script
    // agrees with the workflow", not "the script contains a string someone typed here".
    for token in [
        // the OCI artifact media type a published rootfs carries
        "application/vnd.cyto.env-rootfs.squashfs.v1",
        // the per-env GHCR repository shape
        "cyto-env",
        // the publish + retag + sign verbs
        "oras push",
        "oras tag",
        "cosign sign",
    ] {
        assert!(
            workflow.contains(token),
            "the workflow no longer contains `{token}` — this parity check is comparing \
             against a stale expectation and must be re-derived from the workflow"
        );
        assert!(
            script.contains(token),
            "the manual publish script does not encode `{token}`, which the CI workflow \
             does — the manual path has drifted from the automated one"
        );
    }

    // BOTH tags, spelled the way the workflow spells them. The moving tag is the one a
    // running deployment resolves; a manual path that pushed only the immutable tag would
    // publish successfully and change nothing anyone can see.
    assert!(
        workflow.contains("schema${S}-latest-") || workflow.contains("schema$S-latest-"),
        "the workflow's moving-tag spelling changed; re-derive this check"
    );
    assert!(
        script.contains("schema$SCHEMA-latest-$ARCH"),
        "the script must re-point the MOVING tag — the step that makes a republish visible"
    );
    assert!(
        script.contains("schema$SCHEMA-$SHA-$ARCH"),
        "the script must also push the IMMUTABLE provenance tag"
    );
}

/// **#196 / PROV-E8-4 / TEST-11** — the manual script and the workflow agree that the env
/// to publish is a **derived set**, not a scalar.
///
/// ── why this test is the verification mechanism ─────────────────────────────────
/// The workflow is parked as `.disabled` because org Actions billing is off, so its
/// correctness cannot be observed by running it — and it will next be run by whoever
/// re-enables it, on a tree that may by then ship several env recipes. Leaving the
/// env id as a top-level scalar `ENV_ID` meant that run would publish exactly ONE of
/// them, under the MOVING `schema<N>-latest-<arch>` tag that live deployments resolve, and
/// the omission would surface only as a fetch of an image nobody ever pushed.
/// `publish-env-rootfs.sh`'s own header calls that class of mistake unrecoverable.
///
/// File parity is what is available without CI, and it is not nothing: it pins the two
/// publishers to the same DERIVATION, which is the property that actually differs between
/// "publishes every env" and "publishes the one somebody typed".
#[test]
fn both_publishers_derive_the_env_set_rather_than_naming_one() {
    let workflow = read(WORKFLOW);
    let script = read(SCRIPT);

    // 1. NEITHER carries an env-name literal. Derived from the recipe tree on disk, so a
    //    new recipe is covered here with no edit — never a name typed into this test.
    let env_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
    let recipes: Vec<String> = std::fs::read_dir(&env_root)
        .unwrap_or_else(|e| panic!("read {}: {e}", env_root.display()))
        .flatten()
        .filter(|e| e.path().join("Dockerfile").is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    assert!(
        !recipes.is_empty(),
        "no env recipe discovered under {} — this check would range over nothing",
        env_root.display()
    );
    let local_loop = read(LOCAL_LOOP);
    for id in &recipes {
        for (label, body) in [
            ("workflow", &workflow),
            ("manual script", &script),
            // E5 / #193: the LOCAL loop derives the same set the same way. Added here
            // rather than in a new test because the property is identical and the
            // recipe list it ranges over is the same derived, anti-vacuity-floored one.
            ("local-loop script", &local_loop),
        ] {
            // Strip comment lines first: BOTH files explain the retired literal in prose,
            // and a guard that cannot tell an explanation from a re-introduction is a
            // guard that will be defeated by the next person who writes a comment.
            let code: String = body
                .lines()
                .filter(|l| !l.trim_start().starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code.contains(id.as_str()),
                "the {label} names the env `{id}` in code. The env set is DATA: derive it \
                 from the recipe tree (the workflow's `gate` job, the script's \
                 `AVAILABLE`), never type one in — a named env is the one that gets \
                 published while the others are silently skipped."
            );
        }
    }

    // Steps 2-5 assert against the COMMENT-STRIPPED text, for the same reason step 1
    // does: these files explain themselves at length, and a check that a comment can
    // satisfy is a check a comment can fake. Asserting them against the raw text (which
    // this did) meant a sentence mentioning `matrix.env` was indistinguishable from the
    // matrix actually using it.
    let strip = |body: &str| -> String {
        body.lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let workflow = strip(&workflow);
    let script = strip(&script);

    // 2. The WORKFLOW derives its env axis and crosses it into the build matrix.
    assert!(
        workflow.contains("fromJSON(needs.gate.outputs.envs)"),
        "the workflow's env matrix axis must come from the discovery job's output"
    );
    assert!(
        workflow.contains("-name Dockerfile"),
        "the workflow must DISCOVER envs the way `discover_env_recipes` does — a directory \
         holding a Dockerfile is one env"
    );
    assert!(
        workflow.contains("matrix.env"),
        "the build job must consume the derived env axis"
    );

    // 3. The SCRIPT derives the same way, and REFUSES rather than guessing when the choice
    //    is real. Refusing is the manual path's analogue of the matrix: both cover every
    //    env, neither picks one silently.
    assert!(
        script.contains("-name Dockerfile"),
        "the manual script must discover recipes the same way the workflow does"
    );
    assert!(
        script.contains("pass --env <id> to choose one"),
        "with more than one recipe the manual script must REFUSE and name the candidates, \
         never publish an arbitrary one"
    );

    // 3b. …and so does the LOCAL loop (E5 / #193). Same discovery, same refusal. The
    //     BEHAVIOURAL half of this — that the two scripts' candidate lists are actually
    //     equal, not merely both derived — is `scripts/check-env-loop.sh`,
    //     which runs both refusals and diffs them against the tree. Two files can each
    //     pass a textual derive-check and still derive DIFFERENT sets; only running them
    //     catches that, which is why the file parity here is a floor and not the proof.
    let local_loop_code = strip(&local_loop);
    assert!(
        local_loop_code.contains("-name Dockerfile"),
        "the local-loop script must DISCOVER envs the way the workflow and the publisher \
         do — a directory holding a Dockerfile is one env"
    );
    // A DISTINCTIVE phrase from the refusal branch, not the flag name. `contains("--env ")`
    // was satisfied by two lines that have nothing to do with refusing — the
    // `--all and --env are mutually exclusive` error and the `--print-seam` hint — so the
    // whole multi-recipe refusal branch could be deleted with this assertion still green.
    // A guard a decoy string defeats is the failure class this repository has spent the
    // most time on; the sibling assertion above uses the publisher's own refusal sentence
    // for the same reason. The BEHAVIOURAL proof (both scripts' candidate lists diffed
    // against the recipe tree) is `scripts/check-env-loop.sh`, which `just check-guards`
    // now runs — this file-parity check is the floor under it, not the proof.
    assert!(
        local_loop_code.contains("will not make it for you"),
        "with more than one recipe the local-loop script must REFUSE and name the \
         candidates, never build an arbitrary one — its refusal sentence is gone"
    );

    // 4. Per-env, BOTH tags still. A matrix that published only the immutable tag would
    //    change nothing any deployment can see; one that published only the moving tag
    //    would leave provenance unable to pin what ran.
    assert!(
        workflow.contains("schema${S}-${SHA}-${{ matrix.arch }}")
            && workflow.contains("schema${S}-latest-${{ matrix.arch }}"),
        "the workflow must push BOTH the immutable and the moving tag for EACH matrix entry"
    );

    // 5. …and the repo path is per-env, so two envs cannot collide on one repository.
    //
    // Asserted as a PROPERTY, not a spelling. The first cut of this demanded the literal
    // `${REPO_PREFIX}/${{ matrix.env }}` and went red against a workflow that satisfies the
    // property a different way — binding the matrix value to a job-level `ENV_ID` and using
    // `${ENV_ID}` in the path. Pinning one spelling of a correct mechanism is the same
    // mistake this whole item is about, one level up: it fails correct input, which is how
    // a guard gets deleted rather than fixed.
    //
    // So: find the line that BUILDS the repo path, take the shell variable it interpolates
    // after the prefix, and require that variable to be bound from a matrix dimension.
    let repo_line = workflow
        .lines()
        .find(|l| l.contains("repo=") && l.contains("REPO_PREFIX"))
        .unwrap_or_else(|| panic!("no line builds the per-env repo path:\n{workflow}"));
    let after_prefix = repo_line
        .split("REPO_PREFIX}")
        .nth(1)
        .unwrap_or_else(|| panic!("repo path does not use REPO_PREFIX: {repo_line}"));
    let var: String = after_prefix
        .trim_start_matches('/')
        .trim_start_matches("${")
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    assert!(
        !var.is_empty(),
        "the repo path segment after REPO_PREFIX must be a VARIABLE, not a literal env \
         name — a fixed segment means every env publishes to one repository and the \
         second env's moving tag overwrites the first's: {repo_line}"
    );
    assert!(
        workflow.contains(&format!("{var}: ${{{{ matrix.")),
        "the repo path is parameterised by `{var}`, but `{var}` is not bound from a MATRIX \
         dimension. Then it is one value for every job, which is the scalar-ENV_ID defect \
         wearing a variable's clothes.\n{workflow}"
    );
}


// ── #196 + #191, at the merge: BOTH tests stand ─────────────────────────────────────
// They assert DIFFERENT properties of one file and neither subsumes the other:
//   * the one above pins that neither publisher NAMES an env — the set is derived from the
//     recipe tree, so a new recipe is covered here with no edit;
//   * the one below pins that the workflow's env id is a per-job MATRIX DIMENSION and that
//     its trigger cannot republish an env whose recipe did not change.
// The second PARSES the YAML rather than searching it, because two grep-based cuts of it
// were defeated — once by a comment, once by a YAML block scalar carrying the needles while
// the mechanism was deleted. That is the same prose-satisfiability this item hit three times
// in its own guards; the structural assertion is the right answer in both places.

/// **TEST-E3-18** [covers: ITEM-9] (#191) — NEITHER publisher can publish ONE env while
/// its trigger fires for ALL of them.
///
/// The defect: the workflow's rebuild trigger matches any change under
/// `src-app/env-rootfs/`, while `ENV_ID` was a SCALAR naming one env. So editing the
/// SECOND recipe rebuilt and re-pointed the FIRST env's moving tag — a republish of an
/// image whose recipe had not changed, using a build of one that had — and the second
/// image had no publish path at all. That is silent: both publishes "succeed".
///
/// Two properties close it, and they are asserted on the FILES rather than on a
/// remembered env name:
///
/// 1. the workflow's env id is a per-job MATRIX value, not a scalar constant, and the
///    matrix is discovered from the recipe tree;
/// 2. the manual script takes `--env` and REFUSES rather than defaulting when the tree is
///    ambiguous.
#[test]
fn neither_publisher_can_republish_an_env_whose_recipe_did_not_change() {
    // ## Why this PARSES the workflow instead of grepping it
    //
    // Two previous cuts of this test were defeated the same way, one level apart. The
    // first grepped the raw file and an auditor satisfied every needle with ONE COMMENT
    // LINE. The second stripped `#` comments — and an auditor parked the identical needles
    // in a YAML BLOCK SCALAR (`name: >-`) on the gate step, which is not a comment, deleted
    // the entire mechanism, hardcoded one env back into the build steps, and it passed
    // again. There is no third spelling of "search the text for a word" that fixes this:
    // any predicate over free text can be satisfied by writing the text.
    //
    // So the workflow is PARSED and the assertions are about its STRUCTURE — a matrix
    // dimension, a job-level `env` binding, a job output. A string parked anywhere else in
    // the document cannot create a matrix dimension. What remains textual is scoped to the
    // `run:` script of the specific step that must contain it, which is the field where
    // that logic can actually live.
    let workflow_src = read(WORKFLOW);
    let script_src = read(SCRIPT);
    let wf: serde_norway::Value =
        serde_norway::from_str(&workflow_src).expect("the workflow must be parseable YAML");

    let get = |v: &serde_norway::Value, k: &str| -> serde_norway::Value {
        v.get(k).cloned().unwrap_or(serde_norway::Value::Null)
    };
    let jobs = get(&wf, "jobs");
    let gate = get(&jobs, "gate");
    let build = get(&jobs, "build");
    assert!(!gate.is_null() && !build.is_null(), "the workflow must have gate + build jobs");

    // (1a) The env id is a MATRIX DIMENSION, discovered from the gate's output.
    let matrix = get(&get(&build, "strategy"), "matrix");
    let env_dim = get(&matrix, "env_id");
    let env_dim = env_dim.as_str().unwrap_or_default();
    assert!(
        env_dim.contains("fromJSON") && env_dim.contains("gate.outputs.envs"),
        "`jobs.build.strategy.matrix.env_id` must be the gate's DISCOVERED env list, not a \
         literal; found {env_dim:?}"
    );
    // (1b) …and it is actually CONSUMED. A matrix nothing reads leaves ${ENV_ID} empty and
    // builds `env-rootfs//Dockerfile`.
    let build_env = get(&build, "env");
    assert_eq!(
        get(&build_env, "ENV_ID").as_str(),
        Some("${{ matrix.env_id }}"),
        "the build job must bind ENV_ID to the matrix value; found {build_env:?}"
    );
    // (1c) No scalar ENV_ID anywhere — that literal is the original defect.
    assert!(
        !regex_lite_scalar_env_id(&workflow_src),
        "the workflow declares a scalar `ENV_ID: <value>`; with a tree-wide trigger that \
         republishes ONE env's moving tag for ANY recipe change"
    );
    // (1d) `arch` is a real DIMENSION, not an include-only key. As an include-only key,
    // uncommenting the arm64 row appends a job with no `env_id` at all.
    assert!(
        get(&matrix, "arch").is_sequence(),
        "`arch` must be a matrix dimension so env x arch is a real cross product; found \
         {:?}",
        get(&matrix, "arch")
    );
    // (1e) The gate must EXPORT the discovered set.
    let envs_out = get(&get(&gate, "outputs"), "envs");
    assert!(
        envs_out.as_str().unwrap_or_default().contains("outputs.envs"),
        "the gate job must output `envs`; found {envs_out:?}"
    );

    // (2) The gate's own `run:` script — the one field where this logic can live — must
    // DISCOVER the envs off the recipe tree and NARROW them to the ones that changed.
    // Scoped to that field, so a string elsewhere in the document is irrelevant.
    let steps = get(&gate, "steps");
    let gate_run: String = steps
        .as_sequence()
        .map(|ss| {
            ss.iter()
                .filter_map(|st| get(st, "run").as_str().map(str::to_string))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    assert!(
        gate_run.len() >= 400,
        "the gate job has almost no `run:` script ({} bytes) — it cannot be doing the work \
         the assertions below describe",
        gate_run.len()
    );
    // …and the SELECTION is proven by RUNNING that script, not by grepping it.
    //
    // A `run:` field is free text and always will be. A blind round parked the two needles
    // this used to grep for in a `# The env set used to be DISCOVERED …` COMMENT BLOCK
    // inside the very same field — which also cleared the length floor — while the step
    // itself had been reduced to an `echo` of a HARDCODED one-element env list, i.e. the
    // original defect with a literal fed into a real matrix. Every previous cut of this
    // test failed the same way one level in; there is no predicate over free text that
    // fixes it.
    //
    // So the gate's script is extracted, its GitHub expressions are bound to a fixture,
    // and it is EXECUTED against a temp repo holding two SYNTHETIC recipes. What it must
    // do is behavioural: a change to ONE of them selects that one ALONE.
    let gate_out = run_gate_script(&gate_run);
    assert_eq!(
        gate_out,
        Some(("yes".into(), format!("[\"{FIXTURE_ENV_B}\"]"))),
        "a change to ONE recipe must select that env ALONE. Anything else re-points every \
         other env's moving tag with a build of a change that was not theirs — and a gate \
         that emits a hardcoded list satisfies every static check while doing exactly that"
    );

    // (3) THE MANUAL PATH, asserted by RUNNING IT rather than by grepping for `exit 2`.
    //
    // The grep form was defeated too: `exit 2` appears four times in the script and only
    // one is the refusal, so replacing the refusal with `ENV_ID=$(… | head -1)` left the
    // token behind and the test green — while the mutant cheerfully re-pointed the wrong
    // env's moving tag. With two recipes on disk and no `--env`, the script must EXIT 2
    // before it touches docker or oras, and it must name the candidates.
    // BOTH INVOCATIONS, and the second is the one that matters. A blind round made the
    // script refuse only under `--dry-run` and default on the real publish path — green,
    // because the probe only ever ran the rehearsal. The mode this guard exists to protect
    // is the one that re-points the moving tag.
    //
    // The correct script refuses before it touches docker or oras, so the real invocation
    // returns instantly; `timeout` bounds a mutant that gets past the refusal and starts a
    // build, and its 124 is just as much "not 2" as anything else.
    let run_publish = |extra: &[&str]| -> std::process::Output {
        let mut cmd = std::process::Command::new("timeout");
        cmd.arg("60").arg("sh").arg(repo_root().join(SCRIPT));
        for a in extra {
            cmd.arg(a);
        }
        cmd.current_dir(repo_root())
            .output()
            .expect("the publish script must be runnable")
    };
    let out = run_publish(&["--dry-run"]);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert_eq!(
        out.status.code(),
        Some(2),
        "with more than one recipe and no --env the publish script must EXIT 2. It exited \
         {:?}.\nstdout: {}\nstderr: {stderr}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout)
    );
    let real = run_publish(&[]);
    assert_eq!(
        real.status.code(),
        Some(2),
        "…and it must refuse on the REAL publish path too, not only under --dry-run. It \
         exited {:?}, which means it chose an env and proceeded to publish one.\nstdout: \
         {}\nstderr: {}",
        real.status.code(),
        String::from_utf8_lossy(&real.stdout),
        String::from_utf8_lossy(&real.stderr)
    );
    // …naming every candidate, so the operator is told what to choose between.
    let recipe_root = repo_root().join("src-app/env-rootfs");
    let ids = cytoanalyst::modules::rootfs::version::discover_env_recipes(&recipe_root);
    assert!(ids.len() >= 2, "this assertion needs an ambiguous tree; found {ids:?}");
    for id in &ids {
        assert!(
            stderr.contains(id.as_str()),
            "the refusal must NAME candidate {id:?}; got: {stderr}"
        );
    }
    // POSITIVE CONTROL: the exit code discriminates. A --env naming a recipe that does not
    // exist is a DIFFERENT failure (1), so `2` above is the ambiguity refusal specifically
    // and not "this script always fails".
    let bad = std::process::Command::new("sh")
        .arg(repo_root().join(SCRIPT))
        .args(["--env", "definitely-not-a-recipe", "--dry-run"])
        .current_dir(repo_root())
        .output()
        .expect("runnable");
    assert_eq!(
        bad.status.code(),
        Some(1),
        "an --env naming no recipe must fail with 1, distinct from the ambiguity refusal's \
         2 — otherwise the exit code above proves nothing"
    );

    // (4) …and the script must not quietly acquire a declared default. `DEFAULT_ENV` is
    // the BUILD's declaration; honouring it here would reintroduce (1) in script form.
    let script = instructions(&script_src);
    assert!(
        script.len() >= 20,
        "the comment strip left {} script instruction line(s) — it is not reading the file",
        script.len()
    );
    let offenders: Vec<&&str> = script.iter().filter(|l| l.contains("DEFAULT_ENV")).collect();
    assert!(
        offenders.is_empty(),
        "the publish script must not READ env-rootfs/DEFAULT_ENV — that file declares what \
         the BUILD stages, and a publish that defaulted from it would re-point the wrong \
         env's moving tag. Offending line(s): {offenders:?}"
    );
}

/// The two SYNTHETIC env ids this fixture builds its temp recipe tree from.
///
/// Deliberately not the shipped ids, for two independent reasons:
///
/// 1. **The subject is SELECTION, not naming.** What the gate must do is "a change to one
///    recipe directory selects that env and no other". That property is about the shell's
///    diff-narrowing logic, which is generic — it has never known what an env is called.
///    Driving it with invented ids asserts exactly the same thing and additionally proves
///    the gate is not special-casing anything, which the real ids could not.
/// 2. **It keeps analysis-domain vocabulary out of the app tier.** The shipped env ids
///    are built from domain words, and `lint-no-domain-in-builtin` is right to refuse
///    them here even though what they name is a recipe directory rather than biology.
///    The lint cannot tell those apart — nor should it have to — and the fix is to not
///    need it to. (This comment is itself under that lint, which is why it describes the
///    ids rather than quoting one.)
///
/// A happy side effect: this test no longer depends on the real recipe set at all, so it
/// cannot start failing because someone added or renamed a recipe.
const FIXTURE_ENV_A: &str = "env-alpha";
const FIXTURE_ENV_B: &str = "env-beta";

/// Extract the gate step's shell, bind its GitHub expressions to a fixture, and RUN it
/// against a temp repo in which only ONE of two recipes changed. Returns `(build, envs)`
/// as the script wrote them to `$GITHUB_OUTPUT`, or `None` if it did not write both.
fn run_gate_script(gate_run: &str) -> Option<(String, String)> {
    use std::io::Write;
    let ids = [FIXTURE_ENV_A, FIXTURE_ENV_B];
    let tmp = std::env::temp_dir().join(format!("cyto-gate-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    for id in ids {
        std::fs::create_dir_all(tmp.join("src-app/env-rootfs").join(id)).ok()?;
        std::fs::write(tmp.join("src-app/env-rootfs").join(id).join("Dockerfile"), "FROM x\n").ok()?;
    }
    // Bind the workflow expressions: a push, a resolvable base, and a diff naming ONLY the
    // second env's recipe.
    let changed = format!("src-app/env-rootfs/{}/Dockerfile", ids[1]);
    let script = gate_run
        .replace("${{ github.ref_type }}", "branch")
        .replace("${{ github.event_name }}", "push")
        .replace("${{ github.event.before }}", "BASE")
        .replace("${{ github.sha }}", "HEAD");
    let path = tmp.join("gate.sh");
    let mut f = std::fs::File::create(&path).ok()?;
    // `git` is shadowed by a shell function so the script's own diff invocation returns the
    // fixture's changed-file list; everything else in the script runs unmodified.
    // The NUL that `git diff -z` emits is produced BY THE SHIM: an environment variable
    // cannot contain a NUL byte, so passing it through the env silently fails the spawn.
    writeln!(f, "git() {{ printf '%s\\0' \"$CYTO_CHANGED\"; }}").ok()?;
    writeln!(f, "{script}").ok()?;
    drop(f);
    let out = std::process::Command::new("bash")
        .arg(&path)
        .current_dir(&tmp)
        .env("GITHUB_OUTPUT", tmp.join("out.txt"))
        .env("CYTO_CHANGED", &changed)
        .output()
        .expect("the extracted gate script must be runnable under bash");
    let written = std::fs::read_to_string(tmp.join("out.txt")).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&tmp);
    assert!(
        out.status.success(),
        "the gate script failed: {}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let grab = |k: &str| {
        written
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .map(str::to_string)
    };
    Some((grab("build")?, grab("envs")?))
}

/// The lines of a shell script that are not whole-line `#` comments.
fn instructions(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .collect()
}

/// Is there a workflow-level or step-level `ENV_ID: <literal>` (as opposed to
/// `ENV_ID: ${{ matrix.env_id }}`)? Written by hand because this crate carries no regex
/// dependency in its test surface and the shape is trivial.
fn regex_lite_scalar_env_id(workflow: &str) -> bool {
    workflow.lines().any(|l| {
        let t = l.trim();
        let Some(rest) = t.strip_prefix("ENV_ID:") else {
            return false;
        };
        let rest = rest.trim();
        !rest.is_empty() && !rest.starts_with("${{")
    })
}

#[test]
fn the_script_reads_the_schema_version_from_the_same_place_the_workflow_does() {
    // Two publishers that disagreed about the schema number would publish under different
    // tag families — one of them invisible to every deployment. Both read the constant out
    // of the runtime source rather than carrying their own copy.
    let workflow = read(WORKFLOW);
    let script = read(SCRIPT);
    let needle = "rootfs/version.rs";
    assert!(workflow.contains(needle), "the workflow reads the schema from {needle}");
    assert!(
        script.contains("rootfs/version.rs"),
        "the script must read the schema version from the same source of truth, not carry \
         its own copy"
    );
}

#[test]
fn the_runbook_records_why_the_workflow_is_disabled_and_how_to_re_enable_it() {
    let runbook = read(RUNBOOK);
    // WHY. Without the cause recorded, the next person's first move is to re-enable the
    // workflow — which restores the failures, not the publishes.
    assert!(
        runbook.contains("Actions billing"),
        "the runbook must record WHY the workflow is disabled (an organization billing \
         state), so nobody 'fixes' it by turning it back on"
    );
    // HOW to undo it, and the trigger.
    assert!(
        runbook.contains("re-enable trigger"),
        "the runbook must name the condition under which the workflow is re-enabled"
    );
    assert!(
        runbook.contains("git mv"),
        "the runbook must state that re-enabling is a rename, not a rebuild"
    );
    // The honest limitation. Signing off CI uses a different identity than the runtime's
    // verifier expects; a runbook that omitted that would send someone to publish an image
    // their own deployment refuses to mount.
    assert!(
        runbook.contains("Signing off CI"),
        "the runbook must state the one step where the manual path is NOT equivalent to CI"
    );
    // The consequence that makes the whole procedure necessary.
    assert!(
        runbook.contains("schema<N>-latest-<arch>"),
        "the runbook must explain that the runtime resolves the MOVING tag, which is why an \
         unpublished recipe change is invisible"
    );
}

#[test]
fn the_runbook_documents_the_pin_upgrade_procedure_and_its_escalation() {
    let runbook = read(RUNBOOK);
    for section in [
        "Upgrading a pin",
        // the step that catches "the recipe moved out from under a shipped analysis"
        "cargo check -p cytoanalyst",
        // the documented next position beyond direct pins, with its trigger
        "hash-pinned lockfile",
    ] {
        assert!(
            runbook.contains(section),
            "the runbook is missing `{section}` — the upgrade procedure is what keeps a pin \
             move from being a silent scientific change"
        );
    }
    // …and the pin file itself must point at it, or the procedure is only findable by
    // someone who already knows it exists.
    // The env id is DATA — read off the recipe tree, never spelled here (the app builtin
    // names no contributed environment), exactly as the publish script resolves it.
    let env_root = repo_root().join("src-app/env-rootfs");
    let mut checked = 0usize;
    for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
        let dir = entry.expect("a readable dir entry").path();
        if !dir.is_dir() || !dir.join("Dockerfile").exists() {
            continue;
        }
        let pins = std::fs::read_to_string(dir.join("requirements.txt"))
            .unwrap_or_else(|e| panic!("every recipe must carry a pin file: {e}"));
        assert!(
            pins.contains("docs/runbooks/env-image-republish.md"),
            "a recipe's pin file must point at the upgrade procedure, or the pins can be \
             moved by someone who never finds it"
        );
        checked += 1;
    }
    assert!(checked >= 1, "no env recipe found under {}", env_root.display());
}

/// TEST-19 [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-4] — the pinned recipe actually BUILDS,
/// its build-time import smoke line passes for every declared library, and the resolved
/// closure it bakes is real.
///
/// ## Why this is a test and not a paragraph in a log
///
/// Every other assertion about the recipe in this change set reads TEXT: that a
/// distribution is pinned, that its import appears on the smoke line, that the freeze runs
/// before the trim. None of them can tell you whether the thing installs. A pin set that
/// does not resolve, a wheel that does not exist for this interpreter, an import name
/// spelled wrong — all of those pass every text assertion and fail the first real build,
/// which under a disabled publish workflow means they fail in front of whoever is doing
/// the manual republish, at the worst moment.
///
/// So this builds the recipe. Docker's layer cache makes it near-free once warm, and the
/// build itself is the assertion: the `RUN … python -c "import …"` line inside the recipe
/// fails the IMAGE build if any declared library is absent or unimportable, so a build
/// that completes has already proven the smoke line for every name on it.
///
/// Where docker is not usable the test records an ENVIRONMENT GATE in the shared ledger
/// and returns — the same gate the sibling rootfs tests apply, and never an attribute that
/// would take the test out of the run permanently. It did not fire on the machine that
/// recorded this branch's results.
#[test]
fn the_pinned_recipe_builds_and_its_smoke_line_passes() {
    use std::process::Command;

    let docker_ok = Command::new("docker")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !docker_ok {
        crate::dataset::hardening_common::record_skip(
            "sandbox::env_publish_runbook_test::the_pinned_recipe_builds_and_its_smoke_line_passes",
            "docker is not usable here; the recipe build cannot be exercised",
        );
        return;
    }

    // The env id is DATA, discovered off the recipe tree — the same rule the assertions
    // above follow.
    let env_root = repo_root().join("src-app/env-rootfs");
    let mut built = 0usize;
    for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
        let dir = entry.expect("a readable dir entry").path();
        let recipe = dir.join("Dockerfile");
        if !dir.is_dir() || !recipe.exists() {
            continue;
        }
        // The schema arg the publish path passes, read from the same source it reads.
        let version_rs = repo_root().join("src-app/server/src/modules/rootfs/version.rs");
        let text = std::fs::read_to_string(&version_rs).expect("version.rs is readable");
        let schema = text
            .lines()
            .find(|l| l.contains("const ROOTFS_SCHEMA_VERSION"))
            .and_then(|l| l.rsplit('=').next())
            .map(|v| v.trim().trim_end_matches(';').to_string())
            .expect("ROOTFS_SCHEMA_VERSION is readable");

        // Stage 1 only: the venv, the freeze and the smoke line. The packer stage adds a
        // multi-minute mksquashfs that proves nothing this test is about.
        let out = Command::new("docker")
            .args(["build", "--target", "rootfs", "--build-arg"])
            .arg(format!("ROOTFS_SCHEMA_VERSION={schema}"))
            .arg("-f")
            .arg(&recipe)
            .arg(&dir)
            .output()
            .expect("docker build runs");
        assert!(
            out.status.success(),
            "the env recipe at {} does not build — its pin set does not resolve, or its \
             build-time import smoke line failed. stderr:\n{}",
            recipe.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        built += 1;
    }
    // `built >= 1` was the floor, and it is the shape that goes vacuous one recipe at a
    // time: a walk that silently stopped after the first would keep passing while the
    // second recipe went unbuilt. Same correction the jq walk already took — compare the
    // number BUILT against the number DISCOVERABLE by the shipped resolver, which is an
    // independent reader of the same tree.
    let discovered =
        cytoanalyst::modules::rootfs::version::discover_env_recipes(&env_root).len();
    assert!(
        discovered >= 2,
        "expected the shipped tree to hold at least two env recipes, found {discovered} \
         under {} — if one was deliberately removed, lower this floor in the same commit \
         and say why",
        env_root.display()
    );
    assert_eq!(
        built, discovered,
        "the recipe-build walk built {built} recipe(s) but {discovered} are discoverable — \
         a recipe nobody builds is a recipe whose pin set has never been resolved"
    );
}

/// **E5 / #193 · TEST-4 [acceptance] [invariant: INV-3]** — the runbook states which
/// cosign path the LOCAL loop exercises, and how it differs from the CI keyless identity.
///
/// ── why this is a test and not a review note ────────────────────────────────────────
/// INV-3 is "be honest about verification", and the failure it guards is not a bug in
/// code — it is a reader concluding that an image they built on their laptop carries the
/// same assurance as one the workflow published. Nothing in the binary can prevent that
/// conclusion; only the document can, and a document nothing checks is a document that
/// silently loses the paragraph.
///
/// ── how it avoids being satisfiable by prose ────────────────────────────────────────
/// The anchor is DERIVED from the code it is about: the identity-regexp constant's name
/// is read out of `env_image.rs`, so the runbook has to name the actual mechanism rather
/// than gesture at "signing". If that constant is renamed, this test fails and points at
/// the runbook — which is the correct direction, because the runbook would then be
/// describing a mechanism that no longer exists under that name.
///
/// The three FLOORS below exist because derivation is blind to deletion (see
/// `docs/design/derived-guards.md` §4): a check that reads the same source as its subject
/// moves with it, and would happily report a clean run over a section someone removed.
///
/// ── WHAT THIS TEST DOES NOT DO ──────────────────────────────────────────────────────
/// It is five substring checks and a length floor over prose. It cannot read English, so
/// a section that states every mechanism correctly and then contradicts itself passes.
/// Two of the needles (`#80`, `cosign-verif`) would be satisfied by a sentence asserting
/// the opposite. What it genuinely holds is that the SECTION EXISTS, is substantial, and
/// names the specific mechanisms by their real identifiers — which is what stops the
/// paragraph disappearing or decaying into a vague gesture at "signing". Read it as a
/// floor under a human review, not as a substitute for one.
#[test]
fn the_runbook_states_the_local_loops_verification_difference() {
    let runbook = read(RUNBOOK);
    let env_image = read("src-app/server/src/modules/sandbox/env_image.rs");

    // FLOOR 1 — the mechanism this is about must still exist, or the assertions below
    // range over a constant nobody defines.
    let identity_const = "DEFAULT_IDENTITY_RE";
    assert!(
        env_image.contains(identity_const),
        "`{identity_const}` is gone from env_image.rs. The runbook's verification section \
         describes it by name; re-derive this check against whatever replaced it rather \
         than deleting the section."
    );

    // FLOOR 2 — the section itself must exist and be substantial. A heading alone, or a
    // section trimmed to a sentence, is how this paragraph would quietly disappear.
    let section = runbook
        .split("## 4c.")
        .nth(1)
        .unwrap_or_else(|| panic!("the runbook has no `## 4c.` local-loop section"))
        .split("\n## ")
        .next()
        .unwrap_or_default();
    assert!(
        section.len() > 800,
        "the local-loop section is only {} bytes — too short to have stated the \
         verification difference, the development-vs-publishing split and the seam \
         hazard. A shrinking section is exactly the failure this floor is for.",
        section.len()
    );

    // THE CLAIM. Each of these is a distinct thing INV-3/INV-4 require the reader to be
    // told, and each is checked against the SECTION, not the whole document — otherwise a
    // mention anywhere else in a 400-line runbook would satisfy it.
    for (what, needle) in [
        ("the identity constant the published path pins", identity_const),
        ("that seam 1 carries no signature", "no signature in"),
        ("the cosign verification the published path performs", "cosign-verif"),
        ("that widening a deployment's identity policy is NOT the fix", "CYTO_ENV_IMAGE_IDENTITY_REGEXP"),
        ("that publishing stays gated", "#80"),
    ] {
        assert!(
            section.contains(needle),
            "the runbook's local-loop section does not state {what} (looked for \
             `{needle}`). A locally built image that a reader believes is CI-signed is \
             the precise misunderstanding INV-3 exists to prevent."
        );
    }

    // FLOOR 3 — and it must not claim EQUIVALENCE. The one sentence that would undo the
    // whole section is a reassurance that the two paths amount to the same thing.
    //
    // HONEST LIMIT, stated because two blind auditors both flagged it: this is a DECOY
    // LIST, not a property. It catches the three phrasings someone is most likely to
    // reach for and cannot catch "carries the same assurance" or "verified the same way".
    // Deciding whether English prose asserts equivalence is not something a `contains`
    // can do, and the repository's own history says the answer to an unbounded evasion
    // space is never another predicate — so this is deliberately a tripwire for the
    // honest mistake, and the load-bearing guarantee is the POSITIVE list above plus the
    // section-length floor, which together make the section hard to gut quietly.
    for forbidden in [
        "equivalent to the CI path",
        "same as a published image",
        "just as verified",
    ] {
        assert!(
            !section.contains(forbidden),
            "the local-loop section claims equivalence with the published path \
             (`{forbidden}`), which is exactly what INV-3 forbids: a locally built image \
             cannot satisfy the CI OIDC identity, and saying otherwise sends someone to \
             ship one."
        );
    }
}
