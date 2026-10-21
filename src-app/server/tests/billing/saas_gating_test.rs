//! TEST-8 [acceptance][INV-5][covers ITEM-1, ITEM-10]: **billing surfaces compile
//! out of desktop; the MODEL does not.**
//!
//! Two halves:
//!  - saas-OFF (this source-grep, which runs in the DEFAULT build): `modules/mod.rs`
//!    wraps `pub mod billing;` in `#[cfg(feature = "saas")]` (so the module, the
//!    Stripe client, the routes + the `MODULE_ENTRIES` registration are absent on
//!    desktop), while the `accounts` billing-columns MIGRATION carries NO saas gate
//!    (the columns exist in BOTH builds).
//!  - saas-ON: the in-source `billing::mod` test (`billing_module_registers_under_saas`)
//!    compiles only under the feature and asserts the `MODULE_ENTRIES` entry registers
//!    — its very existence is the saas-on proof.
//!
//! A source-grep is the codebase's established removal/compile-out proof pattern
//! (mirrors `account/saas_gating_test.rs`).

use std::path::PathBuf;

fn read(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Normalize whitespace so `cfg(feature="saas")` and `cfg(feature = "saas")` both match.
fn has_saas_cfg(src: &str) -> bool {
    let squashed: String = src.chars().filter(|c| !c.is_whitespace()).collect();
    squashed.contains("cfg(feature=\"saas\")")
}

/// Drop whole-line `//` comments (a line whose first non-whitespace is `//`) so a
/// source-grep asserts on CODE, not on comment PROSE. Blind audit round 1 found the
/// guard-shape greps below were EVADABLE: a doc/comment line that merely MENTIONS
/// `from_env_opt` satisfied a `contains("from_env_opt")` check even if the real guard
/// were deleted — the test guarded the syntax, not the state. Stripping the comment
/// lines first means the token must appear in real code. (URLs like `https://…` are
/// never at line-start, so this line-based strip does not truncate string literals in
/// the regions scanned.)
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The billing MODULE is saas-gated at its declaration — a desktop build never
/// compiles a single billing symbol.
#[test]
fn billing_module_declaration_is_saas_gated() {
    let modrs = read("src/modules/mod.rs");
    // The `pub mod billing;` line must be immediately preceded by a saas cfg. Find the
    // decl and require a `cfg(feature="saas")` within the few lines above it.
    let idx = modrs
        .find("pub mod billing;")
        .expect("modules/mod.rs declares `pub mod billing;`");
    let preceding = &modrs[..idx];
    // The nearest attribute line above the decl.
    let window: String = preceding
        .lines()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        has_saas_cfg(&window),
        "`pub mod billing;` must be wrapped in #[cfg(feature = \"saas\")] so billing \
         compiles OUT of the desktop/default build (INV-5). Context above the decl:\n{window}"
    );
}

/// The `accounts` billing-columns migration is NOT saas-gated (it is a plain .sql
/// applied by build.rs in BOTH builds) — the billing COLUMNS exist on desktop too,
/// with their safe defaults (`plan_id='free'`, `subscription_status='active'`). A
/// migration file cannot carry a cargo cfg anyway; this asserts the design fact that
/// the ALTER lives in a normal migration (scanned regardless of the feature) and adds
/// the four §3.5 columns with their defaults.
#[test]
fn accounts_billing_columns_exist_unconditionally() {
    let sql = read("src/modules/billing/migrations/202608260003_billing_accounts_columns.sql");
    for col in [
        "stripe_customer_id",
        "plan_id",
        "subscription_status",
        "grace_until",
    ] {
        assert!(
            sql.contains(col),
            "the billing-owned ALTER must add `{col}` to accounts (present in both builds)"
        );
    }
    // The safe defaults the desktop build leaves in place (INV-5).
    assert!(sql.contains("DEFAULT 'free'"), "plan_id defaults to 'free'");
    assert!(
        sql.contains("DEFAULT 'active'"),
        "subscription_status defaults to 'active'"
    );
}

// TEST-7 [acceptance][INV-5][covers ITEM-1, ITEM-10]: B3's webhook + dunning code + the
// `hmac` signature dep compile OUT of the desktop/default build. The whole `billing` module
// is saas-gated at its `pub mod billing;` declaration (asserted above), so its members
// (`webhook.rs` / `dunning.rs`) are gated with it; here we prove those members EXIST as part
// of that gated module, and that `hmac` is reachable ONLY under the `saas` feature.

