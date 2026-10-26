-- Squashed module baseline (MIGRATE-squash / N3.1 / N7) — SQLite dialect.
-- Auth seed: system groups with CLEAN base permissions (N9 — domain perms
-- are granted by each owning module's data migration), default auth providers,
-- session settings singleton.
--
-- SQLite port notes: uuid values are 16-byte BLOBs (`X'…'` hex literals);
-- `text[]` values are JSON-array text (`["*"]`, not `{*}`); timestamps are
-- RFC3339 UTC text; booleans are 0/1.

INSERT INTO groups (id, name, description, permissions, is_system, is_active, is_default, created_at, updated_at) VALUES (X'F3A2B018A0EB45C198F9A616599C9EE4', 'Administrators', 'System administrators with full access to all features', '["*"]', 1, 1, 0, '2026-07-14T15:09:55.356Z', '2026-07-14T15:09:58.777Z');
INSERT INTO groups (id, name, description, permissions, is_system, is_active, is_default, created_at, updated_at) VALUES (X'79668B7816FF4D3F80E6AFDBB3236DC9', 'Users', 'Default group for all users', '["profile::read","profile::edit"]', 1, 1, 1, '2026-07-14T15:09:55.356Z', '2026-07-14T15:10:01.610Z');

INSERT INTO auth_providers (id, name, provider_type, enabled, config, created_at, updated_at, last_test_at, last_test_ok, last_test_message, client_secret_encrypted) VALUES (X'92E74A99FFA44C49A05F4A2B3E2B2EFE', 'google', 'oidc', 0, '{"scopes": ["openid", "email", "profile"], "client_id": "", "issuer_url": "https://accounts.google.com", "display_name": "Sign in with Google", "client_secret": "", "attribute_mapping": {"email": "email", "user_id": "sub", "username": "email", "last_name": "family_name", "first_name": "given_name", "display_name": "name"}}', '2026-07-14T15:09:57.221Z', '2026-07-14T15:09:57.221Z', NULL, NULL, NULL, NULL);
INSERT INTO auth_providers (id, name, provider_type, enabled, config, created_at, updated_at, last_test_at, last_test_ok, last_test_message, client_secret_encrypted) VALUES (X'824EB523BDA940DD8A06B71C5E1CED97', 'microsoft', 'oidc', 0, '{"scopes": ["openid", "email", "profile"], "client_id": "", "issuer_url": "https://login.microsoftonline.com/common/v2.0", "display_name": "Sign in with Microsoft", "client_secret": "", "attribute_mapping": {"email": "email", "user_id": "sub", "username": "preferred_username", "display_name": "name"}, "allowed_tenant_ids": []}', '2026-07-14T15:09:57.221Z', '2026-07-14T15:09:57.221Z', NULL, NULL, NULL, NULL);
INSERT INTO auth_providers (id, name, provider_type, enabled, config, created_at, updated_at, last_test_at, last_test_ok, last_test_message, client_secret_encrypted) VALUES (X'A159DEE029774F8DA8E568DC1A398C32', 'apple', 'apple', 0, '{"key_id": "", "scopes": ["name", "email"], "team_id": "", "services_id": "", "private_key_path": ""}', '2026-07-14T15:09:57.221Z', '2026-07-14T15:09:57.221Z', NULL, NULL, NULL, NULL);

INSERT INTO session_settings (id, access_token_expiry_hours, refresh_token_expiry_days, seeded_from_config, updated_at) VALUES (1, 24, 30, 0, '2026-07-14T15:10:00.732Z');
