//! The VIEW-SCOPED half of the frontend capability catalog — **REPORTED by the
//! controlled browser session**, never derived server-side.
//!
//! ## Why the server no longer derives it
//!
//! This module replaces a server-side scan of `<data_root>/processors/<pkg>/ui/*.yaml`
//! that parsed each `view_spec` with a partial Rust mirror of a schema the FE runtime
//! owns, and projected its `actions:` into [`FrontendActionEntry`] values. Two parsers of
//! one document, with nothing forcing them to agree, is the defect class the surrounding
//! work has been removing — and the scan's own module doc admitted the mirror was
//! "deliberately PARTIAL".
//!
//! The FE already performs the real registration, at the moment the real set is known:
//! `registerViewSpecActions(spec)` (`workbench/core/runtime/interpreter.ts`) is called
//! from `declarativeMount.ts` / `runtime/register.ts` when a view mounts. So the FE
//! projects and REPORTS; the backend RECEIVES a catalog and merges it, exactly as it
//! merges the app-owned half.
//!
//! ## Lifetime — the report lives and dies with the control connection
//!
//! `invoke_capability(kind=frontend)` routes to [`super::agent_channel::dispatch`], which
//! targets the ONE bound control connection for the user and fails `NotConnected` when
//! there is none. So a view-scoped capability advertised while no browser session is
//! bound **cannot be invoked at all**. The reported set is therefore stored INSIDE the
//! session registry entry ([`super::agent_channel::set_capabilities`]) and is dropped
//! when the connection unbinds — the lifetime is structural, with no separate
//! invalidation path to forget. The FE re-reports its full snapshot on every `connected`
//! handshake, so a reconnect never silently loses a capability that IS invokable.
//!
//! ## Trust boundary
//!
//! The browser now tells the server what capabilities exist, so the report is UNTRUSTED
//! INPUT and [`sanitize`] is the gate:
//!
//! - a permission-less entry is DROPPED, fail-closed — the backend is authoritative for
//!   the permission check (`mcp::permissions`), so an ungated action must not be
//!   advertised (this is the one rule carried over verbatim from the deleted scan);
//! - an entry with a blank id/title, an unknown `kind`, an over-long field or an
//!   over-large `params_schema` is DROPPED — a client must not be able to grow the
//!   catalog without bound (the report is `mcp::use`-gated, but that is held by every
//!   ordinary user);
//! - the set is capped and de-duplicated by id;
//! - an APP-OWNED id still WINS a collision (`frontend_catalog::merge`), so a client
//!   cannot re-declare a shell action under a weaker permission.
//!
//! What a client CANNOT do by lying about `permission`: widen its own authority. The
//! effect of a frontend action runs in the reporting user's OWN browser under that user's
//! own session, and any server-side effect it triggers goes back through a REST route
//! that re-authorizes the user's JWT. Under-declaring a permission therefore reaches
//! nothing the browser could not already reach by clicking; it only misinforms the agent
//! about what the action needs. Over-declaring hides the action from its own user.

use axum::{debug_handler, Json};

use crate::modules::permissions::RequirePermissions;

use super::agent_channel;
use super::frontend_catalog::FrontendActionEntry;
use super::models::{AckResponse, AgentCapabilitiesBody};
use super::permissions::McpUse;

/// Max view-scoped capabilities one control connection may report. Generous
/// against the real shape (a mounted analysis view declares single digits of
/// actions), tight enough that the per-user catalog stays bounded.
pub(super) const MAX_REPORTED_CAPABILITIES: usize = 512;

/// Field caps. An id/title/description is display + dispatch metadata, not a
/// payload; `params_schema` is a JSON-Schema fragment the invoke path validates
/// a body against, not a document store.
const MAX_ID_LEN: usize = 256;
const MAX_TITLE_LEN: usize = 256;
const MAX_DESCRIPTION_LEN: usize = 2048;
const MAX_PARAMS_SCHEMA_BYTES: usize = 16 * 1024;
/// Cap on each discoverability list (aliases / keywords) and on one entry of it.
const MAX_SEARCH_TERMS: usize = 32;
const MAX_SEARCH_TERM_LEN: usize = 128;

/// The `kind` vocabulary [`FrontendActionEntry::kind`] admits — `handlers.rs`
/// branches on exactly these two, so a third value would silently take the
/// `global` path (no `view_id` extraction) for something addressing an instance.
const VALID_KINDS: [&str; 2] = ["global", "instance"];

