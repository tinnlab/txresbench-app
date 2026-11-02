-- workstore — `artifacts.role` as a FIRST-CLASS COLUMN — SQLite dialect port
-- (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040003_artifact_role.sql`.
--
-- Stamped after `202608040002_artifact_model_drop.sql` (DEC-9: the schema is
-- never ahead of the code). Why a column and not a re-read of `meta`, and
-- why the promote gate needs it: see the Postgres file — `role` is not
-- display data; it is a first-class property the SERVER acts on, exactly
-- like `hidden`, and it sits beside the no-default stance `structure`/`meta`
-- took in `…0001` (INV-2: absence is an error, not a silent empty value).
-- The manifest contract refuses an omitted OR blank `role` outright, so the
-- column can never hold `''` and nothing normalizes on the way in.
--
-- SQLite port note (ITEM-9, DEC-8 type map): `uuid`/jsonb rules per the
-- baseline, no `public.` prefix. Construct delta — **the default dance**:
-- Postgres lands the column as `NOT NULL DEFAULT 'artifact'` and then DROPS
-- the default (a mechanical requirement of `ADD COLUMN … NOT NULL` on a
-- table with rows — documented in the Postgres file as touching ZERO rows,
-- because `…0001`'s wipe leaves `artifacts` empty when this statement runs).
-- SQLite has no `ALTER COLUMN … DROP DEFAULT`, so the port declares the
-- POST-DROP-DEFAULT state directly: `ADD COLUMN role TEXT CHECK (role IS
-- NOT NULL)` — NOT NULL with no default, at the cost of never having a
-- transient default that would have touched zero rows anyway. The end state
-- is identical: every write after this migration must state the role, and a
-- row omitting it is refused (pinned by the harness). The promote gate
-- reads it per row by id; the column is also the natural filter for "the
-- promotable artifacts of this scope".

ALTER TABLE artifacts ADD COLUMN role TEXT CHECK (role IS NOT NULL);

CREATE INDEX artifacts_role ON artifacts (role);

-- Producer-declared tier (DEC-8): `artifact` = promotable/exportable,
-- `intermediate` = viz-only. Written at ingest verbatim from the manifest
-- entry's role, which is required and may not be blank; read by the promote
-- gate. NOT NULL with no default.