/// `billing/{webhook,dunning}.rs` are declared members of the (saas-gated) `billing` module —
/// so the webhook route + the state machine live behind the same feature that gates the module.
#[test]
fn webhook_and_dunning_are_saas_gated_billing_members() {
    let modrs = read("src/modules/billing/mod.rs");
    for decl in ["pub mod webhook;", "pub mod dunning;"] {
        assert!(
            modrs.contains(decl),
            "billing/mod.rs must declare `{decl}` (a member of the saas-gated billing module)"
        );
    }
    // Sanity: the files exist and carry the sig-verify / state-machine code.
    assert!(
        read("src/modules/billing/webhook.rs").contains("verify_signature"),
        "webhook.rs holds the signature verify"
    );
    assert!(
        read("src/modules/billing/dunning.rs").contains("fn next_state"),
        "dunning.rs holds the state machine"
    );
}

/// B4 (INV-5): the quota decision fn + the usage-alert ladder are declared members of the
/// (saas-gated) `billing` module — so `check_quota`, the alert loop, the spend-cap store and
/// the `/api/billing/quota*` routes compile OUT of the desktop/default build with the module.
/// A desktop build never checks a quota (the compute-T6 call sites are also saas-gated).
#[test]
fn quota_and_alerts_are_saas_gated_billing_members() {
    let modrs = read("src/modules/billing/mod.rs");
    for decl in ["pub mod quota;", "pub mod alerts;"] {
        assert!(
            modrs.contains(decl),
            "billing/mod.rs must declare `{decl}` (a member of the saas-gated billing module)"
        );
    }
    // Sanity: the files exist and carry the decision fn + the ladder.
    assert!(
        read("src/modules/billing/quota.rs").contains("pub async fn check_quota"),
        "quota.rs holds the check_quota decision fn (PROV-B4-1)"
    );
    assert!(
        read("src/modules/billing/alerts.rs").contains("pub const ALERT_LADDER"),
        "alerts.rs holds the usage-alert ladder"
    );
}

/// #36 TEST-4 [acceptance][INV-4][covers ITEM-1, ITEM-5]: the admin read-any-account billing
/// surface is a member of the (saas-gated) `billing` module — so the `AdminBillingScope`
/// extractor + the `/api/admin/accounts/{id}/{billing,usage,quota}` routes compile OUT of the
/// desktop/default build with the module, and no `billing::admin` / Stripe symbol leaks there.
/// A desktop build never mounts a cross-account billing read (the whole billing module, self-
/// serve AND admin, is absent). Source-grep — runs in the DEFAULT build (imports no billing code).
#[test]
fn admin_billing_read_is_a_saas_gated_billing_member() {
    let modrs = read("src/modules/billing/mod.rs");
    assert!(
        modrs.contains("pub mod admin;"),
        "billing/mod.rs must declare `pub mod admin;` (a member of the saas-gated billing module)"
    );
    // The module is mounted inside billing's register_routes (behind the §16 kill-switch, with
    // the self-serve routes) — so it rides the same saas + config gate.
    assert!(
        strip_line_comments(&modrs).contains("admin::admin_billing_routes()"),
        "billing/register_routes must merge `admin::admin_billing_routes()` so the admin billing \
         reads mount only in a saas binary with Stripe configured"
    );
    // Sanity: the file exists and carries the extractor + the three path-scoped read routes.
    let admin = read("src/modules/billing/admin.rs");
    assert!(
        admin.contains("pub struct AdminBillingScope"),
        "admin.rs holds the billing::admin-gated path-scoped extractor"
    );
    for route in [
        "/admin/accounts/{account_id}/billing",
        "/admin/accounts/{account_id}/usage",
        "/admin/accounts/{account_id}/quota",
    ] {
        assert!(
            admin.contains(route),
            "admin.rs declares the `{route}` read route (saas-gated with the module)"
        );
    }
    // It gates on billing::admin (the cross-account key), NOT the self-serve manage key.
    assert!(
        admin.contains("BillingAdmin::PERMISSION"),
        "the admin billing reads gate on `billing::admin` (BillingAdmin), not the self-serve key"
    );
}

