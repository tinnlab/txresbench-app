-- Generic, domain-agnostic notification inbox (SDK notification feature) —
-- SQLite dialect.
--
-- PROPOSED SDK CONTRIBUTION (see SDK_GAPS): the former txresbench-chat-specific
-- FK-nullable columns (scheduled_task_id / workflow_run_id / conversation_id)
-- are replaced by ONE `payload jsonb` column, so a module contributes its own
-- notification `kind` + kind-specific payload without the SDK schema knowing any
-- domain. The inbox stays strictly per-user (every query is `WHERE user_id`).
-- No FK to `users` in the crate migration (an app that has a users table adds
-- the constraint in its own module migration) — applies standalone on a fresh DB.
--
-- SQLite port notes (engine swap, DEC-8 type map): uuid -> BLOB (16 raw
-- bytes), jsonb -> TEXT JSON (`payload` round-trips as JSON text), boolean ->
-- INTEGER 0/1, `timestamp with time zone` -> TEXT RFC3339 UTC, `text` -> TEXT,
-- no `public.` schema prefix. The partial index on `read_at IS NULL` is
-- natively supported.

CREATE TABLE notifications (
    id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    interrupt INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}',
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT notifications_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);

CREATE INDEX idx_notifications_user_unread ON notifications (user_id) WHERE read_at IS NULL;
