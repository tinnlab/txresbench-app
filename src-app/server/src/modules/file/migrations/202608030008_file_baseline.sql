-- file module — SQUASHED BASELINE — SQLite dialect port (ITEM-8, sqlite-store)
-- of `src/modules/file/migrations/202608030008_file_baseline.sql`.
--
-- The Postgres file carries the squash provenance (a VERBATIM `pg_dump
-- --schema-only` rendering). This module's baseline carries NO tables — the
-- `files`/`file_versions` store schema lives app-side in the SDK-owned
-- `txresbench-file` crate (its SQLite twin: `sdk/crates/txresbench-file/
-- migrations-sqlite/202607140125_file_schema.sql`) — and this file's job is
-- the PERMISSION GRANTS for the store.
--
-- Port note (ITEM-8, DEC-8/DEC-12): the plpgsql `DO $$ … FOREACH … $$` block
-- (Postgres-only procedural SQL) becomes six plain UPDATE statements, each
-- appending ONE permission to the `groups.permissions` JSON-array text via
-- JSON1 `json_insert(permissions, '$[#]', p)` guarded by a `json_each`
-- membership check (the port of `array_append` + `NOT (p = ANY (permissions))`,
-- idempotent per permission, exactly the Postgres loop's semantics).
--
-- Ordering: applies after the SDK auth seed (…144500 creates the Users
-- group; the auth seed's group permissions are already JSON-array text in
-- the SQLite chain). CONSEQUENCE (unchanged from the Postgres file): a
-- database created before the squash MUST BE RECREATED.

-- Grant the txresbench-file store permissions to the default Users group so a regular
-- user can upload a file and read/download it back (Administrators already hold
-- `*`). Idempotent (skip if already present), one permission per UPDATE.
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'files::read')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'files::read');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'files::upload')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'files::upload');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'files::download')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'files::download');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'files::delete')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'files::delete');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'files::preview')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'files::preview');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'files::generate_token')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'files::generate_token');
