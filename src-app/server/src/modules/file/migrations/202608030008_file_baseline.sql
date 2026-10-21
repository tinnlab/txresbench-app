-- file module — SQUASHED BASELINE.
--
-- This single file replaces the module's pre-release incremental migration
-- history. The app was squashed to one baseline per module before first
-- release: the old chain created, ALTERed and then DROPped an earlier
-- domain-specific data model, so it carried retired domain vocabulary forward
-- in perpetuity for a schema that no longer contains it. An applied migration file
-- is byte-immutable (`sqlx::migrate!` checksums full file bytes — see the
-- `MERGED_MIGRATOR` doc in `src/database.rs`), so that vocabulary could not be
-- edited out in place; only a squash removes it.
--
-- Every DDL statement below is a VERBATIM `pg_dump --schema-only` rendering of
-- the schema the full chain produced, so the end state is identical to the
-- pre-squash schema — column ORDER included. Some columns therefore sit where an
-- `ALTER TABLE … ADD COLUMN` put them rather than in a tidier place; that is
-- deliberate, and it is what makes the identity mechanically provable.
--
-- The per-statement DESIGN RATIONALE the retired files carried is not
-- reproduced here (much of it narrated the very model that was dropped). It
-- lives in git history: `git log --diff-filter=D -p -- \
-- src-app/server/src/modules/file/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the SDK auth seed (the Users group).

-- == seed data + permission grants ====================================

-- Grant the ziee-file store permissions to the default Users group so a regular
-- user can upload a file and read/download it back (Administrators already hold
-- `*`). Idempotent (skip if already present).
--
-- Sorts after the auth seed (…144500 creates the Users group). The store's own
-- `files`/`file_versions` schema (…140125) carries no grant — that stays
-- app-side.
DO $$
DECLARE
    perm text;
BEGIN
    FOREACH perm IN ARRAY ARRAY[
        'files::read',
        'files::upload',
        'files::download',
        'files::delete',
        'files::preview',
        'files::generate_token'
    ] LOOP
        UPDATE public.groups
        SET permissions = array_append(permissions, perm)
        WHERE name = 'Users'
          AND NOT (perm = ANY (permissions));
    END LOOP;
END $$;
