-- #251 — `users.email` uniqueness must be case-insensitive.
--
-- `users_email_key` (`UNIQUE (email)`, added in 202607140050_auth_schema.sql)
-- is byte-exact, so `bob@corp.com` and `BOB@CORP.COM` were two DISTINCT
-- principals. `POST /api/auth/register` is open self-registration, so anyone
-- holding a leaked invitation link for `bob@corp.com` could register the case
-- variant and satisfy an accept path that binds the redeemer on
-- `lower(trim(users.email))` — a total bypass of the recipient control.
--
-- ── why the Postgres CHECK becomes a functional UNIQUE index + guard
--    triggers in SQLite ──────────────────────────────────────────────────────
--
-- The Postgres fix is a table CHECK (`email = lower(email)`) plus the existing
-- plain `UNIQUE (email)`: the CHECK is what makes the stored data NORMALISED,
-- and the plain uniqueness then excludes a second principal. SQLite has no
-- `ALTER TABLE … ADD CONSTRAINT`, so a table CHECK cannot be attached to the
-- existing `users` table. The port substitutes two mechanisms that are native
-- to SQLite and give the same row-semantics:
--
--   * `CREATE UNIQUE INDEX … (lower(email))` — case-insensitive uniqueness is
--     enforced DIRECTLY, and it is what fails the migration if the table
--     already holds two rows differing only by case (the Postgres `DO` block
--     aborts on exactly that data instead of choosing a survivor); because it
--     is created BEFORE the normalising UPDATE, the failure happens with the
--     data untouched and the whole migration rolls back.
--   * `BEFORE INSERT`/`BEFORE UPDATE` guard triggers raising
--     `RAISE(ABORT, ...)` when `NEW.email <> lower(NEW.email)` — the database
--     itself refuses a non-normalised address, the same loud, un-mapped
--     failure a 23514 from the Postgres CHECK was: a writer that skipped
--     `auth::email::normalize_email` cannot silently create a second
--     principal. SQLite's `lower()` folds ASCII only, which is exactly the
--     set `normalize_email` accepts (the Postgres CHECK had the same
--     property under a C locale).
--
-- The Postgres design deliberately reserved NO index name ("there is nothing
-- to attribute a violation by and nothing to drop"), because Postgres index
-- names are schema-global and a `DROP INDEX IF EXISTS <reserved>` in a
-- migration could destroy an unrelated same-named index. SQLite index names
-- are database-global too, but nothing in this app drops indexes by name and
-- the error surface (`UNIQUE constraint failed: index
-- 'users_email_lower_uniq'`) names the enforcement directly; the port records
-- this as an accepted difference, not a silent one.
--
-- `idx_users_lower_email` (the NON-unique btree on `lower(email)` from the
-- base schema) is left exactly as it is, mirroring the Postgres chain: the
-- unique functional index enforces the invariant, the old index accelerates
-- the lookups and enforces nothing.
--
-- ── the Unicode seam (#260) ─────────────────────────────────────────────────
--
-- The writers lowercase in RUST; the guard folds in SQLITE. The two folds
-- agree exactly over printable ASCII and are collation-invariant, which is
-- why `auth::email::normalize_email` REFUSES anything outside printable ASCII
-- at every write path — that restriction is what makes this invariant
-- satisfiable by construction.
--
-- #260 tracks admitting non-ASCII addresses properly. Do not widen the
-- accepted character set without closing it: the guard breaks first, on the
-- register path, as a 500.
--
-- ── step 1: REFUSE to migrate data a human has to adjudicate ────────────────
--
-- Two rows differing only by case are two accounts. Merging or deleting either
-- one silently is a data-loss decision this migration has no standing to make
-- — and picking a winner is exactly the privilege-escalation the issue is
-- about. So it aborts, and an operator decides which account survives before
-- re-running. (The Postgres version named the colliding addresses; SQLite has
-- no exception-raiser outside triggers, so the failure is the index creation
-- itself, still a hard refuse with the data untouched.)
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));

-- ── step 2: normalise the rows that are left ────────────────────────────────
--
-- A single legacy non-ASCII row satisfies the unique index (only its
-- case-variant twin does not), so this UPDATE still has work to do. For any
-- row a writer produced the Rust and SQLite folds are identical; for a legacy
-- non-ASCII row the SQLite result is the one the guard judges by, so it is
-- also the right one to store.
--
-- Touching a row fires `update_users_updated_at`, so migrated rows get a fresh
-- `updated_at`. The `WHERE` keeps that to the rows that actually change.
UPDATE users
   SET email = lower(email)
 WHERE email <> lower(email);

-- ── step 3: make it an invariant ────────────────────────────────────────────
--
-- The CHECK-equivalent guards. Created AFTER the normalisation UPDATE so the
-- migration's own write is not judged by them; from here on every INSERT and
-- every email-changing UPDATE is refused with the constraint-shaped message.
CREATE TRIGGER users_email_is_lowercase_insert_guard
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.email <> lower(NEW.email)
BEGIN
    SELECT RAISE(ABORT, 'users_email_is_lowercase: users.email must be lowercase');
END;

CREATE TRIGGER users_email_is_lowercase_update_guard
BEFORE UPDATE OF email ON users
FOR EACH ROW
WHEN NEW.email <> lower(NEW.email)
BEGIN
    SELECT RAISE(ABORT, 'users_email_is_lowercase: users.email must be lowercase');
END;
