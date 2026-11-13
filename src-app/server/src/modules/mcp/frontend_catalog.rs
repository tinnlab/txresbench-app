//! The frontend-action catalog — the `frontend`-side parallel of
//! `txresbench_control_mcp::catalog::init_from_openapi`. `handlers.rs` merges this with
//! the REST/OpenAPI catalog behind ONE uniform
//! `list_capabilities`/`describe_capability`/`invoke_capability` surface;
//! `invoke_capability` of a `kind=frontend` entry routes to
//! `agent_channel::dispatch`.
//!
//! ## TWO populations, TWO sources (DOMAIN_AUDIT S1)
//!
//! 1. **APP-OWNED actions** — navigation, projects, datasets, panes, jobs,
//!    provenance, the view/selection introspection primitives. These belong to
//!    the application shell, are written as `defineAction` calls in the UI
//!    workspace, and are collected into the COMMITTED `frontend-actions.json` by
//!    `ui/scripts/collect-actions.mjs`. They are `include_str!`-baked here: the
//!    shell ships with the binary, so a compile-time manifest is the right shape
//!    for them.
//!
//! 2. **VIEW-SCOPED actions** — the `actions:` a declarative processor declares
//!    in its own `ui/<view>.yaml` view_spec. These are REPORTED by the
//!    controlled browser session, which registers them at view mount
//!    (`registerViewSpecActions`) and then tells the server what it registered.
//!    They used to be baked in here (20 of 57 entries, all single-cell /
//!    CITE-seq / scATAC vocabulary), and after that they were SCANNED here — the
//!    server re-parsed each view_spec with a partial Rust mirror of a schema the
//!    FE runtime owns. Neither is true any more: see
//!    [`super::capabilities`] for why the projection moved to the side that owns
//!    the document, and for the trust boundary a client-supplied catalog opens.
//!
//! The view-scoped half is therefore **per-user**, not process-wide: it is read
//! straight off the user's bound control connection
//! ([`super::agent_channel::capabilities_for`]), so it exists exactly while it
//! is invokable. There is no cache to invalidate — the app-owned half is parsed
//! once ([`app_owned_entries`]) and the merge is a per-request map build over
//! ~60 entries, which is not on any hot path (`tools/call` only).
//!
//! TxResBench stays backend-authoritative for the PERMISSION CHECK either way:
//! a reported action that declares no `permission` is dropped fail-closed rather
//! than advertised ungated ([`super::capabilities::sanitize`]).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::agent_channel;

/// The APP-OWNED half, embedded at compile time so a fresh deploy never depends
/// on a runtime file — mirrors the hub-seed / bundled-asset pattern used
/// elsewhere in the SDK ecosystem. CONTRACT.md pins this exact path.
const MANIFEST_JSON: &str = include_str!("frontend-actions.json");

/// The separator the FRONTEND namespaces a view-scoped action id with —
/// `<view_spec_id>::<action_id>`, `workbench/core/spec/ids.ts`. The server does
/// not CONSTRUCT ids any more (the browser reports them already namespaced); it
/// only recognizes the shape, to assert the committed app-owned manifest
/// carries none.
pub const VIEW_SCOPED_ID_SEP: &str = "::";

