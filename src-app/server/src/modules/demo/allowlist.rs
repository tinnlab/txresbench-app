//! The ONE route-policy table (demo-mode ITEM-1): every operation of the
//! shipped OpenAPI surface is classified **Allowed** (works exactly as in
//! desktop), **Adapted** (works, but the demo changes what it does — each
//! adaptation lands with the demo item that owns it, ITEM-2/3/4/5/7) or
//! **Blocked** (answers `403 {"error_code": "DEMO_MODE", ...}` — the spec
//! section 4 list, re-counted on THIS tree: the strip removed the
//! platform modules, so the framework surface is the 71 operations of
//! the kept furniture (files / accounts / auth / mcp / sandbox / sync /
//! notifications / features / auth-providers), not the spec's stale 141).
//!
//! The ONE file rule: the gate reads only this table; the tests prove the
//! table is COMPLETE against the emitted OpenAPI spec (`every_route_is_
//! classified`, in `demo/tests.rs` at the module level, plus the server
//! integration test `route_sweep`), so a route added to the app without a
//! row here fails the suite. The gate itself fails CLOSED: a route with no
//! row answers 403 in demo mode even before the completeness test sees it.
//!
//! Row spelling: paths are the OpenAPI paths with the `/api` prefix STRIPPED
//! (the middleware strips the configured `server.api_prefix` before looking
//! up), and `{param}` segments match any one segment.

/// The three classes a route can hold. Every row of [`ROUTE_POLICY`] carries
/// exactly one; there is no fourth "unclassified" value — a route without a
/// row is BLOCKED (fail-closed) and the completeness test fails on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteClass {
    /// Works unchanged (the spec's "Allowed as is" list).
    Allowed,
    /// Works with demo-adapted behaviour (the spec's "Allowed, adapted" list;
    /// the adaptation itself belongs to the later demo items).
    Adapted,
    /// Answers 403 DEMO_MODE (the spec's "Blocked" list + every framework
    /// route not used by the app).
    Blocked,
}

/// The classification of an operation: `None` only when the route has no row
/// (which the completeness test makes impossible — the gate still blocks it).
pub fn classify(method: &str, path: &str) -> Option<RouteClass> {
    ROUTE_POLICY
        .iter()
        .find(|row| row.method == method && matches_row(&row.path, path))
        .map(|row| row.class)
}

/// Match a table path pattern against a request path. Segments are compared
/// one by one; a `{param}` segment matches exactly one non-empty segment
/// (never zero, never slashes — the same shape the router itself uses).
fn matches_row(pattern: &str, path: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').collect();
    let got: Vec<&str> = path.split('/').collect();
    if pat.len() != got.len() {
        return false;
    }
    pat.iter().zip(&got).all(|(p, g)| {
        if let Some(param) = p.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            !param.is_empty() && !g.is_empty()
        } else {
            p == g
        }
    })
}