/// Filter + bound a reported capability set. Every rejection is logged at
/// `warn` with the offending id: a dropped capability is a capability the agent
/// will not see, and silence there is indistinguishable from a FE bug.
pub(super) fn sanitize(reported: Vec<FrontendActionEntry>) -> Vec<FrontendActionEntry> {
    let mut out: Vec<FrontendActionEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in reported {
        if out.len() >= MAX_REPORTED_CAPABILITIES {
            tracing::warn!(
                cap = MAX_REPORTED_CAPABILITIES,
                "mcp: reported capability set exceeds the cap; the remainder is dropped"
            );
            break;
        }
        if let Some(reason) = rejection_reason(&entry) {
            tracing::warn!(
                capability = %entry.id,
                reason,
                "mcp: reported capability rejected"
            );
            continue;
        }
        if !seen.insert(entry.id.clone()) {
            tracing::warn!(capability = %entry.id, "mcp: duplicate reported capability id; the first wins");
            continue;
        }
        out.push(entry);
    }
    out
}

/// `Some(reason)` when this entry must not be advertised. Order is deliberate:
/// the fail-closed permission check reads first so its log line is the one an
/// author sees for the most likely authoring mistake.
fn rejection_reason(entry: &FrontendActionEntry) -> Option<&'static str> {
    if entry.permission.trim().is_empty() {
        // The rule the deleted server-side scan enforced, preserved verbatim:
        // the backend is authoritative for the permission check, so an action
        // with no permission has no gate and must never reach the agent.
        return Some("declares no permission (fail-closed)");
    }
    if entry.id.trim().is_empty() {
        return Some("declares no id");
    }
    if entry.title.trim().is_empty() {
        return Some("declares no title");
    }
    if !VALID_KINDS.contains(&entry.kind.as_str()) {
        return Some("declares an unknown kind (expected \"global\" or \"instance\")");
    }
    if entry.id.len() > MAX_ID_LEN {
        return Some("id exceeds the length cap");
    }
    if entry.title.len() > MAX_TITLE_LEN {
        return Some("title exceeds the length cap");
    }
    if entry
        .description
        .as_deref()
        .is_some_and(|d| d.len() > MAX_DESCRIPTION_LEN)
    {
        return Some("description exceeds the length cap");
    }
    if entry
        .group
        .as_deref()
        .is_some_and(|g| g.len() > MAX_TITLE_LEN)
    {
        return Some("group exceeds the length cap");
    }
    if entry.aliases.len() > MAX_SEARCH_TERMS || entry.keywords.len() > MAX_SEARCH_TERMS {
        return Some("declares too many aliases/keywords");
    }
    if entry
        .aliases
        .iter()
        .chain(entry.keywords.iter())
        .any(|t| t.len() > MAX_SEARCH_TERM_LEN)
    {
        return Some("an alias/keyword exceeds the length cap");
    }
    // Serialized size, not depth: `validate_body` walks only the top level, but
    // the schema is echoed back to the model by `describe_capability`, so its
    // BYTES are what must stay bounded.
    match serde_json::to_vec(&entry.params_schema) {
        Ok(bytes) if bytes.len() > MAX_PARAMS_SCHEMA_BYTES => {
            Some("params_schema exceeds the size cap")
        }
        Ok(_) => None,
        Err(_) => Some("params_schema is not serializable"),
    }
}