/// One frontend action. Field names match CONTRACT.md's `frontend-actions.json`
/// schema exactly — the SAME shape whether the entry came from the committed
/// app-owned manifest or was REPORTED by the controlled browser session
/// (`modules/mcp/capabilities.rs`), so `handlers.rs` has ONE code path.
///
/// This is ALSO the wire shape a session reports (`AgentCapabilitiesBody`). One
/// shape, one type: a parallel wire struct would be a second definition of the
/// same thing, which is the defect class this module's history is made of. What
/// the wire direction adds is not a type but a GATE — the report is untrusted
/// input, filtered and bounded by `capabilities::sanitize` before it can reach
/// the catalog.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct FrontendActionEntry {
    pub id: String,
    pub title: String,
    /// `"global"` (invoked directly by id) or `"instance"` (addresses a
    /// runtime `view_id` — ai-actions slice 3, ARCHITECTURE.md Layer 4).
    /// Branched on in `handlers.rs`'s `invoke_frontend`/`describe_capability`
    /// to thread `view_id`/`expected_token` through to the agent channel.
    pub kind: String,
    pub mutating: bool,
    /// Only meaningful when `kind == "instance"`. `true` together with
    /// `mutating` means invoking this action requires a valid `expected`
    /// state token (the read-before-write / stale-state guard,
    /// ARCHITECTURE.md Layer 6) — engine-enforced, this catalog only carries
    /// the flag through to `describe_capability` + the invoke path.
    /// `#[serde(default)]` keeps a manifest predating this field parseable.
    #[serde(default)]
    pub stateful: bool,
    /// Which app CONTEXT (active page/surface) must be live for this action to
    /// be invokable — `"global"` (always available) or a named context such as
    /// `"workbench"`/`"dataset"` (workbench-analysis PLAN.md ITEM-4). Surfaced
    /// by `describe_capability` as a precondition so the AI navigates there
    /// first; the ENGINE enforces the `CONTEXT_INACTIVE` reject and the backend
    /// merely RELAYS it (this catalog only carries the value through — the exact
    /// Layer 5/6 split the `stateful` field follows for staleness).
    /// `#[serde(default = "default_context")]` keeps a manifest predating this
    /// field parseable, defaulting to `"global"` — the same back-compat the
    /// `stateful` field's `#[serde(default)]` provides.
    #[serde(default = "default_context")]
    pub context: String,
    pub permission: String,
    pub params_schema: Value,
    /// Discoverability metadata (richer-actions ITEM-4) — the display GROUP, a
    /// one-line DESCRIPTION, and ALTERNATIVE search terms (aliases/keywords) the
    /// frontend `defineAction` carries. Surfaced to the agent by
    /// `list_capabilities` (searched) + `describe_capability` (shown) so it can
    /// find/pick an action by intent, not only its exact title. Each
    /// `#[serde(default)]` keeps a manifest predating these fields parseable
    /// (the `stateful`/`context` back-compat precedent).
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
}

impl FrontendActionEntry {
    /// Does the (already-lowercased) `q` match this action's id, title, group,
    /// any alias/keyword, or its description? The search predicate
    /// `list_capabilities` uses so the agent can discover an action by an
    /// alternative term (richer-actions ITEM-4).
    pub fn matches_query(&self, q: &str) -> bool {
        self.id.to_lowercase().contains(q)
            || self.title.to_lowercase().contains(q)
            || self
                .group
                .as_deref()
                .is_some_and(|g| g.to_lowercase().contains(q))
            || self
                .description
                .as_deref()
                .is_some_and(|d| d.to_lowercase().contains(q))
            || self.aliases.iter().any(|a| a.to_lowercase().contains(q))
            || self.keywords.iter().any(|k| k.to_lowercase().contains(q))
    }
}

/// Serde default for [`FrontendActionEntry::context`]: an entry (or a whole
/// manifest) predating the `context` field parses as the always-available
/// `"global"` context.
fn default_context() -> String {
    "global".to_string()
}

#[derive(Debug, Deserialize)]
struct FrontendActionManifest {
    #[allow(dead_code)]
    version: u32,
    actions: Vec<FrontendActionEntry>,
}

#[derive(Debug)]
pub struct FrontendActionCatalog {
    entries: HashMap<String, FrontendActionEntry>,
}

