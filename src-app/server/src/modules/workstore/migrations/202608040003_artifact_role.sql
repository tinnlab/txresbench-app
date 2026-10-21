-- workstore — `artifacts.role` as a FIRST-CLASS COLUMN.
--
-- Stamped after `202608040002_artifact_model_drop.sql` (DEC-9's ordering rule: the
-- schema is never ahead of the code, and this column's writer lands in the same
-- change).
--
-- ## Why this exists: a behaviour REGRESSION, not a new capability
--
-- `POST /datasets/promote` refused to promote a `role='intermediate'` output (DEC-8:
-- `artifact` is the promotable/export tier, `intermediate` is viz-only). The gate read
-- `artifacts.params.role`. ITEM-7 dropped `params`, so the gate lost its input and was
-- deleted — and its test `promote_rejects_intermediate_role` was deleted with it rather
-- than inverted. Nothing authorized that change: dropping `params` was about removing a
-- bag the SERVER synthesized by merging three manifest fields, and the collateral was a
-- rule that used to be enforced and silently stopped being.
--
-- ## Why a column and not a re-read of `meta`
--
-- `meta` is the producer's declaration of what an artifact MEANS, carried through
-- verbatim (ITEM-6). Reaching into it for a `role` key would put the server back in the
-- business of deriving its own operational decisions out of producer display data —
-- which is precisely what dropping `params` was meant to end, restated in a different
-- column. `role` is not display data: it is a first-class property of the artifact that
-- the SERVER acts on, exactly like `hidden` (which is likewise manifest-declared, stored
-- as its own boolean column, and read by a server-side listing rule). So it gets the
-- same treatment.
--
-- ## The default dance
--
-- Postgres cannot add a NOT NULL column with no default to a table with rows, so the
-- column lands WITH `'artifact'` and the default is then DROPPED. After that every write
-- must state the role, matching the no-default stance `structure`/`meta` took in `…0001`
-- (INV-2: absence is an error, not a silent empty value). That reason is UNCONDITIONAL
-- and it is the whole reason — the default is a mechanical requirement of
-- `ADD COLUMN … NOT NULL`, not a judgement about any data.
--
-- It used to read "(backfilling the pre-existing rows, every one of which was written
-- under the older manifest contract where an omitted role meant `artifact`, so the
-- backfill states what those rows always meant and asserts nothing new)". There is no
-- such backfill and there are no such rows: `…0001_artifact_model.sql:32` is an
-- unconditional `DELETE FROM public.artifacts;`, applied two migrations earlier in the
-- same boot pass, so `artifacts` is EMPTY when this statement runs — on a fresh database
-- and on an upgrading one alike. The default therefore touches zero rows on every
-- possible path, and the set of legacy rows it was justified by cannot exist.
--
-- Read together with `…0002`'s header, the withdrawn wording described an in-place column
-- migration of surviving artifacts. The actual upgrade destroys 100 % of `artifacts` and
-- nulls every `datasets.source_artifact_id`. The wipe itself is authorized and documented
-- (DECISIONS.md DEC-10, HUMAN_FEEDBACK.md FB-10) — it was only these two headers that
-- contradicted it.
--
-- Nothing normalizes on the way in any more, and that is deliberate: `artifact` is the
-- PROMOTABLE tier, so "if the manifest says nothing, assume `artifact`" made silence
-- resolve to the more privileged of the two values. The manifest contract now refuses an
-- omitted OR blank `role` outright (`sandbox::outputs::deserialize_declared_role`), so
-- the value written here is the producer's own and the column can never hold `''`.
ALTER TABLE public.artifacts ADD COLUMN role text NOT NULL DEFAULT 'artifact';
ALTER TABLE public.artifacts ALTER COLUMN role DROP DEFAULT;

COMMENT ON COLUMN public.artifacts.role IS
    'Producer-declared tier (DEC-8): `artifact` = promotable/exportable, `intermediate` = viz-only. Written at ingest verbatim from the manifest entry''s role, which is required and may not be blank; read by the promote gate. NOT NULL with no default.';

-- The promote gate reads it per row by id, but the column is also the natural filter for
-- "the promotable artifacts of this scope", which is a listing over a low-cardinality
-- value alongside an already-indexed scope column.
CREATE INDEX artifacts_role ON public.artifacts USING btree (role);
