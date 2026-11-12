-- Squashed module baseline (MIGRATE-squash / N3.1 / N7) — SQLite dialect.
-- Auth structural tables (ziee-auth owns identity schema).
--
-- SQLite port notes (the engine swap, DEC-8 type map):
--   * uuid -> BLOB (16 raw bytes; sqlx's sqlite `Uuid` mapping encodes/decodes
--     blobs, so `X'…'` hex literals appear in seeds and the app binds
--     `Uuid::new_v4()` values — there is no SQL-side `gen_random_uuid()`).
--   * text[] -> TEXT holding a JSON array (JSON1 `json_each` does membership);
--     the two GIN indexes on `permissions` have no SQLite equivalent (JSON1 has
--     no GIN) and are omitted — permission membership is read through `json_each`,
--     not an indexed containment operator.
--   * jsonb -> TEXT JSON text; `timestamp with time zone` -> TEXT RFC3339 UTC
--     (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` keeps lexicographic ==
--     chronological); boolean -> INTEGER 0/1; bytea -> BLOB.
--   * SQLite has no ALTER TABLE ADD CONSTRAINT: primary/unique/FK/CHECK
--     constraints are declared INLINE with the same names the Postgres chain
--     assigned by ALTER (see 202607144000_auth_fkeys.sql for the note).
--   * The `update_updated_at_column()` plpgsql function + BEFORE UPDATE
--     triggers become per-table AFTER UPDATE triggers that re-write the row's
--     `updated_at` (SQLite triggers cannot assign NEW columns; recursive
--     triggers are off by default, so the re-write does not re-fire).

CREATE TABLE auth_providers (
    id BLOB NOT NULL,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_test_at TEXT,
    last_test_ok INTEGER,
    last_test_message TEXT,
    client_secret_encrypted BLOB,
    CONSTRAINT auth_providers_name_key UNIQUE (name),
    CONSTRAINT auth_providers_pkey PRIMARY KEY (id)
);

CREATE TABLE groups (
    id BLOB NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT groups_name_key UNIQUE (name),
    CONSTRAINT groups_pkey PRIMARY KEY (id)
);

CREATE TABLE oauth_sessions (
    id BLOB NOT NULL,
    state TEXT NOT NULL,
    provider_id BLOB NOT NULL,
    pkce_verifier TEXT,
    nonce TEXT,
    redirect_uri TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    return_to TEXT,
    CONSTRAINT oauth_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_sessions_state_key UNIQUE (state),
    CONSTRAINT oauth_sessions_provider_id_fkey FOREIGN KEY (provider_id)
        REFERENCES auth_providers(id) ON DELETE CASCADE
);

CREATE TABLE pending_account_links (
    link_token TEXT NOT NULL,
    provider_id BLOB NOT NULL,
    target_user_id BLOB NOT NULL,
    external_id TEXT NOT NULL,
    external_email TEXT,
    external_data TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    CONSTRAINT pending_account_links_pkey PRIMARY KEY (link_token),
    CONSTRAINT pending_account_links_provider_id_fkey FOREIGN KEY (provider_id)
        REFERENCES auth_providers(id) ON DELETE CASCADE,
    CONSTRAINT pending_account_links_target_user_id_fkey FOREIGN KEY (target_user_id)
        REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE refresh_tokens (
    jti BLOB NOT NULL,
    user_id BLOB NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    rotated_to BLOB,
    CONSTRAINT refresh_tokens_pkey PRIMARY KEY (jti),
    CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE session_settings (
    id INTEGER NOT NULL DEFAULT 1,
    access_token_expiry_hours INTEGER NOT NULL DEFAULT 24,
    refresh_token_expiry_days INTEGER NOT NULL DEFAULT 30,
    seeded_from_config INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT access_token_expiry_hours_range CHECK (
        access_token_expiry_hours >= 1 AND access_token_expiry_hours <= 8760
    ),
    CONSTRAINT refresh_token_expiry_days_range CHECK (
        refresh_token_expiry_days >= 1 AND refresh_token_expiry_days <= 3650
    ),
    CONSTRAINT session_settings_id_check CHECK (id = 1),
    CONSTRAINT session_settings_pkey PRIMARY KEY (id)
);

CREATE TABLE user_auth_links (
    id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    provider_id BLOB NOT NULL,
    external_id TEXT NOT NULL,
    external_email TEXT,
    external_data TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at TEXT,
    CONSTRAINT user_auth_links_pkey PRIMARY KEY (id),
    CONSTRAINT user_auth_links_provider_id_external_id_key UNIQUE (provider_id, external_id),
    CONSTRAINT user_auth_links_provider_id_fkey FOREIGN KEY (provider_id)
        REFERENCES auth_providers(id) ON DELETE CASCADE,
    CONSTRAINT user_auth_links_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_groups (
    user_id BLOB NOT NULL,
    group_id BLOB NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    assigned_by BLOB,
    CONSTRAINT user_groups_pkey PRIMARY KEY (user_id, group_id),
    CONSTRAINT user_groups_assigned_by_fkey FOREIGN KEY (assigned_by)
        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT user_groups_group_id_fkey FOREIGN KEY (group_id)
        REFERENCES groups(id) ON DELETE CASCADE,
    CONSTRAINT user_groups_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE users (
    id BLOB NOT NULL,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    display_name TEXT,
    avatar_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_admin INTEGER NOT NULL DEFAULT 0,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at TEXT,
    password_changed_at TEXT,
    CONSTRAINT users_email_key UNIQUE (email),
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_username_key UNIQUE (username)
);

CREATE INDEX idx_auth_providers_enabled ON auth_providers (enabled);

CREATE INDEX idx_groups_name ON groups (name);

CREATE INDEX idx_oauth_sessions_expires_at ON oauth_sessions (expires_at);

CREATE INDEX idx_oauth_sessions_state ON oauth_sessions (state);

CREATE INDEX idx_pending_links_expires_at ON pending_account_links (expires_at);

CREATE INDEX idx_pending_links_target_user_id ON pending_account_links (target_user_id);

CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);

CREATE INDEX idx_refresh_tokens_user_active ON refresh_tokens (user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_user_auth_links_external_id ON user_auth_links (provider_id, external_id);

CREATE INDEX idx_user_auth_links_provider_id ON user_auth_links (provider_id);

CREATE INDEX idx_user_auth_links_user_id ON user_auth_links (user_id);

CREATE INDEX idx_user_groups_group_id ON user_groups (group_id);

CREATE INDEX idx_user_groups_user_id ON user_groups (user_id);

CREATE INDEX idx_users_created_at ON users (created_at);

CREATE INDEX idx_users_email ON users (email);

CREATE INDEX idx_users_is_active ON users (is_active);

CREATE INDEX idx_users_last_login_at ON users (last_login_at);

CREATE INDEX idx_users_lower_email ON users (lower(email));

CREATE INDEX idx_users_username ON users (username);

CREATE UNIQUE INDEX unique_root_admin ON users (is_admin) WHERE is_admin = 1;

-- SQLite port notes: the plpgsql BEFORE UPDATE trigger function is replaced by
-- an AFTER UPDATE trigger on each table that re-writes the row's `updated_at`
-- (SQLite triggers cannot assign NEW columns). The stamp is applied to every
-- UPDATE, matching the Postgres semantics of the original BEFORE trigger; the
-- re-write runs outside trigger activation, so it does not re-fire.
CREATE TRIGGER update_auth_providers_updated_at
AFTER UPDATE ON auth_providers
FOR EACH ROW
BEGIN
    UPDATE auth_providers
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = OLD.id;
END;

CREATE TRIGGER update_groups_updated_at
AFTER UPDATE ON groups
FOR EACH ROW
BEGIN
    UPDATE groups
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = OLD.id;
END;

CREATE TRIGGER update_user_auth_links_updated_at
AFTER UPDATE ON user_auth_links
FOR EACH ROW
BEGIN
    UPDATE user_auth_links
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = OLD.id;
END;

CREATE TRIGGER update_users_updated_at
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
    UPDATE users
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = OLD.id;
END;