/// The one table. Sorted by method then path (regeneration from the emitted
/// OpenAPI spec keeps this order stable — the completeness test compares SETS,
/// so the order is for the human reviewer, not the gate).
pub const ROUTE_POLICY: &[RouteRow] = &[
    // ─────────────────────────────── ALLOWED ───────────────────────────────
    // The app's own boot + data surface (spec section 4 "Allowed as is").
    RouteRow::allowed("GET", "/app/mode"),
    RouteRow::allowed("GET", "/health"),
    RouteRow::allowed("POST", "/session/local"),
    // The app's OWN single-user boot calls this trio (Session.store mints via
    // /session/local, then reads GET /auth/me for the user + permissions; the
    // shared transport rotates a 401 via POST /auth/refresh). The spec's
    // "every other framework route" clause would break the app's boot in demo
    // mode, so these three are deliberately allowed — see DRIFT-1 ITEM-1.
    RouteRow::allowed("GET", "/auth/me"),
    RouteRow::allowed("POST", "/auth/logout"),
    RouteRow::allowed("POST", "/auth/refresh"),
    RouteRow::allowed("GET", "/methods"),
    // The method list status: in demo mode it says updates are off (the demo
    // replays the built-in list). Before the `{method_id}` row: first match wins.
    RouteRow::allowed("GET", "/methods/updates"),
    RouteRow::allowed("GET", "/methods/filter-options"),
    RouteRow::allowed("GET", "/methods/{method_id}"),
    RouteRow::allowed("POST", "/methods/eligibility"),
    RouteRow::allowed("POST", "/methods/estimate"),
    RouteRow::allowed("GET", "/markers"),
    RouteRow::allowed("GET", "/file-validation/examples/{kind}"),
    RouteRow::allowed("GET", "/file-validation/templates/{kind}"),
    RouteRow::allowed("GET", "/txr/history"),
    RouteRow::allowed("GET", "/txr/history/preferences"),
    // ITEM-4: in demo mode this answers the shared-pool counters
    // (`{runs, run_limit, models, model_limit, pinned_runs, pinned_models,
    // shared}`) instead of the desktop byte figure — the adapted class.
    RouteRow::adapted("GET", "/txr/history/usage"),
    RouteRow::allowed("GET", "/txr/history/{id}"),
    RouteRow::allowed("GET", "/txr/runs"),
    RouteRow::allowed("GET", "/txr/runs/{id}"),
    RouteRow::allowed("GET", "/txr/runs/{id}/logs"),
    RouteRow::allowed("GET", "/txr/runs/{id}/predictions"),
    RouteRow::allowed("GET", "/txr/runs/{id}/predictions.csv"),
    RouteRow::allowed("GET", "/txr/runs/{id}/stream"),
    RouteRow::allowed("GET", "/txr/model-sets"),
    RouteRow::allowed("GET", "/txr/models"),
    RouteRow::allowed("GET", "/txr/models/{id}"),
    // The qa-fixes3 "Use a model I saved" example flow calls this idempotent
    // endpoint to ensure the example set exists; the demo's three paths stay
    // (spec audit `/`), so it must be reachable. DRIFT-1 ITEM-1.
    RouteRow::allowed("POST", "/txr/models/example"),
    RouteRow::allowed("GET", "/txr/pretrained"),
    RouteRow::allowed("GET", "/txr/pretrained/downloads"),
    RouteRow::allowed("GET", "/txr/pretrained/{id}"),
    RouteRow::allowed("GET", "/txr/analysis-config"),
    // ─────────────────────────────── ADAPTED ───────────────────────────────
    RouteRow::adapted("POST", "/file-validation/inspect"),
    RouteRow::adapted("POST", "/file-validation/validate"),
    RouteRow::adapted("PUT", "/txr/analysis-config"),
    RouteRow::adapted("POST", "/txr/runs"),
    RouteRow::adapted("POST", "/txr/runs/{id}/rerun"),
    RouteRow::adapted("POST", "/txr/runs/{id}/stop"),
    RouteRow::adapted("POST", "/txr/runs/{id}/at-a-time"),
    RouteRow::adapted("POST", "/txr/runs/{id}/methods/{method_id}/stop"),
    RouteRow::adapted("POST", "/txr/runs/{id}/methods/{method_id}/skip"),
    RouteRow::adapted("POST", "/txr/models/save"),
    RouteRow::adapted("POST", "/txr/models/resolve"),
    RouteRow::adapted("POST", "/txr/models/eligibility"),
    RouteRow::adapted("POST", "/txr/pretrained/eligibility"),
    RouteRow::adapted("PUT", "/txr/history/preferences"),
    // ─────────────────────────────── BLOCKED ───────────────────────────────
    // The spec's blocked mutations (delete / rename / import / export / the
    // copy-clearing routes / pretrained install-download-refresh).
    RouteRow::blocked("DELETE", "/txr/model-sets/{id}"),
    RouteRow::blocked("DELETE", "/txr/models/{id}"),
    RouteRow::blocked("DELETE", "/txr/pretrained/{id}/download"),
    RouteRow::blocked("DELETE", "/txr/runs"),
    RouteRow::blocked("DELETE", "/txr/runs/{id}"),
    RouteRow::blocked("GET", "/txr/model-sets/{id}/export"),
    RouteRow::blocked("GET", "/txr/models/{id}/export"),
    RouteRow::blocked("PATCH", "/txr/model-sets/{id}"),
    RouteRow::blocked("PATCH", "/txr/models/{id}"),
    RouteRow::blocked("POST", "/txr/history/copies/clear"),
    RouteRow::blocked("POST", "/txr/history/{id}/copies/clear"),
    RouteRow::blocked("POST", "/txr/models/import"),
    // The method list never moves in demo mode (recorded runs replay the
    // built-in list), so the check is blocked like the pretrained refresh.
    RouteRow::blocked("POST", "/methods/updates/check"),
    RouteRow::blocked("POST", "/txr/pretrained/refresh"),
    RouteRow::blocked("POST", "/txr/pretrained/{id}/download"),
    RouteRow::blocked("POST", "/txr/pretrained/{id}/install"),
    // The framework surface the app does not use (the spec's "and every
    // other route" clause, made explicit row by row so the ONE table is the
    // complete classification).
    RouteRow::blocked("GET", "/auth/providers"),
    RouteRow::blocked("GET", "/auth/session-settings"),
    RouteRow::blocked("POST", "/auth/link-account"),
    RouteRow::blocked("POST", "/auth/login"),
    RouteRow::blocked("POST", "/auth/password"),
    RouteRow::blocked("POST", "/auth/profile"),
    RouteRow::blocked("POST", "/auth/register"),
    RouteRow::blocked("PUT", "/auth/session-settings"),
    // accounts
    RouteRow::blocked("GET", "/accounts"),
    RouteRow::blocked("GET", "/accounts/{account_id}/invitations"),
    RouteRow::blocked("GET", "/accounts/{account_id}/members/events"),
    RouteRow::blocked("GET", "/accounts/{account_id}/members/manage-context"),
    RouteRow::blocked("GET", "/accounts/{id}/members"),
    RouteRow::blocked("POST", "/account-invitations/accept"),
    RouteRow::blocked("POST", "/accounts"),
    RouteRow::blocked("POST", "/accounts/{account_id}/invitations"),
    RouteRow::blocked("POST", "/accounts/{account_id}/invitations/{invitation_id}/resend"),
    RouteRow::blocked("POST", "/accounts/{account_id}/members/leave"),
    RouteRow::blocked("DELETE", "/accounts/{account_id}/invitations/{invitation_id}"),
    RouteRow::blocked("DELETE", "/accounts/{account_id}/members/{user_id}"),
    RouteRow::blocked("PATCH", "/accounts/{account_id}/members/{user_id}"),
    // auth-providers (admin)
    RouteRow::blocked("GET", "/admin/auth-providers"),
    RouteRow::blocked("POST", "/admin/auth-providers"),
    RouteRow::blocked("POST", "/admin/auth-providers/test-config"),
    RouteRow::blocked("POST", "/admin/auth-providers/{id}/test"),
    RouteRow::blocked("PUT", "/admin/auth-providers/{id}"),
    RouteRow::blocked("DELETE", "/admin/auth-providers/{id}"),
    // features (admin)
    RouteRow::blocked("GET", "/admin/features"),
    RouteRow::blocked("PUT", "/admin/features/{flag_key}"),
    RouteRow::blocked("DELETE", "/admin/features/{flag_key}/account/{account_id}"),
    // files (the mountable txresbench-file surface)
    RouteRow::blocked("GET", "/files"),
    RouteRow::blocked("GET", "/files/{file_id}"),
    RouteRow::blocked("GET", "/files/{file_id}/download"),
    RouteRow::blocked("GET", "/files/{file_id}/head"),
    RouteRow::blocked("GET", "/files/{file_id}/preview"),
    RouteRow::blocked("GET", "/files/{file_id}/raw"),
    RouteRow::blocked("GET", "/files/{file_id}/text"),
    RouteRow::blocked("GET", "/files/{file_id}/text-rects"),
    RouteRow::blocked("GET", "/files/{file_id}/thumbnail"),
    RouteRow::blocked("GET", "/files/{file_id}/versions"),
    RouteRow::blocked("GET", "/files/{file_id}/versions/{version}"),
    RouteRow::blocked("GET", "/files/{file_id}/versions/{version}/download"),
    RouteRow::blocked("GET", "/files/{file_id}/versions/{version}/preview"),
    RouteRow::blocked("GET", "/files/{file_id}/versions/{version}/text"),
    RouteRow::blocked("POST", "/files/{file_id}/download-token"),
    RouteRow::blocked("POST", "/files/{file_id}/restore"),
    RouteRow::blocked("DELETE", "/files/{file_id}"),
    // mcp (platform furniture)
    RouteRow::blocked("GET", "/mcp/settings"),
    RouteRow::blocked("PUT", "/mcp/settings"),
    RouteRow::blocked("POST", "/mcp/agent/capabilities"),
    RouteRow::blocked("POST", "/mcp/agent/pong"),
    RouteRow::blocked("POST", "/mcp/agent/progress"),
    RouteRow::blocked("POST", "/mcp/agent/result"),
    RouteRow::blocked("POST", "/mcp/pair/exchange"),
    RouteRow::blocked("POST", "/mcp/pair/start"),
    // notifications
    RouteRow::blocked("GET", "/notifications"),
    RouteRow::blocked("GET", "/notifications/kinds"),
    RouteRow::blocked("GET", "/notifications/unread-count"),
    RouteRow::blocked("GET", "/notifications/{id}"),
    RouteRow::blocked("POST", "/notifications/read-all"),
    RouteRow::blocked("POST", "/notifications/{id}/read"),
    RouteRow::blocked("DELETE", "/notifications/{id}"),
    // sandbox (the desktop shell owns this surface; a public demo never does)
    RouteRow::blocked("GET", "/sandbox/status"),
    RouteRow::blocked("GET", "/sandbox/settings"),
    RouteRow::blocked("PUT", "/sandbox/settings"),
    RouteRow::blocked("GET", "/sandbox/envs"),
    RouteRow::blocked("GET", "/sandbox/envs/{env_id}"),
    RouteRow::blocked("DELETE", "/sandbox/envs/{env_id}"),
    RouteRow::blocked("POST", "/sandbox/method-run"),
    RouteRow::blocked("POST", "/sandbox/wsl/setup"),
    // sync
    RouteRow::blocked("GET", "/sync/subscribe"),
];