/// `hmac` is an OPTIONAL dependency pulled ONLY by the `saas` feature — so a desktop/default
/// build links no Stripe-signature symbol (INV-5 / ITEM-10). The verify code itself is inside
/// the saas-gated `billing` module.
#[test]
fn hmac_is_a_saas_only_dependency() {
    let cargo = read("Cargo.toml");
    // The `saas` feature enables `dep:hmac`.
    let saas_line = cargo
        .lines()
        .find(|l| l.trim_start().starts_with("saas = ["))
        .expect("Cargo.toml declares the `saas` feature");
    assert!(
        saas_line.contains("dep:hmac"),
        "the `saas` feature must pull `dep:hmac` so the signature verify compiles out of \
         desktop (INV-5). Got: {saas_line}"
    );
    // And `hmac` in [dependencies] is optional (only linked when a feature turns it on).
    assert!(
        cargo.contains("hmac = { version = \"0.12\", optional = true }"),
        "`hmac` must be an OPTIONAL dependency (linked only under `saas`)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// B5 (epic billing / #23) — the `saas` compile-out ENFORCEMENT gate. These run in the
// DEFAULT (desktop / saas-OFF) build (they read source + config, importing no billing
// code) so they are the compile-out proof itself. Together with the saas-ON positive
// control (`billing::mod::tests::billing_module_registers_under_saas`) they pin
// INV-1/-2/-3/-4/-5 for B5.
// ─────────────────────────────────────────────────────────────────────────────────────

/// TEST-2 + TEST-7 [acceptance][INV-2][covers ITEM-5]: the §16 deploy-level kill-switch
/// (the runtime SECOND side of the compile-out). `BillingModule` gates on the
/// `Option<BillingConfig>` in BOTH `init()` and `register_routes()`, and the mount guard
/// sits BEFORE `.merge()` — so a saas binary with no `BillingConfig` (no Stripe secret)
/// mounts no `/api/billing/*`. Proven by source-grep (runs in the default build).
#[test]
fn billing_mount_is_guarded_by_option_billing_config() {
    // Strip comment lines FIRST so this asserts on CODE, not on doc/comment prose that
    // merely names the guard (blind-audit round-1 evasion fix). The token must appear in
    // real code, and the guard must actually short-circuit the mount with a `return`.
    let modrs = strip_line_comments(&read("src/modules/billing/mod.rs"));
    // The register_routes body must consult the kill-switch BEFORE merging the routes.
    let rr = modrs
        .find("fn register_routes")
        .expect("billing/mod.rs defines register_routes");
    let merge = modrs[rr..]
        .find("routes::billing_routes()")
        .map(|i| rr + i)
        .expect("register_routes merges billing_routes()");
    let before_merge = &modrs[rr..merge];
    // STATE, not syntax: the guard must (a) call `from_env_opt()`, (b) test the
    // no-config arm `is_none()`, AND (c) `return` the un-merged router before `.merge()`.
    // A dead no-op guard `if from_env_opt().is_none() {}` (routes still mount) has no
    // `return` here and FAILS — which is exactly the mutant the round-1 auditor raised.
    assert!(
        before_merge.contains("from_env_opt")
            && before_merge.contains("is_none")
            && before_merge.contains("return"),
        "§16: register_routes must guard on `BillingConfig::from_env_opt().is_none()` with an \
         early `return router;` BEFORE `.merge()`, so a saas binary with no BillingConfig mounts \
         no /api/billing/* (a no-op guard without a return must FAIL). register_routes head:\n{before_merge}"
    );
    // The SAME kill-switch is checked in init() (§16: the guard appears in init too) — in CODE.
    let init = modrs.find("fn init").expect("billing/mod.rs defines init");
    let init_body = &modrs[init..rr.max(init)];
    assert!(
        init_body.contains("from_env_opt"),
        "§16: init() must also consult the `Option<BillingConfig>` kill-switch (in code, not a comment)"
    );
    // The helper itself exists and is keyed on the Stripe secret (the deploy signal).
    let cfg = read("src/modules/billing/config.rs");
    assert!(
        cfg.contains("pub fn from_env_opt() -> Option<Self>") && cfg.contains("SECRET_KEY_ENV"),
        "BillingConfig::from_env_opt() is the deploy kill-switch, keyed on the Stripe secret"
    );
}

/// TEST-7 (part) [acceptance][INV-2][covers ITEM-5]: §16's "before any builtin upsert"
/// clause is VACUOUS for billing — the whole `billing/` tree registers NO built-in MCP
/// server. Asserted (not merely skipped) by walking every billing source file.
#[test]
fn billing_registers_no_builtin_mcp_server() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules/billing");
    let mut checked = 0usize;
    fn walk(dir: &std::path::Path, checked: &mut usize) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                walk(&p, checked);
            } else if p.extension().is_some_and(|e| e == "rs") {
                let src = std::fs::read_to_string(&p).unwrap();
                assert!(
                    !src.contains("upsert_builtin_server"),
                    "billing registers no built-in MCP server (§16 upsert clause is vacuous); \
                     found `upsert_builtin_server` in {}",
                    p.display()
                );
                *checked += 1;
            }
        }
    }
    walk(&dir, &mut checked);
    assert!(checked > 0, "walked the billing module source tree");
}

