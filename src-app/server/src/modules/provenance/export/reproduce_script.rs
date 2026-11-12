//! Reproduce-capsule generator (ITEM-17 / ITEM-22). Topo-sorts the sub-DAG into a
//! `run.sh` that runs **each step INSIDE its own pinned rootfs** (`env_rootfs_sha256`),
//! language- + arch-aware, recreating the exact sandbox bind layout the server
//! used (`data`→`/inputs` + `/inputs/inputs.json`/`params.json`, code→`/code`,
//! `/outputs`) and wiring each step's outputs to the next BY CONTENT HASH.
//!
//! The rootfs is NOT embedded in the bundle (multi-GB × N versions); the capsule
//! carries an `environments.json` = the distinct digests the closure needs, each
//! with its arch + placement path + obtain instructions (DEC-15/16/32,
//! deployment-assisted: obtain from a running TxResBench by digest, or an
//! operator-placed `.squashfs`). `run.sh` runtime-detects the best available
//! runner, preferring the **no-Docker** path (squashfuse+bwrap → apptainer →
//! docker/podman → unsquashfs+proot), and if a step's rootfs is absent it prints
//! the obtain instructions and exits 1.
//!
//! Per-step scripts are pulled from `provenance_code_blobs` by `code_sha256` (never
//! regenerated); the harness pins the seed + single-threaded BLAS for determinism.

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::modules::provenance::models::UsedEdgeDto;

/// One run's export facts (its captured code + used inputs + produced outputs +
/// the environment it ran in).
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub run_id: Uuid,
    pub kind: String,
    /// The captured code blob's hash — the script is PULLED by this, not emitted.
    pub code_sha256: Option<String>,
    pub inputs: Vec<UsedEdgeDto>,
    pub output_hashes: Vec<String>,
    /// The script language (`python` | `r` | `bash`) → entry ext + interpreter.
    pub language: String,
    /// The PINNED rootfs content digest this run executed against (bare hex; ITEM-22).
    /// `None` for an in-app interaction/promote node (nothing to run).
    pub env_rootfs_sha256: Option<String>,
    /// The CPU arch the run executed on (for `environments.json`); `None` = unknown.
    pub arch: Option<String>,
    /// The run's RNG seed (→ per-step `/inputs/params.json`, determinism).
    pub seed: Option<i64>,
    /// `(slot, /inputs-relative subpath)` recorded for the original run, so each input
    /// binds at the SAME path the run saw. A slot with no entry falls back to the
    /// bare-hex data name.
    ///
    /// **A slot MAY REPEAT** — a `multiple: true` slot carries one
    /// entry per binding, at DISTINCT subpaths — so this is an ordered LIST, not a map,
    /// and [`build`] consumes a repeated slot's entries in order. Collapsing it into a
    /// `slot → subpath` map gives every binding the same path, which is the runner's
    /// overwrite defect reproduced inside the capsule.
    pub input_subpaths: Vec<(String, String)>,
    /// **ITEM-1** — the run's SCIENTIFIC params (the sandbox `RunSpec.params`
    /// object: the filter criteria, the thresholds, `min_genes`, the mask label …),
    /// sourced from the stashed re-run spec by `bundle::params_from_rerun`.
    /// Regenerated into the capsule's `/inputs/params.json` by [`render_step`].
    ///
    /// Defaults to `{}` — a run with no recorded params keeps today's behavior
    /// (a params.json carrying only `seed`). Before ITEM-1/2/3 this field did not
    /// exist and the capsule ALWAYS emitted seed-only, so a replay re-ran the
    /// processor with no predicate at all and produced a silently different
    /// (all-cells-kept) result that looked successful.
    pub params: serde_json::Value,
    /// **ROUND-19 (R19-03)** — did the RECORDED run's `/code` actually receive the
    /// shared runtime modules? Derived by `bundle::run_staged_shared_helpers` from
    /// the stashed re-run spec, NOT inferred from the language. See
    /// [`step_stages_helpers`] for why the language alone answers this wrong.
    pub staged_shared_helpers: bool,
}

/// One resolved input of a step (staged from the content-addressed store).
#[derive(Debug, Clone)]
pub struct StepInput {
    pub slot: String,
    pub kind: String,
    pub content_hash: String,
    /// The `/inputs`-relative subpath to place the file at.
    pub subpath: String,
    /// True when the hash is a bundled `data/<hash>` root (else a prior step's output).
    pub is_root: bool,
    /// **ITEM-19 / INV-3** — how this input was bound (`user` | `auto`), carried
    /// verbatim from the recorded `UsedEdgeDto.bound_by`.
    ///
    /// `None` = UNSTATED, and the renderers OMIT the key entirely in that case rather
    /// than emitting a null or a default. The bundle is an out-of-app trust
    /// deliverable read by someone who was never at the keyboard: a `"bound_by":
    /// "user"` on a run that recorded no origin would tell that reader a person
    /// reviewed the input, which nobody observed (DEC-7 — no backfill).
    pub bound_by: Option<String>,
}

/// A step in the reproduce script (topological order).
#[derive(Debug, Clone)]
pub struct Step {
    pub run_id: Uuid,
    pub kind: String,
    pub code_sha256: Option<String>,
    /// Bundle-relative script path (`scripts/step_NN_<sha12>.{py,R,sh}`).
    pub script_name: String,
    /// `python` | `r` | `bash`.
    pub language: String,
    /// The pinned rootfs digest (bare hex) this step runs in; `None` = not runnable.
    pub env_digest: Option<String>,
    pub arch: Option<String>,
    pub seed: Option<i64>,
    /// **ITEM-1** — this step's scientific params (carried from `RunSpec::params`),
    /// written to `$STEP/inputs/params.json` by [`render_step`]. Defaults to `{}`.
    pub params: serde_json::Value,
    /// Per-step workspace dir (`work/NN`).
    pub work_dir: String,
    pub inputs: Vec<StepInput>,
    /// **ROUND-19 (R19-03)** — carried from [`RunSpec::staged_shared_helpers`]: did
    /// the RECORDED run's `/code` hold the shared runtime modules? Read by
    /// [`step_stages_helpers`], which used to answer from the language alone.
    pub staged_shared_helpers: bool,
}

/// A distinct environment the closure needs (one per rootfs digest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvDigest {
    /// Bare lowercase-hex digest (as stored in `env_rootfs_sha256`).
    pub digest: String,
    /// CPU arch the runs pinned to this digest executed on (`unknown` if none).
    pub arch: String,
}

/// The assembled reproduce script.
#[derive(Debug, Clone)]
pub struct ReproduceScript {
    pub run_sh: String,
    pub inputs_json: String,
    pub steps: Vec<Step>,
    /// Distinct rootfs environments the closure needs (feeds `environments.json`).
    pub environments: Vec<EnvDigest>,
}

/// The bundle-relative data path for a content hash (bare hex, NO `sha256:`).
pub fn data_filename(content_hash: &str) -> String {
    content_hash.strip_prefix("sha256:").unwrap_or(content_hash).to_string()
}

/// Where the bundle carries the SHARED runtime modules the sandbox stages into the
/// code dir of every Python entry (`processors::PY_HELPER_FILES`).
///
/// Named once, here, because the assembler writes these members and `render_step`
/// copies them out — two files that must agree on a path with nothing else to catch a
/// disagreement (the symptom would be an import error inside a rootfs, on a machine
/// that is not ours).
pub const HELPER_MEMBER_PREFIX: &str = "scripts/helpers/";