/// One row of [`ROUTE_POLICY`]: the HTTP method (uppercase), the path pattern
/// (api-prefix stripped, `{param}` placeholders) and the class.
pub struct RouteRow {
    pub method: &'static str,
    pub path: &'static str,
    pub class: RouteClass,
}

impl RouteRow {
    const fn allowed(method: &'static str, path: &'static str) -> Self {
        Self { method, path, class: RouteClass::Allowed }
    }
    const fn adapted(method: &'static str, path: &'static str) -> Self {
        Self { method, path, class: RouteClass::Adapted }
    }
    const fn blocked(method: &'static str, path: &'static str) -> Self {
        Self { method, path, class: RouteClass::Blocked }
    }
}

/// Extract the run id from a demo-run CONTROL path (stop / skip / at-a-time /
/// rerun on `/txr/runs/<id>/...`). `None` when the path is not one of the
/// five control shapes — the ownership check only runs on exactly those.
pub fn control_run_id(path: &str) -> Option<uuid::Uuid> {
    let segments: Vec<&str> = path.split('/').collect();
    // ["", "txr", "runs", <id>, ...]
    let id = match segments.as_slice() {
        ["", "txr", "runs", id, ..] => id,
        _ => return None,
    };
    let tail = &segments[4..];
    let is_control = matches!(tail, ["stop"] | ["at-a-time"] | ["rerun"])
        || matches!(tail, ["methods", _, "stop"] | ["methods", _, "skip"]);
    if !is_control {
        return None;
    }
    uuid::Uuid::parse_str(id).ok()
}

