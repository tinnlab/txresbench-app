//! `mcp` module permission. `mcp::use` is the SOLE gate on reaching the
//! AI-controllable-actions surface at all: the JSON-RPC endpoint, the agent
//! SSE stream, the agent up-endpoints, and `pair/start` (`pair/exchange` is
//! deliberately ungated — the one-time code IS the credential). Granted to
//! the default Users group by
//! `migrations/202608030007_mcp_baseline.sql` (mirrors the project baseline).
//!
//! Per-capability authorization is downstream, not here: a REST-kind
//! `invoke_capability` re-authorizes via the caller's forwarded JWT on the
//! real route (the target route's own `RequirePermissions` is the actual
//! gate); a frontend-kind `invoke_capability` is checked against the
//! manifest's declared `permission` via `principal_holds` BEFORE relay
//! (`mcp::handlers`) — CytoAnalyst is backend-authoritative for frontend
//! actions, never the browser engine.

use crate::modules::permissions::PermissionCheck;

pub struct McpUse;
impl PermissionCheck for McpUse {
    const NAME: &'static str = "McpUse";
    const PERMISSION: &'static str = "mcp::use";
    const DESCRIPTION: &'static str =
        "Let an external AI assistant (e.g. ziee chat) operate TxResBench on your behalf.";
    const MODULE: &'static str = "mcp";
}

// ─────────────────────── admin settings (issue #54) ───────────────────────
// The mcp agent/tool caps + pairing-TTL settings row. Admin-only (admins hold
// `*`), so no group-grant migration (DEC-4) — mirrors
// `modules/workstore/permissions.rs`. `NAME` becomes the emitted FE
// `Permissions.<Name>` constant (via `with_permission`'s 403 example);
// `PERMISSION` is what `RequirePermissions` checks.

/// Read the MCP settings (agent/tool caps + pairing-TTL).
pub struct McpSettingsRead;
impl PermissionCheck for McpSettingsRead {
    const NAME: &'static str = "McpSettingsRead";
    const PERMISSION: &'static str = "mcp::settings::read";
    const DESCRIPTION: &'static str = "View the MCP agent/tool caps and pairing-code TTL";
    const MODULE: &'static str = "mcp";
}

/// Manage (update) the MCP settings.
pub struct McpSettingsManage;
impl PermissionCheck for McpSettingsManage {
    const NAME: &'static str = "McpSettingsManage";
    const PERMISSION: &'static str = "mcp::settings::manage";
    const DESCRIPTION: &'static str = "Change the MCP agent/tool caps and pairing-code TTL";
    const MODULE: &'static str = "mcp";
}

#[cfg(test)]
mod tests {
    use super::*;

    // Drift-guard: this string backs the migration grant + the FE slot/route
    // gates + the sync audience once the FE connect surface lands.
    #[test]
    fn permission_string_is_stable() {
        assert_eq!(McpUse::PERMISSION, "mcp::use");
    }

    // TEST-5: the settings permission strings are stable — they back the FE
    // slot/route gates + the openapi-emitted `Permissions.McpSettings*` constants.
    #[test]
    fn settings_permission_constants_are_stable() {
        assert_eq!(McpSettingsRead::PERMISSION, "mcp::settings::read");
        assert_eq!(McpSettingsRead::NAME, "McpSettingsRead");
        assert_eq!(McpSettingsManage::PERMISSION, "mcp::settings::manage");
        assert_eq!(McpSettingsManage::NAME, "McpSettingsManage");
    }
}
