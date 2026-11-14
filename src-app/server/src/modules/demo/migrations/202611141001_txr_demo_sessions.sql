-- demo module — anonymous visitor sessions + run-creator ownership (demo-mode ITEM-1).
--
-- `txr_demo_sessions`: one row per anonymous browser visit. The random `id`
-- is the cookie value (`txr_demo_session`); `user_id` is the visit's
-- `users` row (the demo role with only the allowed capabilities — the auth
-- machinery validates + loads it on every gated request). `last_seen_at`
-- feeds ITEM-4's stale-session reaper.
--
-- `txr_demo_run_sessions`: the "a run records the session that created it"
-- rule — one row per run started by a demo session. Kept OUT of `txr_runs`
-- (the engine's own table, PROV-EE-10) so the engine's SQL/rows stay
-- byte-identical; reads + writes are this module's, and the row cascades
-- with the run (foreign_keys=ON is the DEC-7 pragma profile).
--
-- SQLite dialect per PROV-sqlite-store-4: uuid BLOB 16 bytes, timestamps
-- TEXT RFC3339 UTC (`strftime(...)` default), ids assigned app-side.

CREATE TABLE txr_demo_sessions (
    id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT txr_demo_sessions_pkey PRIMARY KEY (id)
);

CREATE INDEX txr_demo_sessions_last_seen_idx ON txr_demo_sessions(last_seen_at);

CREATE TABLE txr_demo_run_sessions (
    run_id BLOB NOT NULL,
    session_id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT txr_demo_run_sessions_pkey PRIMARY KEY (run_id),
    CONSTRAINT txr_demo_run_sessions_run_fk FOREIGN KEY (run_id) REFERENCES txr_runs(id) ON DELETE CASCADE
);
