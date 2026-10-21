-- workstore — split the ONE byte column into the TWO quantities it was answering.
--
-- `size_bytes` was written at ingest as *bytes handed to the object store* and read at
-- six places. Exactly ONE of those six (`provenance::export::bundle`, the export size cap
-- and the `fetch.txt` transfer manifest) was asking a STORAGE question. The other five —
-- the project footprint badge, the dataset artifact-group totals, their JS mirror, the
-- dataset hover summary, and the workbench StatCard — were asking a LOGICAL one: *how big
-- is this data*. For every artifact that owns a blob the two answers coincide, so nothing
-- ever surfaced the confusion.
--
-- A GATHERED artifact (ITEM-16) is where they come apart. It has no blob, so its honest
-- STORAGE answer is 0 bytes — true, and exactly what the export cap needs. Its LOGICAL
-- size is `rows × element width`, which is what `gather_exec::gathered_size_bytes` has
-- always computed and what the five display consumers wanted. Reading the storage number
-- for a display question produced `Rows: 500000 · Cols: 1 · Size: 0 Bytes` on the
-- StatCard, and silently understated every byte total that summed a gathered row.
--
-- Patching the five call sites would have left the NEXT consumer free to make the same
-- mistake, because both readings still spell `size_bytes`. So the two quantities are two
-- columns with two names, and the display quantity is nullable:
--
--   * `stored_bytes`  NOT NULL — bytes written to the object store. 0 for a gathered
--                     artifact, and that 0 is CORRECT. The only reader is the export
--                     path. Renamed (not re-purposed) so a reader has to say which
--                     question it is asking.
--   * `logical_bytes` NULL     — the size the data represents when materialised. NULL
--                     means genuinely UNKNOWN, which is the honest answer where no width
--                     is derivable (a split string column's values are data-dependent).
--                     Nullable on purpose: it is what forces every consumer, in Rust and
--                     through the generated TypeScript, to decide what to render when
--                     there is no answer, instead of rendering a fabricated `0 Bytes`.
--
-- Backfill: an artifact with a blob has `logical_bytes = stored_bytes` — that is the
-- number those five consumers have been displaying all along, and it is right for a
-- stored artifact, so no total moves. A pre-existing GATHERED row (`object_key IS NULL`)
-- is left NULL rather than back-computed: its element width lives in `structure` in a
-- form only the gather resolver reads, and inventing one here is the guess this whole
-- change exists to stop. New gathered rows get their width computed at insert.

-- `usable_artifacts` expanded `SELECT *` at CREATE time, so it holds the OLD column name
-- and a base-table rename does not reach it. Drop and recreate — the definition below is
-- verbatim from 202608040006, whose comment is the reference for why it is a view.
DROP VIEW public.usable_artifacts;

ALTER TABLE public.artifacts RENAME COLUMN size_bytes TO stored_bytes;
ALTER TABLE public.artifacts ADD COLUMN logical_bytes bigint;

UPDATE public.artifacts SET logical_bytes = stored_bytes WHERE object_key IS NOT NULL;

CREATE VIEW public.usable_artifacts AS
    SELECT * FROM public.artifacts
     WHERE status = 'ready'
       AND NOT hidden
       AND role = 'artifact';

COMMENT ON VIEW public.usable_artifacts IS
    'The USABLE artifact population: status=ready, not hidden, role=artifact. Any count or byte total a user reads as "what is in here" is computed over THIS, not over `artifacts`. `artifacts` itself is the PRESENT population (everything stored, whatever its state) and is what the blob keep-set and delete cascade must use. Do not hand-write this predicate.';

COMMENT ON COLUMN public.artifacts.stored_bytes IS
    'Bytes written to the object store. 0 for a GATHERED artifact, which owns no blob — and that 0 is the correct storage answer. Read ONLY where the question is genuinely about bytes on disk (the provenance export size cap and fetch.txt). NEVER render this as "Size": use logical_bytes.';

COMMENT ON COLUMN public.artifacts.logical_bytes IS
    'The size the data REPRESENTS when materialised, for display and for any byte total a user reads. Equals stored_bytes for an artifact with a blob; rows x element width for a gathered one. NULL means genuinely unknown (no derivable element width) — render it as unknown, never as 0.';
