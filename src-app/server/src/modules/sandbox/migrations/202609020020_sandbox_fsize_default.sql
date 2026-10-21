-- Raise the sandbox RLIMIT_FSIZE default 2 GiB -> 64 GiB (#185 §4, owner ruling 2).
--
-- `fsize_bytes` caps every file written INSIDE a sandbox, including the archive
-- extraction the importer uses to expand a vendor bundle. At 2 GiB it is what
-- blocks Xenium IMPORT: upload itself already works since ac7c6b50 (#182), but a
-- Xenium morphology OME-TIFF exceeds 2 GiB on its own, so `extractall` died on the
-- write.
--
-- The number is derived from measured file sizes, not taste (DEC-6 /
-- docs/design/upload-limits-policy.md):
--   Xenium morphology.ome.tif, XOA 1.0.1 breast rep1   5,179 MB  (largest measured)
--   Xenium morphology.ome.tif, XOA 3.0.0 Prime 5K      3,078 MB
--   Xenium whole bundle per region                     7.56 / 9.86 GB
--   morphology OME-TIFF, design/#161 framing           5-50 GB
--   STARmap image deposit                              14.2 GB
-- 64 GiB clears the largest measured member by ~12.6x and the 50 GB design framing
-- by ~37%, and sits INSIDE the existing 1 MiB..256 GiB CHECK, so no bound moves and
-- sandbox_settings_fsize_bytes_check is untouched. The bound deliberately survives:
-- RLIMIT_FSIZE still stops a runaway analysis filling a >64 GiB volume with one
-- appending file, and an operator can still lower it at /settings/sandbox.

ALTER TABLE public.sandbox_settings
    ALTER COLUMN fsize_bytes SET DEFAULT 68719476736;

-- Raise EXISTING deployments too -- a column default alone would leave every
-- already-migrated database (including every dev DB in this repo) stuck at 2 GiB,
-- so the ruling would ship without taking effect anywhere it matters.
--
-- Conditional ON PURPOSE (DEC-7): only rows still holding the OLD SHIPPED DEFAULT
-- are raised. An operator who deliberately chose some other value keeps it -- an
-- unconditional UPDATE silently overwriting an admin's choice is the one thing a
-- settings migration must never do.
--
-- `fsize_bytes = 2147483648` is NOT sufficient on its own, though, and that was a
-- real hole: 2 GiB is a legal value inside the unchanged 1 MiB..256 GiB CHECK, so an
-- operator who deliberately pinned RLIMIT_FSIZE at exactly the old default is
-- indistinguishable from one who never touched it -- and would have had their choice
-- silently raised 32x, which is precisely what the paragraph above promises not to
-- do. `updated_by IS NULL` is the discriminator that actually separates the two: the
-- settings idiom stamps it on every admin PUT (added by 202608290010), so a NULL
-- means no human has ever written this row and the value present is the seed.
--
-- `updated_at` is stamped so the change is visible in the audit column rather than
-- the row claiming to be untouched since seeding while its effective per-file write
-- ceiling moved. `updated_by` stays NULL because no admin did this -- the migration
-- did.
UPDATE public.sandbox_settings
   SET fsize_bytes = 68719476736,
       updated_at  = now()
 WHERE fsize_bytes = 2147483648
   AND updated_by IS NULL;