/// `POST /api/mcp/agent/capabilities` — the controlled session REPLACES its
/// view-scoped capability set.
///
/// A REPLACE, not a merge: an add-only protocol could never express a removal,
/// and the FE holds the authoritative set anyway (its `defineAction` registry).
///
/// `ok: false` means the report did not correlate to the caller's CURRENTLY
/// BOUND connection — a superseded tab (a reload racing a rebind) reporting
/// against a `connection_id` that is no longer the bound one. Same
/// "did-not-correlate" ack the three sibling up-endpoints return, and the same
/// `conn_id`-not-`session_id` discrimination `unbind_session` uses, for the same
/// reason: a client-supplied `session_id` legitimately survives a reload, so two
/// unrelated connections can share one.
#[debug_handler]
pub async fn agent_capabilities(
    auth: RequirePermissions<(McpUse,)>,
    Json(body): Json<AgentCapabilitiesBody>,
) -> Json<AckResponse> {
    let entries = sanitize(body.capabilities);
    Json(AckResponse {
        ok: agent_channel::set_capabilities(auth.user.id, body.connection_id, entries),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A minimal well-formed reported entry. Deliberately domain-neutral: this
    /// module knows nothing about any package's vocabulary.
    fn entry(id: &str) -> FrontendActionEntry {
        FrontendActionEntry {
            id: id.to_string(),
            title: "An action".to_string(),
            kind: "instance".to_string(),
            mutating: true,
            stateful: true,
            context: "global".to_string(),
            permission: "jobs::use".to_string(),
            params_schema: json!({
                "type": "object",
                "required": ["view_id"],
                "additionalProperties": false,
                "properties": { "view_id": { "type": "string" } },
            }),
            group: None,
            description: None,
            aliases: Vec::new(),
            keywords: Vec::new(),
        }
    }

    fn ids(entries: &[FrontendActionEntry]) -> Vec<String> {
        entries.iter().map(|e| e.id.clone()).collect()
    }

    #[test]
    fn a_well_formed_report_passes_through_unchanged() {
        let got = sanitize(vec![
            entry("demo.view::d.first"),
            entry("demo.view::d.second"),
        ]);
        assert_eq!(ids(&got), vec!["demo.view::d.first", "demo.view::d.second"]);
    }

    /// The fail-closed rule the deleted server-side scan enforced, re-expressed
    /// at the new boundary: an action with no permission has no gate, so it must
    /// never reach the agent — whoever supplies it.
    #[test]
    fn a_permissionless_reported_capability_is_dropped_fail_closed() {
        let mut blank = entry("demo.view::d.ungated");
        blank.permission = String::new();
        let mut whitespace = entry("demo.view::d.alsoUngated");
        whitespace.permission = "   ".to_string();
        let got = sanitize(vec![blank, whitespace, entry("demo.view::d.gated")]);
        assert_eq!(
            ids(&got),
            vec!["demo.view::d.gated"],
            "an ungated action must not reach the agent"
        );
    }

    #[test]
    fn an_unknown_kind_is_dropped() {
        let mut weird = entry("demo.view::d.weird");
        weird.kind = "rest".to_string();
        let got = sanitize(vec![weird, entry("demo.view::d.ok")]);
        assert_eq!(ids(&got), vec!["demo.view::d.ok"]);
    }

    #[test]
    fn both_declared_kinds_are_accepted() {
        let mut global = entry("demo.view::d.global");
        global.kind = "global".to_string();
        let got = sanitize(vec![global, entry("demo.view::d.instance")]);
        assert_eq!(got.len(), 2, "{:?}", ids(&got));
    }

    #[test]
    fn a_blank_id_or_title_is_dropped() {
        let mut no_id = entry("demo.view::d.a");
        no_id.id = String::new();
        let mut no_title = entry("demo.view::d.b");
        no_title.title = "  ".to_string();
        assert!(sanitize(vec![no_id, no_title]).is_empty());
    }

    #[test]
    fn over_long_fields_are_dropped() {
        let mut long_id = entry(&"x".repeat(MAX_ID_LEN + 1));
        long_id.title = "ok".to_string();
        let mut long_title = entry("demo.view::d.b");
        long_title.title = "y".repeat(MAX_TITLE_LEN + 1);
        let mut long_desc = entry("demo.view::d.c");
        long_desc.description = Some("z".repeat(MAX_DESCRIPTION_LEN + 1));
        let mut fat_schema = entry("demo.view::d.d");
        fat_schema.params_schema = json!({ "blob": "w".repeat(MAX_PARAMS_SCHEMA_BYTES + 1) });
        let mut many_aliases = entry("demo.view::d.e");
        many_aliases.aliases = (0..MAX_SEARCH_TERMS + 1).map(|i| i.to_string()).collect();
        let mut long_alias = entry("demo.view::d.f");
        long_alias.keywords = vec!["k".repeat(MAX_SEARCH_TERM_LEN + 1)];

        let got = sanitize(vec![
            long_id,
            long_title,
            long_desc,
            fat_schema,
            many_aliases,
            long_alias,
            entry("demo.view::d.fine"),
        ]);
        assert_eq!(ids(&got), vec!["demo.view::d.fine"]);
    }

    #[test]
    fn the_report_is_capped_and_the_remainder_dropped() {
        let over: Vec<FrontendActionEntry> = (0..MAX_REPORTED_CAPABILITIES + 25)
            .map(|i| entry(&format!("demo.view::d.{i}")))
            .collect();
        assert_eq!(sanitize(over).len(), MAX_REPORTED_CAPABILITIES);
    }

    #[test]
    fn a_duplicate_id_is_reported_once() {
        let mut second = entry("demo.view::d.dup");
        second.title = "IMPOSTOR".to_string();
        let got = sanitize(vec![entry("demo.view::d.dup"), second]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "An action", "the first report wins");
    }
}