/// Does this step's `/code` need the shared runtime modules staged into it?
///
/// The governing rule is the one this module refuses R18-02's cheap fix by: **putting
/// files in `/code` the recorded run never had there is a different run, not a safer
/// one.** So the answer is read off what the run RECORDED
/// ([`RunSpec::staged_shared_helpers`], derived by
/// `bundle::run_staged_shared_helpers`), never inferred from the language.
///
/// **ROUND-19 (R19-03) — why the language alone answered this wrong.** This predicate
/// used to be `language == python`, justified by "the live sandbox stages them for
/// PYTHON entries only (`processors::resolve_in` gates on `Language::Python`)". That
/// citation names the `code_ref` branch, and an INLINE-SCRIPT run never reaches it:
/// `AnalysisSpec::resolve_entry` returns `helpers: Vec::new()` for a spec carrying
/// `script`, and `jobs::runner` stages exactly `resolved.helpers` — so such a run's
/// `/code` held its entry ALONE while the capsule copied six modules in beside it.
/// A `jobs::use` user reaches that path directly, and the branch's own
/// `capsule_multistep_test` runs two of them. Consequences were small but real: a
/// capsule step could succeed where the recorded run raised `ModuleNotFoundError`,
/// any of the six names shadowed a same-named import on `/code` (which is
/// `sys.path[0]`), and an unreadable helper seed reddened `code_captured` for a run
/// whose `/code` never wanted them.
///
/// **The residual, stated rather than implied.** For a `code_ref` run the capsule
/// still stages LESS than the live path did — `resolve_in` also stages the entry's
/// package-DECLARED siblings and any `RESERVED_ENTRY_HELPERS`, which the capsule's
/// single shared `scripts/helpers/` cannot express (R18-02, whose faithful fix is
/// per-step staging, a bundle-layout change). So the bound this predicate now holds
/// is one-directional and checkable: **a capsule's `/code` is never a SUPERSET of the
/// recorded run's** — it may be short, it is never invented.
pub fn step_stages_helpers(step: &Step) -> bool {
    step.code_sha256.is_some() && step.env_digest.is_some() && step.staged_shared_helpers
}

/// Single-quote a value for safe interpolation into the generated `run.sh`. A
/// `validate_subpath`-clean name is path-safe but NOT shell-safe: a `"`, `$`,
/// backtick, or `;` is a legal filename byte yet would break out of a
/// double-quoted shell context and inject commands when `run.sh` runs. Wrapping in
/// single quotes makes every byte literal; an embedded `'` is closed, escaped, and
/// reopened (`'\''`) — the canonical POSIX-safe quoting.
pub fn sh_squote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// `(entry-file extension, interpreter)` for a script language.
pub fn lang_ext_interp(language: &str) -> (&'static str, &'static str) {
    match language.trim().to_ascii_lowercase().as_str() {
        "python" | "py" => ("py", "python3"),
        "r" | "rscript" => ("R", "Rscript"),
        // `bash` + any unknown default to a shell entry (CLI-glue processors).
        _ => ("sh", "bash"),
    }
}