/// Counter for the doc: the count of framework-surface rows (the "N framework
/// routes are all blocked" test's number, derived from the table, never
/// hand-typed — the test asserts the counted value equals the spec-derived
/// framework surface so a new framework route fails with BOTH checks).
pub fn framework_blocked_count() -> usize {
    ROUTE_POLICY
        .iter()
        .filter(|r| r.class == RouteClass::Blocked && is_framework_path(r.path))
        .count()
}

/// Is this row part of the FRAMEWORK surface (i.e. the app does not use it)?
/// The app surface is the txr/methods/file-validation/markers/health/app/session
/// families + the auth session trio; everything else is framework furniture.
pub fn is_framework_path(path: &str) -> bool {
    !(path.starts_with("/txr/")
        || path.starts_with("/methods")
        || path.starts_with("/markers")
        || path.starts_with("/file-validation/")
        || matches!(path, "/health" | "/app/mode" | "/session/local"
            | "/auth/me" | "/auth/logout" | "/auth/refresh"))
}

/// Strip the configured API prefix (the middleware does this before
/// classifying; the whole-app layer sees the full request path). `None` when
/// the path is outside the API surface — non-API paths (e.g. the debug-only
/// `/__worktree` sentinel, compiled out of release) are never classified and
/// pass through the gate.
pub fn strip_api_prefix<'a>(api_prefix: &str, path: &'a str) -> Option<&'a str> {
    path.strip_prefix(api_prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_params_exactly_one_segment() {
        assert!(matches_row("/txr/runs/{id}/stop", "/txr/runs/abc-123/stop"));
        // A one-segment miss: the pattern has MORE segments than the path.
        assert!(!matches_row("/txr/runs/{id}/stop", "/txr/runs/abc-123"));
        assert!(!matches_row("/txr/runs/{id}/stop", "/txr/runs/abc-123/stop/extra"));
        // A `{param}` matches exactly ONE segment — an empty one is a miss.
        assert!(!matches_row("/txr/runs/{id}/stop", "/txr/runs//stop"));
    }

    #[test]
    fn classify_finds_exact_rows() {
        assert_eq!(classify("GET", "/txr/runs/{id}"), Some(RouteClass::Allowed));
        assert_eq!(classify("POST", "/txr/runs"), Some(RouteClass::Adapted));
        assert_eq!(classify("DELETE", "/txr/runs/{id}"), Some(RouteClass::Blocked));
        assert_eq!(classify("DELETE", "/sandbox/envs/{env_id}"), Some(RouteClass::Blocked));
        // Setting up WSL changes the machine (an elevated install): never in a demo.
        assert_eq!(classify("POST", "/sandbox/wsl/setup"), Some(RouteClass::Blocked));
        assert_eq!(classify("GET", "/no-such-route"), None);
    }

    #[test]
    fn control_run_id_parses_only_the_five_shapes() {
        let id = "b1e5f8d2-0000-4000-8000-000000000001";
        assert_eq!(control_run_id(&format!("/txr/runs/{id}/stop")), Some(uuid::Uuid::parse_str(id).unwrap()));
        assert_eq!(control_run_id(&format!("/txr/runs/{id}/at-a-time")), Some(uuid::Uuid::parse_str(id).unwrap()));
        assert_eq!(control_run_id(&format!("/txr/runs/{id}/rerun")), Some(uuid::Uuid::parse_str(id).unwrap()));
        assert_eq!(
            control_run_id(&format!("/txr/runs/{id}/methods/kelim/stop")),
            Some(uuid::Uuid::parse_str(id).unwrap())
        );
        assert_eq!(
            control_run_id(&format!("/txr/runs/{id}/methods/kelim/skip")),
            Some(uuid::Uuid::parse_str(id).unwrap())
        );
        // Not control shapes -> None (the gate never enforces ownership on them).
        assert_eq!(control_run_id("/txr/runs"), None);
        assert_eq!(control_run_id("/txr/runs/not-a-uuid/stop"), None);
        assert_eq!(control_run_id(&format!("/txr/runs/{id}")), None);
    }

    /// The table has no duplicate (method, path) pairs — a duplicate makes
    /// `find` order-dependent and the classification ambiguous.
    #[test]
    fn no_duplicate_rows() {
        let mut all: Vec<String> = ROUTE_POLICY
            .iter()
            .map(|r| format!("{} {}", r.method, r.path))
            .collect();
        let n = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), n, "duplicate rows in ROUTE_POLICY");
    }
}
