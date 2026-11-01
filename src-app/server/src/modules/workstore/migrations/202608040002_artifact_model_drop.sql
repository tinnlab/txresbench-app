-- workstore — the artifact model, DROP half (ITEM-7 + ITEM-8) — SQLite
-- dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040002_artifact_model_drop.sql`.
--
-- Stamped AFTER `202608040001_artifact_model.sql` (DEC-9: the additive half
-- lands first so the schema is never ahead of the code). Realizes the
-- design's §0.3 block verbatim: `artifacts − shape, params, covered_axes,
-- storage_layout; DROP TABLE workstore_axis_entry`; the table count goes
-- 38 → 37.
--
-- COLUMN COUNTS (the Postgres file's arithmetic, unchanged by the port):
-- the baseline declares 20 columns, `…0001` adds `structure` + `meta`
-- (22), this migration leaves 18, `…0003` adds `role` — the artifact
-- model's FINISHED shape is 19 columns. Note what these counts do NOT
-- describe: `…0001` wipes every artifact row on every path, so no in-place
-- migration of surviving rows happens on either engine.
--
-- SQLite port note (DEC-8 type map): `jsonb` -> TEXT, no `public.` prefix.
-- Construct delta: SQLite has supported `ALTER TABLE … DROP COLUMN` since
-- 3.35 — the four columns are dropped directly, and the drop is legal
-- because none of them is referenced by an index, constraint, trigger or
-- view over the whole chain (the `artifacts_natural_key` index keys on
-- project_id/dataset_id/run_id/output_id only; verified across the chain).
-- `DROP TABLE` needs no comment.

ALTER TABLE artifacts DROP COLUMN shape;
ALTER TABLE artifacts DROP COLUMN params;
ALTER TABLE artifacts DROP COLUMN covered_axes;
ALTER TABLE artifacts DROP COLUMN storage_layout;

-- The axis-entry table (ITEM-8, INV-3: an axis IS its key artifact; its
-- identity is the key artifact's content_hash, the axis NAME is a label,
-- never a key — see the Postgres file for the full rationale). Dropping it
-- also removes the only reason `copy_axes_to_project_in_tx` existed; the
-- artifact rows that now carry axis cardinality already cascade on project
-- delete via `artifacts.project_id`.
DROP TABLE workstore_axis_entry;