/// Topologically order runs so a run follows every run producing one of its
/// inputs. Deterministic (ties break on the runs' original order). A residual
/// cycle (should not occur in a content-addressed DAG) appends its remainder.
pub fn topo_order(runs: &[RunSpec]) -> Vec<Uuid> {
    // Which internal run produced each output hash.
    let mut producer: HashMap<&str, Uuid> = HashMap::new();
    for r in runs {
        for h in &r.output_hashes {
            producer.insert(h.as_str(), r.run_id);
        }
    }
    let mut emitted: HashSet<Uuid> = HashSet::new();
    let mut order: Vec<Uuid> = Vec::new();
    // Iterative Kahn-style selection preserving input order.
    loop {
        let mut progressed = false;
        for r in runs {
            if emitted.contains(&r.run_id) {
                continue;
            }
            let ready = r.inputs.iter().all(|i| {
                match producer.get(i.content_hash.as_str()) {
                    // An input produced by another internal run must precede us.
                    Some(&pid) if pid != r.run_id => emitted.contains(&pid),
                    _ => true, // a root / self input is always ready
                }
            });
            if ready {
                emitted.insert(r.run_id);
                order.push(r.run_id);
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    // Append any residual (cycle) runs deterministically.
    for r in runs {
        if !emitted.contains(&r.run_id) {
            order.push(r.run_id);
        }
    }
    order
}

/// The distinct rootfs environments the closure needs (deduped by digest, sorted
/// for determinism). The arch is taken from the first run pinning that digest.
pub fn distinct_environments(runs: &[RunSpec]) -> Vec<EnvDigest> {
    let mut seen: HashMap<String, String> = HashMap::new();
    for r in runs {
        if let Some(d) = &r.env_rootfs_sha256 {
            let digest = data_filename(d); // normalize to bare hex
            if digest.is_empty() {
                continue;
            }
            seen.entry(digest)
                .or_insert_with(|| r.arch.clone().unwrap_or_else(|| "unknown".to_string()));
        }
    }
    let mut envs: Vec<EnvDigest> =
        seen.into_iter().map(|(digest, arch)| EnvDigest { digest, arch }).collect();
    envs.sort_by(|a, b| a.digest.cmp(&b.digest));
    envs
}

/// The bundle-relative placement path for a rootfs digest (bare hex).
pub fn env_placement(digest: &str) -> String {
    format!("env/{}/rootfs.squashfs", data_filename(digest))
}

/// The human obtain instruction for a digest (deployment-assisted, DEC-32 — no
/// public registry in v1).
fn env_obtain(digest: &str) -> String {
    let d = data_filename(digest);
    format!(
        "From a running TxResBench that ran this: GET /api/sandbox/rootfs/{d} (authenticated), \
         or copy the matching rootfs.squashfs to {}",
        env_placement(&d)
    )
}

/// Serialize `environments.json` — the set of distinct rootfs digests the closure
/// needs, each with `{digest, arch, placement, obtain, obtainable}`. `obtainable`
/// is resolved by the caller (via the `env_obtain` seam), so this stays pure +
/// unit-testable (ITEM-22 / TEST-70).
pub fn environments_json(envs: &[EnvDigest], obtainable: &dyn Fn(&str) -> bool) -> String {
    let entries: Vec<serde_json::Value> = envs
        .iter()
        .map(|e| {
            serde_json::json!({
                "digest": format!("sha256:{}", e.digest),
                "arch": e.arch,
                "placement": env_placement(&e.digest),
                "obtain": env_obtain(&e.digest),
                "obtainable": obtainable(&e.digest),
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "schema": "txresbench.reproduce.environments/v1",
        "note": "Deployment-assisted (DEC-32): no public registry in v1. Place each \
                 rootfs.squashfs at its `placement` path, or obtain it from a running \
                 TxResBench by digest.",
        "environments": entries,
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

/// Build the `run.sh` + `inputs.json` + steps + environments for a sub-DAG.
pub fn build(runs: &[RunSpec], seed: i64) -> ReproduceScript {
    let order = topo_order(runs);
    let by_id: HashMap<Uuid, &RunSpec> = runs.iter().map(|r| (r.run_id, r)).collect();

    // Which internal run produced each output hash (to mark derived vs root inputs).
    let mut producer: HashSet<String> = HashSet::new();
    for r in runs {
        for h in &r.output_hashes {
            producer.insert(data_filename(h));
        }
    }

    let mut steps: Vec<Step> = Vec::new();
    for (n, run_id) in order.iter().enumerate() {
        let Some(r) = by_id.get(run_id) else { continue };
        let (ext, _interp) = lang_ext_interp(&r.language);
        let sha12 = r
            .code_sha256
            .as_deref()
            .map(|s| &s[..s.len().min(12)])
            .unwrap_or("manual");
        let script_name = format!("scripts/step_{n:02}_{sha12}.{ext}");
        // A slot may repeat (`multiple: true` binds one artifact per selection), and
        // each binding was staged at its OWN subpath. So the recorded
        // pairs are consumed as a QUEUE per slot, in order, rather than folded into a
        // `slot → subpath` map: a map keeps one entry per slot, so every binding of a
        // repeated slot would be handed the SAME path and the capsule would stage them
        // over each other — the runner's collision, faithfully reproduced downstream.
        let mut subpaths_by_slot: HashMap<&str, std::collections::VecDeque<&str>> = HashMap::new();
        for (slot, sub) in &r.input_subpaths {
            subpaths_by_slot
                .entry(slot.as_str())
                .or_default()
                .push_back(sub.as_str());
        }
        let inputs: Vec<StepInput> = r
            .inputs
            .iter()
            .map(|i| {
                let hex = data_filename(&i.content_hash);
                let subpath = subpaths_by_slot
                    .get_mut(i.slot.as_str())
                    .and_then(|q| q.pop_front())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| hex.clone());
                StepInput {
                    slot: i.slot.clone(),
                    kind: i.kind.clone(),
                    content_hash: i.content_hash.clone(),
                    subpath,
                    is_root: !producer.contains(&hex),
                    bound_by: i.bound_by.clone(),
                }
            })
            .collect();
        steps.push(Step {
            run_id: *run_id,
            kind: r.kind.clone(),
            code_sha256: r.code_sha256.clone(),
            script_name,
            language: r.language.clone(),
            env_digest: r.env_rootfs_sha256.as_ref().map(|d| data_filename(d)),
            arch: r.arch.clone(),
            seed: r.seed,
            params: r.params.clone(),
            work_dir: format!("work/{n:02}"),
            inputs,
            staged_shared_helpers: r.staged_shared_helpers,
        });
    }

    let environments = distinct_environments(runs);
    let run_sh = render_run_sh(&steps, seed);
    let inputs_json = render_inputs_json(&steps);

    ReproduceScript { run_sh, inputs_json, steps, environments }
}

/// The `inputs.json` entry for ONE step input — the SINGLE shape shared by the
/// bundle-root manifest ([`render_inputs_json`]) and the per-step
/// `$STEP/inputs/inputs.json` ([`step_inputs_json`]).
///
/// It is one function on purpose (ITEM-19). The two renderers previously carried
/// duplicate `json!` literals, and the failure mode that duplication invites is
/// exactly the one this change exists to fix: a fact added to one copy and silently
/// missing from the other, so the reader who opens the per-step file sees a different
/// record from the reader who opens the root one.
///
/// `bound_by` is OMITTED when unstated — never emitted as `null` or defaulted.
fn input_entry_json(i: &StepInput) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "slot": i.slot,
        "kind": i.kind,
        "content_hash": i.content_hash,
        "sandbox_path": format!("/inputs/{}", i.subpath),
    });
    if let (Some(origin), Some(map)) = (i.bound_by.as_deref(), entry.as_object_mut()) {
        map.insert("bound_by".to_string(), serde_json::Value::String(origin.to_string()));
    }
    entry
}

/// The bundle-relative `inputs.json` (a manifest of every step's slot→data map).
fn render_inputs_json(steps: &[Step]) -> String {
    let steps_json: Vec<serde_json::Value> = steps
        .iter()
        .map(|s| {
            let inputs: Vec<serde_json::Value> = s
                .inputs
                .iter()
                .map(input_entry_json)
                .collect();
            serde_json::json!({
                "run_id": s.run_id,
                "script": s.script_name,
                "env": s.env_digest.as_ref().map(|d| format!("sha256:{d}")),
                "inputs": inputs,
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "steps": steps_json }))
        .unwrap_or_default()
}

/// Render the full `run.sh` driver.
fn render_run_sh(steps: &[Step], seed: i64) -> String {
    let mut s = String::new();
    s.push_str("#!/usr/bin/env bash\n");
    s.push_str("# Reproducibility capsule — runs each recorded step INSIDE its pinned rootfs.\n");
    s.push_str("# Generated by TxResBench provenance export (ITEM-22). Do not edit by hand.\n");
    s.push_str("set -euo pipefail\n\n");
    s.push_str("HERE=\"$(cd \"$(dirname \"$0\")\" && pwd)\"\n");
    s.push_str("cd \"$HERE\"\n");
    s.push_str(&format!("SEED={seed}\n"));
    // Deterministic env (mirrors the sandbox harness — seed + single-thread BLAS).
    s.push_str("export PYTHONHASHSEED=0\n");
    s.push_str("export OMP_NUM_THREADS=1\n");
    s.push_str("export OPENBLAS_NUM_THREADS=1\n");
    s.push_str("export MKL_NUM_THREADS=1\n");
    s.push_str("export NUMEXPR_NUM_THREADS=1\n");
    s.push_str("export TXR_PROVENANCE_SEED=\"$SEED\"\n\n");

    s.push_str(RUNTIME_PREAMBLE);

    // Content-addressed store: seed with the bundled root data, then wire each
    // step's outputs back in by sha256 so a later step reads the REGENERATED file.
    s.push_str("CAS=\"$HERE/.cas\"; mkdir -p \"$CAS\"\n");
    s.push_str("if [ -d \"$HERE/data\" ]; then\n");
    s.push_str("  for f in \"$HERE\"/data/*; do\n");
    s.push_str("    [ -f \"$f\" ] || continue\n");
    s.push_str("    cp -f \"$f\" \"$CAS/$(basename \"$f\")\"\n");
    s.push_str("  done\n");
    s.push_str("fi\n\n");

    for (n, step) in steps.iter().enumerate() {
        s.push_str(&render_step(n, step));
    }

    s.push_str("echo \"Reproduce capsule complete. Outputs are under work/*/outputs.\"\n");
    s
}

/// The reusable bash preamble: runtime detection + the per-step run function that
/// mounts the pinned rootfs (no-Docker chain) and recreates the sandbox binds.
///
/// ## ROUND-18 (R18-03) — a directory artifact cannot CHAIN across capsule steps
///
/// `stage_input` is `cp -f "$CAS/$hex"`: flat files only. `index_outputs`
/// content-addresses every produced FILE (`find -type f`) and never the directory, so
/// no `.cas/<merkle-root>` entry can exist for a multi-file output. A closure in which
/// step 1 PRODUCES a directory artifact that step 2 CONSUMES therefore aborts at step
/// 2 — even when step 1 regenerated it byte-for-byte.
///
/// **Recorded, not fixed, and the reason is that it is fail-closed at two layers.**
/// Before the run: the exporter records a multi-file carried hash as a hole ("a
/// MULTI-FILE artifact — no single blob to embed"), which is folded by
/// `derive_roots_without_bytes` into `roots_have_provenance` → `readiness.ready:
/// false`, with the hash and the reason named in `readiness.json`'s `gaps` and
/// REPRODUCING.md's banner. During the run: `.cas/<hex>` does not exist, so the script
/// exits 1 naming the hash. Nothing can silently satisfy the hash — a divergent
/// regeneration cannot be mistaken for a match, because no comparison is attempted.
///
/// Fixing it is ONE change with `verify_outputs.sh`'s R3-24 `unsupported` class, not
/// two: both need the capsule to address a directory BY its merkle root, i.e. to carry
/// each multi-file artifact's member list + relative paths (which the bundle format
/// does not have today). Doing half of it — teaching `index_outputs` to synthesise a
/// root — reintroduces the false-match class R3-24 and ROUND-6/A4 closed.
const RUNTIME_PREAMBLE: &str = r#"# ---- runtime detection (prefer the no-Docker path the server used) ----
detect_runtime() {
  if command -v squashfuse >/dev/null 2>&1 && command -v bwrap >/dev/null 2>&1; then echo squashfuse-bwrap; return; fi
  if command -v apptainer >/dev/null 2>&1; then echo apptainer; return; fi
  if command -v singularity >/dev/null 2>&1; then echo singularity; return; fi
  if command -v docker >/dev/null 2>&1; then echo docker; return; fi
  if command -v podman >/dev/null 2>&1; then echo podman; return; fi
  if command -v unsquashfs >/dev/null 2>&1 && command -v proot >/dev/null 2>&1; then echo proot; return; fi
  echo none
}
RUNTIME="$(detect_runtime)"
if [ "$RUNTIME" = none ]; then
  echo "ERROR: no supported runtime found." >&2
  echo "Install ONE of (preferred first, no Docker): squashfuse + bubblewrap; apptainer/singularity; docker/podman; or unsquashfs + proot." >&2
  exit 1
fi
echo "Reproduce runtime: $RUNTIME"

# ---- FUSE mount bookkeeping: unmount every squashfuse mount on EXIT ----
# `set -e` makes a failing step abort the whole script mid-run; an EXIT trap
# guarantees we still tear down every squashfuse mount so a mid-step failure
# never leaks a FUSE daemon / dangling mountpoint. Idempotent (a mount already
# unmounted on the happy path just fails here → `|| true`).
_TXR_MOUNTS=()
_txr_cleanup() {
  local m
  for m in "${_TXR_MOUNTS[@]+"${_TXR_MOUNTS[@]}"}"; do
    [ -n "$m" ] || continue
    fusermount -u -z "$m" 2>/dev/null || fusermount3 -u -z "$m" 2>/dev/null || true
    rmdir "$m" 2>/dev/null || true
  done
}
trap _txr_cleanup EXIT

# ensure_env <digest>: the step's rootfs.squashfs must be present at env/<digest>/.
ensure_env() {
  local digest="$1"
  local sqfs="$HERE/env/$digest/rootfs.squashfs"
  if [ ! -f "$sqfs" ]; then
    echo "ERROR: required rootfs for digest sha256:$digest is not present." >&2
    echo "       expected at: env/$digest/rootfs.squashfs" >&2
    echo "       obtain it (see environments.json): from a running TxResBench, GET /api/sandbox/rootfs/$digest (authenticated)," >&2
    echo "       or copy the matching rootfs.squashfs to that path, then re-run ./run.sh." >&2
    exit 1
  fi
}

# stage_input <cas-hex> <dest>: copy a content-addressed object into the step inputs.
#
# FILE-ONLY BY DESIGN. A MULTI-FILE (directory) output's recorded hash is a merkle root
# over its members, and this capsule addresses objects by a file's sha256 only — so a
# directory artifact cannot be handed from one step to the next here, even when the
# earlier step regenerated it perfectly. That case stops below with the hash named; it
# is also declared BEFORE you run, as a gap in readiness.json (the capsule reports
# `"ready": false`) and in REPRODUCING.md. It is refused, never approximated.
stage_input() {
  local hex="$1" dest="$2"
  if [ ! -f "$CAS/$hex" ]; then
    echo "ERROR: input object sha256:$hex is not available (a bundled root may be a fetch.txt hole)." >&2
    echo "       see fetch.txt / data/ — obtain it and place it at .cas/$hex" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  cp -f "$CAS/$hex" "$dest"
}

# stage_helpers <code_dir>: copy the shared runtime modules the server stages into
# the code dir of every Python entry (scripts/helpers/, written by the exporter from
# the same table the live sandbox reads) in beside this step's entry script. A step
# whose script imports one of them cannot start without this: the sandbox assembles
# /code from the entry PLUS these, and the capsule used to carry the entry alone.
stage_helpers() {
  local dest="$1" f
  [ -d "$HERE/scripts/helpers" ] || return 0
  for f in "$HERE"/scripts/helpers/*; do
    [ -f "$f" ] || continue
    cp -f "$f" "$dest"/
  done
}

# index_outputs <dir>: content-address every produced file back into the CAS.
index_outputs() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local f h
  while IFS= read -r -d '' f; do
    h="$(sha256sum "$f" | cut -d' ' -f1)"
    cp -f "$f" "$CAS/$h"
  done < <(find "$dir" -type f -print0)
}

# run_in_env <digest> <interp> <entry> <inputs_dir> <outputs_dir> <code_dir> <home_dir>
# PATH must stay BYTE-EQUAL to the server's sandbox PATH (`sandbox.rs`'s bwrap
# prefix): the schema-5 OCI env image puts the scientific Python stack in a uv venv
# at /opt/venv (legacy schema-2 used /opt/conda). Omitting /opt/venv/bin resolved
# `python3` to the bare /usr/local/bin interpreter and every replayed step died on
# `ModuleNotFoundError: No module named 'numpy'`.
run_in_env() {
  local digest="$1" interp="$2" entry="$3" inp="$4" out="$5" code="$6" home="$7"
  local sqfs="$HERE/env/$digest/rootfs.squashfs"
  mkdir -p "$out" "$home"
  case "$RUNTIME" in
    squashfuse-bwrap)
      local mnt; mnt="$(mktemp -d)"
      _TXR_MOUNTS+=("$mnt")   # tracked so the EXIT trap unmounts it even on abort
      squashfuse "$sqfs" "$mnt"
      # bwrap recreates the exact server bind layout (rootfs usr/ → /usr, inputs/outputs/code).
      # `|| rc=$?` captures the exit code WITHOUT tripping `set -e` before cleanup —
      # otherwise a failing step would abort the script and leak the FUSE mount.
      local rc=0
      bwrap \
        --unshare-user --unshare-uts --unshare-ipc --unshare-pid --unshare-net --die-with-parent \
        --ro-bind "$mnt/usr" /usr \
        --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
        --ro-bind-try "$mnt/opt" /opt \
        --ro-bind-try "$mnt/etc/alternatives" /etc/alternatives \
        --ro-bind-try "$mnt/etc/R" /etc/R \
        --ro-bind-try "$mnt/etc/ssl/certs" /etc/ssl/certs \
        --dev /dev --proc /proc --tmpfs /tmp \
        --bind "$home" /home/analyst --chdir /home/analyst \
        --ro-bind "$inp" /inputs --bind "$out" /outputs --ro-bind "$code" /code \
        --setenv HOME /home/analyst --setenv USER analyst \
        --setenv PATH /opt/venv/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        --setenv LANG C.UTF-8 --setenv LC_ALL C.UTF-8 --setenv TERM dumb \
        --setenv PYTHONHASHSEED 0 --setenv OMP_NUM_THREADS 1 --setenv OPENBLAS_NUM_THREADS 1 \
        --setenv MKL_NUM_THREADS 1 --setenv NUMEXPR_NUM_THREADS 1 \
        --setenv TXR_PROVENANCE_SEED "$SEED" \
        -- "$interp" "$entry" || rc=$?
      fusermount -u -z "$mnt" 2>/dev/null || fusermount3 -u -z "$mnt" 2>/dev/null || true
      rmdir "$mnt" 2>/dev/null || true
      return $rc
      ;;
    apptainer|singularity)
      # Apptainer/Singularity can exec a raw squashfs image directly (no root, HPC).
      "$RUNTIME" exec --containall --writable-tmpfs \
        --bind "$inp":/inputs:ro --bind "$out":/outputs --bind "$code":/code:ro \
        --env PYTHONHASHSEED=0,OMP_NUM_THREADS=1,OPENBLAS_NUM_THREADS=1,MKL_NUM_THREADS=1,NUMEXPR_NUM_THREADS=1,TXR_PROVENANCE_SEED="$SEED" \
        "$sqfs" bash -lc "cd /home/analyst 2>/dev/null || cd /; $interp $entry"
      return $?
      ;;
    docker|podman)
      # Convenience path: import the squashfs rootfs as a local image (once) then run.
      local img="txresbench-rootfs:$digest"
      if ! "$RUNTIME" image inspect "$img" >/dev/null 2>&1; then
        local ex; ex="$(mktemp -d)"
        unsquashfs -f -d "$ex/root" "$sqfs" >/dev/null
        tar -C "$ex/root" -c . | "$RUNTIME" import - "$img" >/dev/null
        rm -rf "$ex"
      fi
      "$RUNTIME" run --rm --network=none \
        -e PYTHONHASHSEED=0 -e OMP_NUM_THREADS=1 -e OPENBLAS_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
        -e NUMEXPR_NUM_THREADS=1 -e TXR_PROVENANCE_SEED="$SEED" \
        -e PATH=/opt/venv/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        -v "$inp":/inputs:ro -v "$out":/outputs -v "$code":/code:ro \
        -w /home/analyst "$img" "$interp" "$entry"
      return $?
      ;;
    proot)
      # No-root, no-container: extract the rootfs once and proot into it.
      local rootdir="$HERE/env/$digest/rootfs.d"
      if [ ! -d "$rootdir" ]; then unsquashfs -f -d "$rootdir" "$sqfs" >/dev/null; fi
      PYTHONHASHSEED=0 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
      NUMEXPR_NUM_THREADS=1 TXR_PROVENANCE_SEED="$SEED" \
      PATH=/opt/venv/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        proot -r "$rootdir" -b "$inp":/inputs -b "$out":/outputs -b "$code":/code -w /home/analyst \
        "$interp" "$entry"
      return $?
      ;;
    *)
      echo "ERROR: unhandled runtime $RUNTIME" >&2; return 1
      ;;
  esac
}

"#;

/// Render one step of `run.sh`.
fn render_step(n: usize, step: &Step) -> String {
    let mut s = String::new();
    let (_ext, interp) = lang_ext_interp(&step.language);
    // The comment line can't be single-quoted; a newline in `kind` would break out
    // of the `#` comment and inject a line, so strip control chars for it. (`run_id`
    // is a Uuid — hex+dashes, inherently safe.)
    let kind_comment: String =
        step.kind.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    s.push_str(&format!(
        "# ---- step {n:02}: {kind_comment} (run {}) ----\n",
        step.run_id
    ));

    // A step with no captured code (interaction/promote) or no pinned rootfs is
    // recorded but not executable in a rootfs — note it and skip.
    let Some(env_digest) = &step.env_digest else {
        s.push_str(&format!(
            "echo \"[step {n:02}] \"{}\" — no pinned environment (not executed; provenance-only node)\"\n\n",
            sh_squote(&step.kind)
        ));
        return s;
    };
    if step.code_sha256.is_none() {
        s.push_str(&format!(
            "echo \"[step {n:02}] \"{}\" — no captured code (not executed; manual step)\"\n\n",
            sh_squote(&step.kind)
        ));
        return s;
    }

    let wd = &step.work_dir;
    s.push_str(&format!("STEP=\"$HERE/{wd}\"\n"));
    s.push_str("rm -rf \"$STEP\"; mkdir -p \"$STEP/inputs\" \"$STEP/outputs\" \"$STEP/code\" \"$STEP/home\"\n");
    // Stage the pulled per-step script into /code with the language-correct name.
    // Every interpolated path/name is single-quoted (`sh_squote`) so a crafted
    // filename can't break out of the shell command (defense against injection).
    let (ext, _i) = lang_ext_interp(&step.language);
    s.push_str(&format!(
        "cp -f \"$HERE/\"{} \"$STEP/code/entry.{ext}\"\n",
        sh_squote(&step.script_name)
    ));
    // …and, for a Python step, the SHARED runtime modules that the live sandbox
    // stages beside every Python entry. The recorded code blob is the entry ALONE, so
    // without this a step whose script imports one of them dies at process start with
    // `ModuleNotFoundError` — the failure this branch's own migrated processors all
    // reached. The names are not repeated here: the exporter wrote whatever the
    // server's one table says, and this copies exactly that.
    if step_stages_helpers(step) {
        s.push_str("stage_helpers \"$STEP/code\"\n");
    }
    // Stage each input from the CAS at its original /inputs subpath.
    for i in &step.inputs {
        let hex = data_filename(&i.content_hash);
        s.push_str(&format!(
            "stage_input {} \"$STEP/inputs/\"{}\n",
            sh_squote(&hex),
            sh_squote(&i.subpath)
        ));
    }
    // Recreate /inputs/inputs.json + /inputs/params.json (the derived contract).
    let inputs_json = step_inputs_json(step);
    s.push_str("cat > \"$STEP/inputs/inputs.json\" <<'TXR_INPUTS_JSON'\n");
    s.push_str(&inputs_json);
    s.push_str("\nTXR_INPUTS_JSON\n");
    // ITEM-3: the REAL params (`spec.params ∪ {"seed": N}`), built through the SAME
    // `sandbox::inputs::params_json_value` the live runtime writes, so the capsule's
    // `/inputs/params.json` is byte-identical to the one the recorded run consumed.
    // Emitted through a QUOTED heredoc (the `TXR_INPUTS_JSON` pattern two lines
    // above), NOT a `printf` with an interpolated literal: a param value may carry
    // a `'`, `$(…)`, a backtick, or a newline, and a quoted heredoc makes every byte
    // literal (matching this file's `sh_squote` injection posture).
    s.push_str("cat > \"$STEP/inputs/params.json\" <<'TXR_PARAMS_JSON'\n");
    s.push_str(&step_params_json(step));
    s.push_str("\nTXR_PARAMS_JSON\n");
    // Ensure the environment is present, then run inside it (digest single-quoted).
    s.push_str(&format!("ensure_env {}\n", sh_squote(env_digest)));
    s.push_str(&format!(
        "echo \"[step {n:02}] running \"{}\" in sha256:\"{}\" (\"{}\")\"\n",
        sh_squote(&step.kind),
        sh_squote(env_digest),
        sh_squote(&step.arch.clone().unwrap_or_else(|| "unknown-arch".to_string()))
    ));
    s.push_str(&format!(
        "run_in_env {} \"{interp}\" \"/code/entry.{ext}\" \
         \"$STEP/inputs\" \"$STEP/outputs\" \"$STEP/code\" \"$STEP/home\"\n",
        sh_squote(env_digest)
    ));
    // Wire this step's outputs back into the CAS (content-addressed) for the next step.
    s.push_str("index_outputs \"$STEP/outputs\"\n\n");
    s
}

/// The per-step `/inputs/inputs.json` body (matches the sandbox `inputs.rs` shape:
/// hash + kind + sandbox path, path-agnostic).
fn step_inputs_json(step: &Step) -> String {
    let entries: Vec<serde_json::Value> = step
        .inputs
        .iter()
        .map(input_entry_json)
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "inputs": entries }))
        .unwrap_or_else(|_| "{ \"inputs\": [] }".to_string())
}

/// The per-step `/inputs/params.json` body (ITEM-3) — the run's SCIENTIFIC params
/// with its seed merged in.
///
/// Byte-compatibility with the live runtime is STRUCTURAL, not conventional: the
/// value is built by `sandbox::inputs::params_json_value` (the exact function
/// `materialize_inputs` uses to write `/inputs/params.json`) and rendered with the
/// same `serde_json` pretty-printer, so the same params + seed produce the same
/// bytes on both sides. Key ORDER is whatever `serde_json::Map` yields with `seed`
/// inserted last — never hand-formatted.
fn step_params_json(step: &Step) -> String {
    let value = crate::modules::sandbox::inputs::params_json_value(&step.params, step.seed);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{ \"seed\": 0 }".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(slot: &str, kind: &str, hash: &str) -> UsedEdgeDto {
        UsedEdgeDto {
            slot: slot.into(),
            kind: kind.into(),
            ref_id: None,
            content_hash: hash.into(),
            bound_by: None,
        }
    }

    fn run(
        id: Uuid,
        lang: &str,
        code: &str,
        env: Option<&str>,
        arch: &str,
        inputs: Vec<UsedEdgeDto>,
        outputs: Vec<&str>,
        subpaths: Vec<(&str, &str)>,
    ) -> RunSpec {
        RunSpec {
            run_id: id,
            kind: "compute".into(),
            code_sha256: Some(code.into()),
            inputs,
            output_hashes: outputs.into_iter().map(|s| s.to_string()).collect(),
            language: lang.into(),
            env_rootfs_sha256: env.map(|s| s.into()),
            arch: Some(arch.into()),
            seed: Some(7),
            input_subpaths: subpaths.into_iter().map(|(a, b)| (a.into(), b.into())).collect(),
            params: serde_json::json!({}),
            // The `code_ref` shape (R19-03): a Python entry the live path staged into.
            staged_shared_helpers: lang_ext_interp(lang).0 == "py",
        }
    }

    /// A REPEATED slot (`multiple: true` — QC's `matrices` binds one artifact per
    /// modality) keeps ONE SUBPATH PER BINDING in the capsule.
    ///
    /// The runner disambiguates a repeated slot's mounts (`inputs::unique_mount_name`) and
    /// the recorder now stores that per-binding record, so the export receives several
    /// `input_subpaths` entries sharing a slot. Folding those into a `slot → subpath` map
    /// — which this function did — keeps ONE of them and hands it to every binding, so the
    /// capsule stages the second artifact over the first and the replayed step reads one
    /// input twice under two modality prefixes. Distinct names, distinct bytes, distinct
    /// `sandbox_path`s in the regenerated `/inputs/inputs.json`, or the capsule silently
    /// reproduces something the run never did.
    #[test]
    fn a_repeated_slot_keeps_one_subpath_per_binding() {
        let u = Uuid::new_v4();
        let spec = run(
            u,
            "python",
            "c0",
            Some("d1"),
            "x86_64",
            vec![
                edge("matrices", "upload", "sha256:aa"),
                edge("matrices", "upload", "sha256:bb"),
            ],
            vec![],
            vec![("matrices", "matrices.zarr"), ("matrices", "matrices_1.zarr")],
        );
        let out = build(&[spec], 0);
        let step = &out.steps[0];

        assert_eq!(step.inputs.len(), 2, "both bindings survive into the step");
        assert_eq!(
            step.inputs.iter().map(|i| i.subpath.as_str()).collect::<Vec<_>>(),
            vec!["matrices.zarr", "matrices_1.zarr"],
            "each binding keeps ITS OWN recorded subpath, in binding order — a map keyed \
             on the slot hands both the same one"
        );
        // …and the pairing is content-correct: the recorded order is the binding order on
        // BOTH sides, so binding 0's subpath must belong to binding 0's content.
        assert_eq!(step.inputs[0].content_hash, "sha256:aa");
        assert_eq!(step.inputs[1].content_hash, "sha256:bb");

        // The two files the capsule actually writes must agree, or the defect just moves.
        let per_step: serde_json::Value =
            serde_json::from_str(&step_inputs_json(step)).expect("per-step inputs.json parses");
        let paths: Vec<&str> = per_step["inputs"]
            .as_array()
            .expect("inputs")
            .iter()
            .map(|e| e["sandbox_path"].as_str().expect("sandbox_path"))
            .collect();
        assert_eq!(paths, vec!["/inputs/matrices.zarr", "/inputs/matrices_1.zarr"]);
        assert!(
            out.run_sh.contains("matrices.zarr") && out.run_sh.contains("matrices_1.zarr"),
            "run.sh — the half a third party executes — stages BOTH: {}",
            out.run_sh
        );

        // An UNRECORDED slot still falls back to the bare-hex data name (the legacy
        // answer), and the fallback is per-binding too: two unrecorded bindings must not
        // collapse onto one name either.
        let bare = run(
            Uuid::new_v4(),
            "python",
            "c1",
            Some("d1"),
            "x86_64",
            vec![
                edge("matrices", "upload", "sha256:cc"),
                edge("matrices", "upload", "sha256:dd"),
            ],
            vec![],
            vec![],
        );
        let out2 = build(&[bare], 0);
        let subs: Vec<&str> =
            out2.steps[0].inputs.iter().map(|i| i.subpath.as_str()).collect();
        assert_eq!(subs, vec!["cc", "dd"], "the hash fallback is per-binding");
    }

    // TEST-39 [ITEM-22]: the generated run.sh runs each step INSIDE its pinned
    // rootfs (recreating data→/inputs, code→/code, /outputs), is language-aware
    // (python3/Rscript/bash), wires outputs→inputs by content hash across steps,
    // and emits the runtime-detect preamble. environments.json lists the distinct
    // digests with placement/obtain/obtainable.
    #[test]
    fn run_sh_runs_each_step_in_its_pinned_env_language_aware() {
        let u = Uuid::new_v4(); // python step under env D1 → produces o1
        let t = Uuid::new_v4(); // R step under env D2 consuming o1
        let runs = vec![
            run(t, "r", "bbbbbbbbbbbbbb", Some("d2d2d2d2d2d2d2d2"), "x86_64",
                vec![edge("counts", "artifact", "sha256:o1")], vec!["sha256:t1"],
                vec![("counts", "counts.h5ad")]),
            run(u, "python", "aaaaaaaaaaaaaa", Some("d1d1d1d1d1d1d1d1"), "x86_64",
                vec![edge("expression", "dataset", "sha256:root")], vec!["sha256:o1"],
                vec![("expression", "expression.h5ad")]),
        ];
        let out = build(&runs, 42);

        // Topological order: the python producer precedes the R consumer.
        let order = topo_order(&runs);
        assert_eq!(order, vec![u, t], "u (producer) precedes t (consumer)");
        let idx_u = out.run_sh.find("aaaaaaaaaaaa").unwrap();
        let idx_t = out.run_sh.find("bbbbbbbbbbbb").unwrap();
        assert!(idx_u < idx_t, "steps in topo order");

        // Language-aware script names + interpreters.
        assert!(out.steps[0].script_name.ends_with(".py"), "python → .py");
        assert!(out.steps[1].script_name.ends_with(".R"), "rscript → .R");
        assert!(out.run_sh.contains("python3"), "python interpreter");
        assert!(out.run_sh.contains("Rscript"), "R interpreter");

        // Runs INSIDE the pinned rootfs (per-step digest) with the sandbox binds.
        // The digest is single-quoted (shell-injection guard, `sh_squote`).
        assert!(out.run_sh.contains("run_in_env 'd1d1d1d1d1d1d1d1'"), "step 0 runs in D1");
        assert!(out.run_sh.contains("run_in_env 'd2d2d2d2d2d2d2d2'"), "step 1 runs in D2");
        assert!(out.run_sh.contains("ensure_env 'd1d1d1d1d1d1d1d1'"), "step 0 ensures D1 present");
        assert!(out.run_sh.contains("--ro-bind \"$mnt/usr\" /usr"), "rootfs usr/ bound at /usr");
        assert!(out.run_sh.contains("--ro-bind \"$inp\" /inputs"), "inputs→/inputs");
        assert!(out.run_sh.contains("--bind \"$out\" /outputs"), "outputs→/outputs");
        assert!(out.run_sh.contains("--ro-bind \"$code\" /code"), "code→/code");

        // Runtime-detect preamble (no-Docker chain), determinism preamble.
        assert!(out.run_sh.contains("detect_runtime"), "runtime detection");
        assert!(out.run_sh.contains("squashfuse-bwrap"), "prefers squashfuse+bwrap");
        assert!(out.run_sh.contains("apptainer") && out.run_sh.contains("proot"), "fallback chain");
        assert!(out.run_sh.contains("PYTHONHASHSEED=0"), "seed/thread pins");
        assert!(out.run_sh.contains("index_outputs"), "wires outputs→inputs by content hash");

        // /inputs contract: inputs.json + params.json recreated; original subpath used.
        assert!(out.run_sh.contains("expression.h5ad"), "input bound at its original subpath");
        assert!(out.run_sh.contains("inputs.json"), "per-step inputs.json recreated");
        assert!(out.run_sh.contains("params.json"), "per-step params.json recreated");

        // environments.json: two distinct digests, sorted, with placement + obtainable.
        let envs = &out.environments;
        assert_eq!(envs.len(), 2, "two distinct rootfs environments");
        let all_obtainable = environments_json(envs, &|_| true);
        assert!(all_obtainable.contains("\"digest\": \"sha256:d1d1d1d1d1d1d1d1\""));
        assert!(all_obtainable.contains("env/d1d1d1d1d1d1d1d1/rootfs.squashfs"), "placement path");
        assert!(all_obtainable.contains("/api/sandbox/rootfs/d2d2d2d2d2d2d2d2"), "obtain instruction");
        assert!(all_obtainable.contains("\"arch\": \"x86_64\""));
        assert!(all_obtainable.contains("\"obtainable\": true"));
        // A GC'd digest is reported not-obtainable (drives readiness — TEST-70).
        let d1_gone = environments_json(envs, &|d| d != "d1d1d1d1d1d1d1d1");
        assert!(d1_gone.contains("\"obtainable\": false"), "a GC'd digest → obtainable=false");
    }

    /// `run.sh` stages the shared runtime modules into the code dir of each PYTHON
    /// step, and of nothing else.
    ///
    /// The recorded blob is one entry file, and the sandbox `/code` a run really saw
    /// is that entry PLUS those modules. The capsule reproduced only the first half,
    /// so a step whose script imports one stopped at process start with an import
    /// error — inside a rootfs, where nothing in this suite was looking. That failure
    /// mode is exactly why this is asserted on the RENDERED script (the shape that
    /// runs) rather than on the decision function alone.
    ///
    /// The negative half is load-bearing too: giving a non-Python step files its
    /// recorded run never had in `/code` is not a safer default, it is a different
    /// run.
    ///
    /// **ROUND-19 (R19-03) — read the NAME as shorthand, not as the rule.** The
    /// decision is [`step_stages_helpers`], which now reads the recorded
    /// [`Step::staged_shared_helpers`] (what the run's `/code` actually held); the
    /// fixture below sets it to the `code_ref` shape, so this test pins the RENDERING —
    /// `stage_helpers` appears in a staging step's script and in no other. A Python
    /// step whose run staged nothing is covered by the decision function's own test in
    /// `bundle.rs`, since it is invisible in the rendered shape (both render nothing).
    #[test]
    fn run_sh_stages_the_shared_runtime_modules_for_python_steps_only() {
        let step = |lang: &str| Step {
            run_id: Uuid::new_v4(),
            kind: "compute".into(),
            code_sha256: Some("aa".into()),
            script_name: "scripts/step_00_x".into(),
            language: lang.into(),
            env_digest: Some("d1d1".into()),
            arch: Some("x86_64".into()),
            seed: Some(0),
            params: serde_json::json!({}),
            work_dir: "work/00".into(),
            inputs: vec![],
            // R19-03: the `code_ref` shape — what the live path staged for this
            // language. The decision is the RECORDED fact now, not the language.
            staged_shared_helpers: lang_ext_interp(lang).0 == "py",
        };
        let call = "stage_helpers \"$STEP/code\"";

        // The preamble DEFINES the staging function…
        assert!(
            RUNTIME_PREAMBLE.contains("stage_helpers() {"),
            "the preamble defines the staging function"
        );
        assert!(
            RUNTIME_PREAMBLE.contains(HELPER_MEMBER_PREFIX.trim_end_matches('/')),
            "…reading the prefix the assembler writes ({HELPER_MEMBER_PREFIX})"
        );

        // …a PYTHON step invokes it, into its OWN code dir, BEFORE it executes.
        let py = render_step(0, &step("python"));
        let at = |needle: &str| py.find(needle);
        assert_eq!(py.matches(call).count(), 1, "one invocation:\n{py}");
        assert!(at("entry.py") < at(call), "after the entry:\n{py}");
        assert!(at(call) < at("run_in_env"), "before it runs:\n{py}");

        // …and a step in any other language does NOT: putting files in /code that
        // the recorded run never had there is a different run, not a safer one.
        for lang in ["r", "bash"] {
            let other = render_step(1, &step(lang));
            assert!(!other.contains(call), "{lang} step stages none:\n{other}");
        }
    }

    // A manual/interaction node (no code, no env) is a provenance-only step — it is
    // NOT executed, but the chain still lists it (no crash, no invocation).
    #[test]
    fn provenance_only_node_is_not_executed() {
        let p = Uuid::new_v4();
        let runs = vec![RunSpec {
            run_id: p,
            kind: "promote".into(),
            code_sha256: None,
            inputs: vec![edge("source", "artifact", "sha256:a")],
            output_hashes: vec!["sha256:ds".into()],
            language: "bash".into(),
            env_rootfs_sha256: None,
            arch: None,
            seed: Some(0),
            input_subpaths: vec![],
            params: serde_json::json!({}),
            staged_shared_helpers: false,
        }];
        let out = build(&runs, 0);
        assert!(out.run_sh.contains("not executed"), "a no-env node is skipped");
        // An actual invocation is `run_in_env '<digest>'` (single-quoted); the
        // preamble's `# run_in_env <digest>` doc comment is NOT a real invocation.
        assert!(!out.run_sh.contains("run_in_env '"), "no run invocation for a provenance-only node");
        assert!(out.environments.is_empty(), "no environment to obtain");
    }

    // Finding-3 regression: a `validate_subpath`-clean but shell-hostile input
    // subpath (legal filename bytes: `$(...)`, backtick, `;`, `"`) is single-quoted
    // in `run.sh`, so it can NEVER break out of the shell command to inject code.
    #[test]
    fn input_subpath_is_shell_escaped_no_injection() {
        // These are all valid single path components (no `/`, `..`, absolute), so
        // `validate_subpath` accepts them — yet each is a shell-injection attempt.
        let evil = "x$(touch /tmp/pwned).h5ad";
        let run_id = Uuid::new_v4();
        let runs = vec![run(
            run_id,
            "python",
            "aaaaaaaaaaaaaa",
            Some("d1d1d1d1d1d1d1d1"),
            "x86_64",
            vec![edge("expression", "dataset", "sha256:root")],
            vec!["sha256:o1"],
            vec![("expression", evil)],
        )];
        let out = build(&runs, 42);

        // The raw metacharacters appear only inside a single-quoted token — the
        // command-substitution `$(...)` is inert (single quotes suppress it).
        assert!(
            out.run_sh.contains("\"$STEP/inputs/\"'x$(touch /tmp/pwned).h5ad'"),
            "the hostile subpath is single-quoted, not left bare"
        );
        // It must NOT appear unquoted after `/inputs/` (the injectable form).
        assert!(
            !out.run_sh.contains("$STEP/inputs/x$(touch"),
            "the subpath is never interpolated unquoted into the command"
        );
        // A `'` in a value is closed/escaped/reopened (`'\''`), never left dangling.
        let quoted = sh_squote("a'b");
        assert_eq!(quoted, "'a'\\''b'");
    }

    // TEST-PARAMS-RENDER [ITEM-1/2/3] — the G3 regression guard at the unit layer:
    // the generated `run.sh` regenerates the run's REAL scientific params into
    // `/inputs/params.json`, not the seed alone.
    //
    // BEFORE the fix this line was literally
    //   printf '%s\n' '{ "seed": 7 }' > "$STEP/inputs/params.json"
    // so a replay re-ran `cell.filter` with NO `criteria` → an all-true mask →
    // a silently wrong answer that still "succeeded". The `criteria`/`label`
    // assertions below are exactly what the old renderer could not satisfy.
    #[test]
    fn run_sh_regenerates_the_real_params_not_just_the_seed() {
        let mut r = run(
            Uuid::new_v4(),
            "python",
            "sha256:code",
            Some("d1d1d1d1d1d1d1d1"),
            "x86_64",
            vec![edge("expression", "dataset", "sha256:root")],
            vec!["sha256:o1"],
            vec![("expression", "expression.h5ad")],
        );
        r.params = serde_json::json!({
            "criteria": [{ "column": "total_counts", "min": 1500 }],
            "label": "subset",
        });
        let out = build(&[r.clone()], 0);

        // The predicate itself reaches the capsule.
        assert!(out.run_sh.contains("\"criteria\""), "the criteria reach params.json:\n{}", out.run_sh);
        assert!(out.run_sh.contains("\"total_counts\""), "the filtered column reaches params.json");
        assert!(out.run_sh.contains("\"min\": 1500"), "the threshold reaches params.json");
        assert!(out.run_sh.contains("\"label\": \"subset\""), "the mask label reaches params.json");
        // The run's own seed is still merged in (and wins).
        assert!(out.run_sh.contains("\"seed\": 7"), "the seed is still written");
        // The OLD seed-only renderer is gone.
        assert!(
            !out.run_sh.contains("printf '%s\\n' '{ \"seed\""),
            "the seed-only printf renderer must not survive"
        );
        // Written through a QUOTED heredoc, so a `'`/`$(…)`/backtick in a param
        // value is inert (same posture as TXR_INPUTS_JSON).
        assert!(out.run_sh.contains("<<'TXR_PARAMS_JSON'"), "params ride a quoted heredoc");

        // BYTE-COMPATIBILITY with the live runtime: the heredoc body is exactly
        // what `sandbox::inputs` writes to /inputs/params.json for the same
        // (params, seed) — the two are one function, not two conventions.
        let body = out
            .run_sh
            .split("<<'TXR_PARAMS_JSON'\n")
            .nth(1)
            .and_then(|s| s.split("\nTXR_PARAMS_JSON\n").next())
            .expect("the params heredoc body");
        let live = serde_json::to_string_pretty(
            &crate::modules::sandbox::inputs::params_json_value(&r.params, r.seed),
        )
        .unwrap();
        assert_eq!(body, live, "the capsule's params.json is byte-identical to the runtime's");

        // A params-less run degrades to today's seed-only body (no regression).
        let mut bare = r.clone();
        bare.params = serde_json::json!({});
        assert!(build(&[bare], 0).run_sh.contains("\"seed\": 7"));
    }

    // Finding-6 regression: the generated `run.sh` installs an EXIT trap that
    // unmounts every tracked squashfuse mount, and the bwrap invocation captures
    // its exit code with `|| rc=$?` so a failing step can't abort before cleanup.
    #[test]
    fn run_sh_traps_and_unmounts_on_exit() {
        let runs = vec![run(
            Uuid::new_v4(),
            "python",
            "aaaaaaaaaaaaaa",
            Some("d1d1d1d1d1d1d1d1"),
            "x86_64",
            vec![edge("expression", "dataset", "sha256:root")],
            vec!["sha256:o1"],
            vec![("expression", "expression.h5ad")],
        )];
        let out = build(&runs, 42);
        assert!(out.run_sh.contains("trap _txr_cleanup EXIT"), "an EXIT cleanup trap is installed");
        assert!(out.run_sh.contains("_TXR_MOUNTS+=(\"$mnt\")"), "each mount is tracked for cleanup");
        assert!(
            out.run_sh.contains("-- \"$interp\" \"$entry\" || rc=$?"),
            "bwrap failure is captured (|| rc=$?), not left to abort before unmount"
        );
    }

    // topo_order + language default: an unknown language defaults to a bash entry.
    #[test]
    fn unknown_language_defaults_to_bash() {
        assert_eq!(lang_ext_interp("python"), ("py", "python3"));
        assert_eq!(lang_ext_interp("r"), ("R", "Rscript"));
        assert_eq!(lang_ext_interp("rscript"), ("R", "Rscript"));
        assert_eq!(lang_ext_interp("bash"), ("sh", "bash"));
        assert_eq!(lang_ext_interp("weird"), ("sh", "bash"));
    }
}
