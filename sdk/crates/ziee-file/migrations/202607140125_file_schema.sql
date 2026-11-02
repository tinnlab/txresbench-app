-- Squashed module baseline (MIGRATE-squash / N3.1 / N7) — SQLite dialect.
-- file module tables + indexes + triggers.
--
-- SQLite port notes (engine swap, DEC-8 type map): uuid -> BLOB (16 raw
-- bytes), bigint/integer -> INTEGER, jsonb -> TEXT JSON (the GIN index on
-- `processing_metadata` has no SQLite equivalent — JSON1 has no GIN — and is
-- omitted: the metadata is read as whole JSON text), `timestamp with time
-- zone` -> TEXT RFC3339 UTC, boolean -> INTEGER 0/1, `character varying` ->
-- TEXT, no `public.` schema prefix. The partial unique index
-- `uq_file_versions_head` is natively supported.

CREATE TABLE file_versions (
    id BLOB NOT NULL,
    file_id BLOB NOT NULL,
    version INTEGER NOT NULL,
    is_head INTEGER NOT NULL DEFAULT 0,
    blob_version_id BLOB NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    checksum TEXT,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    preview_page_count INTEGER NOT NULL DEFAULT 0,
    text_page_count INTEGER NOT NULL DEFAULT 0,
    processing_metadata TEXT NOT NULL DEFAULT '{}',
    source_message_id BLOB,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT file_versions_file_id_version_key UNIQUE (file_id, version),
    CONSTRAINT file_versions_pkey PRIMARY KEY (id)
);

CREATE TABLE files (
    id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    checksum TEXT,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    preview_page_count INTEGER NOT NULL DEFAULT 0,
    text_page_count INTEGER NOT NULL DEFAULT 0,
    processing_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by TEXT NOT NULL DEFAULT 'user',
    current_version_id BLOB NOT NULL,
    CONSTRAINT files_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_file_versions_blob ON file_versions (blob_version_id);

CREATE INDEX idx_file_versions_file ON file_versions (file_id, version DESC);

CREATE INDEX idx_files_checksum ON files (checksum);

CREATE INDEX idx_files_created_at ON files (created_at DESC);

CREATE INDEX idx_files_file_size ON files (file_size);

CREATE INDEX idx_files_mime_type ON files (mime_type);

CREATE INDEX idx_files_user_id ON files (user_id);

CREATE UNIQUE INDEX uq_file_versions_head ON file_versions (file_id) WHERE is_head;