impl FrontendActionCatalog {
    pub fn get(&self, id: &str) -> Option<&FrontendActionEntry> {
        self.entries.get(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &FrontendActionEntry> {
        self.entries.values()
    }
}

/// The APP-OWNED entries, parsed once from the embedded manifest.
fn app_owned_entries() -> &'static [FrontendActionEntry] {
    static PARSED: OnceLock<Vec<FrontendActionEntry>> = OnceLock::new();
    PARSED.get_or_init(|| parse_manifest(MANIFEST_JSON))
}

/// Parse + validate the embedded app-owned manifest at boot rather than on the
/// first request. Idempotent. Called from `lib.rs::build_app`, right after the
/// REST catalog's `init_from_openapi`.
pub fn init_from_manifest() {
    let n = app_owned_entries().len();
    tracing::info!("mcp: frontend-action catalog initialized with {n} app-owned action(s)");
}

/// The merged catalog for `user_id`: the APP-OWNED half plus whatever that
/// user's bound control connection REPORTED. Always `Some`; the `Option` is
/// retained so `handlers.rs` keeps its graceful-degrade shape.
///
/// Per-user because the view-scoped half is: it is the live browser session's
/// registered set, and it must not outlive the session that can invoke it.
pub fn catalog_for(user_id: Uuid) -> Option<Arc<FrontendActionCatalog>> {
    Some(Arc::new(merge(&agent_channel::capabilities_for(user_id))))
}

/// Merge the APP-OWNED entries with the REPORTED view-scoped ones. An app-owned
/// id WINS a collision and the loser is logged — two entries under one id would
/// be indistinguishable at invoke (the browser registers ids globally), and this
/// is also what stops a client from re-declaring a shell action under a weaker
/// permission.
fn merge(view_scoped: &[FrontendActionEntry]) -> FrontendActionCatalog {
    let mut entries: HashMap<String, FrontendActionEntry> = app_owned_entries()
        .iter()
        .map(|a| (a.id.clone(), a.clone()))
        .collect();
    let app_owned = entries.len();

    let mut reported = 0usize;
    for entry in view_scoped {
        if entries.contains_key(&entry.id) {
            tracing::warn!(
                action = %entry.id,
                "mcp: a reported view-scoped capability collides with an app-owned action id; the app-owned one wins"
            );
            continue;
        }
        entries.insert(entry.id.clone(), entry.clone());
        reported += 1;
    }
    tracing::debug!(app_owned, reported, "mcp: frontend-action catalog built");
    FrontendActionCatalog { entries }
}

/// Parse the embedded app-owned manifest. A malformed manifest yields an EMPTY
/// app-owned set (logged) rather than a panic; the unit tests below make a
/// malformed COMMITTED manifest fail loud at test time instead.
fn parse_manifest(raw: &str) -> Vec<FrontendActionEntry> {
    match serde_json::from_str::<FrontendActionManifest>(raw) {
        Ok(m) => m.actions,
        Err(e) => {
            tracing::error!("mcp: failed to parse frontend-actions.json: {e}");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Catalog over an app-owned manifest STRING — the production
    /// [`parse_manifest`] folded into a catalog, so the embedded-manifest parse
    /// (and its malformed-input degradation) stays directly testable against a
    /// fixture. Test-only: production always merges the registry-derived half in
    /// [`build_merged`].
    fn build_from_str(raw: &str) -> FrontendActionCatalog {
        let entries = parse_manifest(raw)
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();
        FrontendActionCatalog { entries }
    }

    #[test]
    fn committed_manifest_parses_with_the_two_contract_actions() {
        // STRIP (ITEM-6): the second signature action was `project.openProject`,
        // which left with the project module (ITEM-3) and the manifest regen
        // (ITEM-4b) dropped it. The kept manifest's two signature actions are
        // the shell navigation action and the admin feature-flag action — the
        // same parse-proves-contract property, on the kept surface.
        let catalog = build_from_str(MANIFEST_JSON);
        let nav = catalog.get("app.navigate").expect("app.navigate present");
        assert_eq!(nav.permission, "mcp::use");
        assert!(nav.mutating);
        assert_eq!(nav.params_schema["required"][0], "path");

        let flag = catalog
            .get("features.setGlobalFlag")
            .expect("features.setGlobalFlag present");
        assert_eq!(flag.permission, "features::manage");
        assert_eq!(flag.params_schema["required"][0], "flag_key");
    }

    #[test]
    fn iter_yields_every_entry() {
        // The manifest now carries every registered `defineAction` across
        // the app (slice-2 added project/job/nav actions on top of slice-1's
        // two contract actions — PLAN.md ITEM-2; STRIP ITEM-4b's regen left
        // the kept 9). This asserts the two signature actions are present
        // among N entries rather than pinning an exact count that would churn
        // on every new registration.
        let catalog = build_from_str(MANIFEST_JSON);
        let ids: Vec<&str> = catalog.iter().map(|a| a.id.as_str()).collect();
        assert!(
            ids.contains(&"app.navigate"),
            "app.navigate missing: {ids:?}"
        );
        assert!(
            ids.contains(&"features.setGlobalFlag"),
            "features.setGlobalFlag missing: {ids:?}"
        );
        assert!(
            ids.len() >= 2,
            "expected at least the 2 contract actions, got {ids:?}"
        );
    }

    #[test]
    fn malformed_manifest_yields_empty_catalog_not_a_panic() {
        let catalog = build_from_str("not json");
        assert!(catalog.entries.is_empty());
    }

    #[test]
    fn empty_actions_array_yields_empty_catalog() {
        let catalog = build_from_str(r#"{"version":1,"actions":[]}"#);
        assert!(catalog.entries.is_empty());
    }

    // ── TEST-105 (workbench-analysis ITEM-4): the `context` field ──────────

    #[test]
    fn entry_deserializes_explicit_context() {
        // An entry carrying an explicit non-global `context` round-trips it.
        let raw = r#"{
            "version": 1,
            "actions": [
                {
                    "id": "analysis.launch",
                    "title": "Launch an analysis",
                    "kind": "instance",
                    "context": "workbench",
                    "mutating": true,
                    "stateful": false,
                    "permission": "jobs::use",
                    "params_schema": {}
                }
            ]
        }"#;
        let catalog = build_from_str(raw);
        let entry = catalog
            .get("analysis.launch")
            .expect("analysis.launch present");
        assert_eq!(entry.context, "workbench");
    }

    #[test]
    fn entry_without_context_defaults_to_global() {
        // A manifest PREDATING the `context` field (no `context` key on the
        // action at all) still parses, with `context` defaulting to `"global"`
        // via `#[serde(default = "default_context")]` — the exact back-compat
        // the `stateful` field's `#[serde(default)]` already proves (the
        // manifest is additive: no `deny_unknown_fields`, no required-context).
        let raw = r#"{
            "version": 1,
            "actions": [
                {
                    "id": "legacy.action",
                    "title": "A legacy action",
                    "kind": "global",
                    "mutating": false,
                    "stateful": false,
                    "permission": "mcp::use",
                    "params_schema": {}
                }
            ]
        }"#;
        let catalog = build_from_str(raw);
        let entry = catalog.get("legacy.action").expect("legacy.action present");
        assert_eq!(entry.context, "global");
    }

    #[test]
    fn committed_manifest_carries_context_per_action() {
        // The regen'd `frontend-actions.json` already carries `context` on
        // every action — confirm it deserializes onto the new field with the
        // expected values. STRIP (ITEM-6): the platform contexts
        // (`workbench`, `dataset`) left with their modules (ITEM-4); every
        // kept action is app/framework-owned and carries `"global"`, and a
        // non-global context re-entering the committed manifest must fail
        // here rather than ride the collector.
        let catalog = build_from_str(MANIFEST_JSON);
        assert_eq!(
            catalog.get("app.navigate").expect("app.navigate").context,
            "global"
        );
        let non_global: Vec<&str> = catalog
            .iter()
            .filter(|a| a.context != "global")
            .map(|a| a.id.as_str())
            .collect();
        assert!(
            non_global.is_empty(),
            "only app/framework actions are committed: {non_global:?}"
        );
    }

    // ── richer-actions ITEM-4 (TEST-4b): discoverability metadata reaches the agent ──

    #[test]
    fn entry_deserializes_metadata_and_search_matches_by_alias_group() {
        let raw = r#"{
            "version": 1,
            "actions": [
                {
                    "id": "dataset.add.byId",
                    "title": "Add dataset by id",
                    "kind": "instance",
                    "context": "workbench",
                    "mutating": true,
                    "permission": "projects::use",
                    "group": "Datasets",
                    "description": "Link a specific dataset to this project by id.",
                    "aliases": ["attach dataset by id", "link dataset by id"],
                    "keywords": ["import"],
                    "params_schema": {}
                }
            ]
        }"#;
        let catalog = build_from_str(raw);
        let e = catalog.get("dataset.add.byId").expect("entry present");
        assert_eq!(e.group.as_deref(), Some("Datasets"));
        assert!(e
            .description
            .as_deref()
            .unwrap()
            .contains("Link a specific"));
        assert_eq!(
            e.aliases,
            vec!["attach dataset by id", "link dataset by id"]
        );
        // The agent can DISCOVER the action by an alternative term, not just its title.
        assert!(e.matches_query("attach dataset"), "alias should match");
        assert!(e.matches_query("import"), "keyword should match");
        assert!(e.matches_query("datasets"), "group should match");
        assert!(!e.matches_query("zzznope"));
    }

    #[test]
    fn committed_manifest_carries_enriched_metadata_for_framework_admin_actions() {
        // STRIP (ITEM-6): the dataset actions whose metadata this asserted
        // left with the platform (ITEM-4's manifest regen). The kept enriched
        // actions are the feature-flag admin actions — the discoverability
        // metadata (group + description) reaching the agent. The alias
        // mechanism itself is proved by the raw-fixture test above.
        let catalog = build_from_str(MANIFEST_JSON);
        let e = catalog
            .get("features.setGlobalFlag")
            .expect("features.setGlobalFlag present");
        assert!(e.description.is_some(), "should carry a description");
        assert_eq!(e.group.as_deref(), Some("Admin"));
    }

    // ── DOMAIN_AUDIT S1: the two populations + the merge ────────────────────

    /// The COMMITTED manifest is the APP-OWNED half ONLY. A view-scoped
    /// (`<view>::<action>`) id reappearing here means the collector regressed
    /// and the binary is carrying domain vocabulary again.
    ///
    /// This is the surviving half of the deleted `view_spec_actions.rs`'s
    /// `committed_manifest_carries_no_view_scoped_actions`: that property was
    /// never about the SCAN — it is about what the COLLECTOR emits into the
    /// binary — so it outlives the scan and lives here, next to the manifest it
    /// is about.
    #[test]
    fn committed_manifest_is_app_owned_only() {
        let catalog = build_from_str(MANIFEST_JSON);
        let leaked: Vec<&str> = catalog
            .iter()
            .map(|a| a.id.as_str())
            .filter(|id| id.contains(VIEW_SCOPED_ID_SEP))
            .collect();
        assert!(
            leaked.is_empty(),
            "view-scoped actions must be reported by the controlled session, not baked in: {leaked:?}"
        );
        // …and the app/framework-owned half is still all there. STRIP
        // (ITEM-6): the `workbench.openAnalyses` / `provenance.record-selection`
        // pins left with their modules (ITEM-4's regen); the kept half's pins
        // are the shell nav action and the framework admin/views actions.
        assert!(catalog.get("app.navigate").is_some());
        assert!(catalog.get("features.setGlobalFlag").is_some());
        assert!(catalog.get("views.list").is_some());
    }

    /// With NOTHING reported, the catalog is the app-owned half verbatim — a
    /// user with no controlled window degrades to exactly the baked set, never
    /// to an empty catalog and never to a view-scoped entry it could not invoke.
    #[test]
    fn merge_with_nothing_reported_is_the_app_owned_half() {
        let merged = merge(&[]);
        let baked = build_from_str(MANIFEST_JSON);
        let mut a: Vec<&str> = merged.iter().map(|e| e.id.as_str()).collect();
        let mut b: Vec<&str> = baked.iter().map(|e| e.id.as_str()).collect();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }

    fn reported(id: &str, title: &str) -> FrontendActionEntry {
        FrontendActionEntry {
            id: id.to_string(),
            title: title.to_string(),
            kind: "instance".to_string(),
            mutating: true,
            stateful: true,
            context: "global".to_string(),
            permission: "jobs::use".to_string(),
            params_schema: serde_json::json!({}),
            group: None,
            description: None,
            aliases: Vec::new(),
            keywords: Vec::new(),
        }
    }

    /// The ACCEPTANCE property at unit level: a view action reaches the AI
    /// capability catalog with the server parsing NO view_spec — it is merged in
    /// from what the controlled session reported.
    #[test]
    fn a_reported_capability_joins_the_catalog_and_app_owned_wins_a_collision() {
        let app_owned = app_owned_entries().len();
        let nav_before = app_owned_entries()
            .iter()
            .find(|e| e.id == "app.navigate")
            .expect("baked")
            .title
            .clone();

        let merged = merge(&[
            reported("demo.view::d.act", "Demo action"),
            // A client trying to re-declare a shell action under its own terms.
            reported("app.navigate", "IMPOSTOR"),
        ]);

        assert_eq!(merged.entries.len(), app_owned + 1);
        assert_eq!(
            merged
                .get("demo.view::d.act")
                .expect("reported entry")
                .title,
            "Demo action"
        );
        assert_eq!(
            merged.get("app.navigate").expect("app-owned").title,
            nav_before,
            "a reported capability must not be able to shadow an app-owned action"
        );
    }

    /// `catalog_for` reads the view-scoped half off the CALLER's OWN control
    /// session — the wiring the whole feature turns on. Without this, a
    /// `catalog_for` that ignored its argument and merged nothing would leave
    /// every unit test green while the agent saw no view action at all.
    #[test]
    fn catalog_for_merges_what_the_callers_own_session_reported() {
        let user = Uuid::new_v4();
        let (conn_id, _rx) = agent_channel::bind_test_session(user);
        assert!(agent_channel::set_capabilities(
            user,
            conn_id,
            vec![reported("demo.view::d.act", "Demo action")],
        ));

        let catalog = catalog_for(user).expect("always Some");
        assert_eq!(
            catalog
                .get("demo.view::d.act")
                .expect("reported entry")
                .title,
            "Demo action"
        );
        assert!(
            catalog.get("app.navigate").is_some(),
            "…alongside app-owned"
        );

        // A DIFFERENT caller, same process, sees none of it.
        let other = catalog_for(Uuid::new_v4()).expect("always Some");
        assert!(other.get("demo.view::d.act").is_none());

        agent_channel::unbind_test_session(user, conn_id);
    }

    /// …and a user with no controlled window sees only the app-owned half. (The
    /// bind/report/unbind lifecycle itself is proved in `agent_channel`'s
    /// tests, which own the session registry.)
    #[test]
    fn catalog_for_a_user_with_no_session_is_the_app_owned_half() {
        let catalog = catalog_for(Uuid::new_v4()).expect("always Some");
        let leaked: Vec<&str> = catalog
            .iter()
            .map(|a| a.id.as_str())
            .filter(|id| id.contains(VIEW_SCOPED_ID_SEP))
            .collect();
        assert!(
            leaked.is_empty(),
            "no controlled window ⇒ nothing view-scoped is invokable ⇒ nothing may be \
             advertised: {leaked:?}"
        );
        assert!(catalog.get("app.navigate").is_some());
    }
}