/// TEST-1(c) + TEST-2(a) [acceptance][INV-1][covers ITEM-2]: the analysis path is
/// byte-identical on desktop because core's ONLY metering call site — the storage meter
/// in `workstore/ingest.rs` — is `#[cfg(feature = "saas")]`, so on the default build it
/// compiles to nothing (no account resolve, no `storage_meter` write). And `create_job`
/// carries NO quota-check code at all (the compute-T6 quota call site is itself saas-gated
/// and DEFERRED), so a desktop `create_job` is the pre-billing path unchanged.
#[test]
fn core_metering_and_quota_call_sites_compile_out() {
    // Comment-stripped so an explanatory comment naming the cfg cannot stand in for the
    // real attribute (round-1 evasion fix).
    let ingest = strip_line_comments(&read("src/modules/workstore/ingest.rs"));
    // The storage-meter record call is reachable only under saas.
    let rec = ingest
        .find("meter::record_delta_in_tx")
        .expect("ingest.rs records a storage meter (the core metering call site)");
    let window: String = ingest[..rec]
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        has_saas_cfg(&window),
        "the storage-meter write in ingest.rs must sit under #[cfg(feature = \"saas\")] so a \
         desktop ingest writes no meter row (INV-1 byte-identical). Context above the call:\n{window}"
    );
    // create_job holds no quota-check code (the quota call site is compute-T6's, saas-gated).
    let create_job = read("src/modules/jobs/routes.rs");
    assert!(
        !create_job.contains("check_quota"),
        "create_job must contain no quota-check code — the compute-T6 call site is saas-gated + \
         DEFERRED, so a desktop create_job is byte-identical to the pre-billing path (INV-1)"
    );
}

/// TEST-1(c) (part): the boot loop-spawn in `lib.rs` is gated on BOTH `saas` AND the
/// `Option<BillingConfig>` kill-switch — so a saas binary with no BillingConfig spawns
/// no fold/alert loop, and a desktop build (saas off) compiles the block out entirely.
#[test]
fn billing_boot_spawn_is_saas_and_config_gated() {
    // Strip comment lines FIRST (round-1 evasion fix): the explanatory comment block
    // ABOVE the guard names `from_env_opt`, which would satisfy the token check even if
    // the real `if from_env_opt().is_some()` guard line were deleted. On code-only lines
    // the token must come from the actual guard.
    let lib = strip_line_comments(&read("src/lib.rs"));
    let spawn = lib
        .find("RollupSweeper::new")
        .expect("lib.rs spawns the billing rollup loop");
    let window: String = lib[..spawn]
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        has_saas_cfg(&window),
        "the billing loop spawn must be under #[cfg(feature = \"saas\")] (INV-5). Context:\n{window}"
    );
    assert!(
        window.contains("from_env_opt") && window.contains("is_some"),
        "the billing loop spawn must also gate on the `Option<BillingConfig>` kill-switch \
         `from_env_opt().is_some()` IN CODE (§16: no config ⇒ no fold job). Context:\n{window}"
    );
}

/// TEST-5 [acceptance][INV-5][covers ITEM-6]: the dual-config matrix carrier exists — the
/// `just check-saas-both` recipe (builds + tests BOTH the desktop/default config AND the
/// `--features saas` config, plus the desktop crate) and the staged CI leg. Local carrier
/// while Actions are dark (external-blocker #1).
#[test]
fn dual_config_matrix_recipe_exists() {
    let justfile = read("../../justfile");
    assert!(
        justfile.contains("check-saas-both:"),
        "the `just check-saas-both` dual-config recipe must exist (INV-5 / DE-INV-12)"
    );
    // It must exercise BOTH configs.
    let recipe_start = justfile.find("check-saas-both:").unwrap();
    let recipe = &justfile[recipe_start..(recipe_start + 1200).min(justfile.len())];
    assert!(
        recipe.contains("--features saas"),
        "check-saas-both must build/test the hosted `--features saas` leg"
    );
    assert!(
        recipe.contains("cargo check --workspace --tests"),
        "check-saas-both must build the desktop/default (saas-off) leg"
    );
    // The staged CI leg is authored (disabled while Actions are dark, #1).
    let ci = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.github/workflows/saas-matrix.yml.disabled");
    assert!(
        ci.exists(),
        "the staged saas-matrix CI leg is authored (disabled per #1)"
    );
}

/// TEST-5 (part) [acceptance][INV-5][covers ITEM-7]: the desktop crate embeds the server
/// with `saas` OFF — its `cytoanalyst` dep enables no `saas` feature and does not turn on
/// default-features carrying it — so the binary the desktop compiles is the compile-out
/// build (design §8).
#[test]
fn desktop_crate_does_not_enable_saas() {
    let cargo = read("../desktop/tauri/Cargo.toml");
    let dep_line = cargo
        .lines()
        .find(|l| l.trim_start().starts_with("cytoanalyst = "))
        .expect("desktop Cargo.toml depends on the cytoanalyst server crate");
    assert!(
        !dep_line.contains("saas"),
        "the desktop `cytoanalyst` dep must NOT enable the `saas` feature (ITEM-7). Got: {dep_line}"
    );
}
