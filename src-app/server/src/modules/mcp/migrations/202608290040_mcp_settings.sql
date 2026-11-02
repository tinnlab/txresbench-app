-- MCP admin settings singleton (issue #54): agent/tool caps + pairing-TTL —
-- SQLite dialect port (ITEM-8, sqlite-store) of
-- `src/modules/mcp/migrations/202608290040_mcp_settings.sql`.
--
-- Mirrors `workstore_settings` / `sandbox_settings` / `billing_settings`: ONE row,
-- `id integer` PK with a CHECK(id = 1) so a second row is impossible, per-column
-- bounds CHECKs (the safety bound — DEC-3: an OOM/DoS cap is NEVER admin-raisable
-- unbounded), and an `updated_by` audit column.
--
-- Defaults EQUAL the compiled constants (INV-1: a deployment that never PUTs the
-- settings behaves byte-identically to today):
--   max_control_sessions    = 1024      (agent_channel.rs MAX_CONTROL_SESSIONS)
--   max_inflight_per_user   = 16        (agent_channel.rs MAX_INFLIGHT_PER_USER)
--   pairing_ttl_secs        = 300       (pairing.rs PAIRING_TTL_MINUTES=5 → 300s)
--   action_wall_clock_secs  = 900       (agent_channel.rs WALL_CLOCK_CAP=15*60)
--   max_list_results        = 200       (handlers.rs MAX_LIST_RESULTS)
--   max_result_bytes        = 1048576   (handlers.rs MAX_RESULT_BYTES = 1 MiB)
--
-- Admin-only (admins hold `*`), so NO group-grant statement — mirrors the
-- workstore settings migration (DEC-4).
--
-- SQLite port notes (ITEM-8, DEC-8 type map): `bigint` -> INTEGER, `boolean`
-- -> INTEGER 0/1 (the singleton `id` keeps `DEFAULT 1`), `timestamptz
-- DEFAULT now()` -> TEXT RFC3339 UTC with
-- `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, `uuid` -> BLOB, no `public.`
-- prefix, no `::` casts. The Postgres table was ALREADY created with all
-- constraints INLINE (a `CREATE TABLE IF NOT EXISTS` file), so the port is a
-- dialect change only — names preserved verbatim.
CREATE TABLE IF NOT EXISTS mcp_settings (
    id                     INTEGER     PRIMARY KEY DEFAULT 1,
    max_control_sessions   INTEGER     NOT NULL DEFAULT 1024,
    max_inflight_per_user  INTEGER     NOT NULL DEFAULT 16,
    pairing_ttl_secs       INTEGER     NOT NULL DEFAULT 300,
    action_wall_clock_secs INTEGER     NOT NULL DEFAULT 900,
    max_list_results       INTEGER     NOT NULL DEFAULT 200,
    max_result_bytes       INTEGER     NOT NULL DEFAULT 1048576,
    updated_at             TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_by             BLOB,
    CONSTRAINT mcp_settings_singleton_check        CHECK (id = 1),
    -- Agent session cap (OOM guard, DEC-3): 16 .. 16384.
    CONSTRAINT mcp_settings_control_sessions_bounds CHECK (max_control_sessions BETWEEN 16 AND 16384),
    -- Per-user in-flight cap (DoS guard, DEC-3): 1 .. 256.
    CONSTRAINT mcp_settings_inflight_bounds         CHECK (max_inflight_per_user BETWEEN 1 AND 256),
    -- Pairing-code TTL: 30s .. 1h.
    CONSTRAINT mcp_settings_pairing_ttl_bounds      CHECK (pairing_ttl_secs BETWEEN 30 AND 3600),
    -- Action wall-clock backstop: 30s .. 1h.
    CONSTRAINT mcp_settings_wall_clock_bounds       CHECK (action_wall_clock_secs BETWEEN 30 AND 3600),
    -- list_capabilities cap: 1 .. 2000.
    CONSTRAINT mcp_settings_list_results_bounds     CHECK (max_list_results BETWEEN 1 AND 2000),
    -- Result-byte ceiling (OOM guard, DEC-3): 1 KiB .. 64 MiB.
    CONSTRAINT mcp_settings_result_bytes_bounds     CHECK (max_result_bytes BETWEEN 1024 AND 67108864)
);

INSERT INTO mcp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
