# Upload and file-size limit policy

Status: accepted (owner ruling, 2026-09-02). Supersedes the deferred half of
[#185](https://github.com/ziee-ai/cytoanalyst/issues/185) §1 and closes DEC-7 of the
`streaming-upload` lifecycle (#182).

## The owner's position

> "we should not limit file size, that depends on user computer to process"

Two rulings follow from it. They are recorded here so the code, the tests and the
follow-on issues all cite the same source rather than each re-deriving intent.

---

## Ruling 1 — unlimited on desktop/self-hosted, a configurable ceiling in SaaS

Before this ruling the upload ceiling was `UPLOAD_BODY_LIMIT`, a compiled
`const … = 64 GiB` in `dataset/routes.rs` applied with
`DefaultBodyLimit::max(…)`, and `MAX_UPLOAD_PARTS`, a compiled `1024` in
`file/stream.rs`.

* **Desktop / self-hosted: no artificial cap.** The user's own disk is the limit.
  `DefaultBodyLimit::disable()` is the axum mechanism.
* **SaaS: keep a ceiling, but as an admin/plan setting, not a compiled constant**,
  defaulting high.

This is the promotion DEC-7 anticipated ("left as a single named `const` rather
than promoted to an admin settings row … naming it here keeps that a drop-in").

The desktop-vs-SaaS split is `#[cfg(feature = "saas")]`. `dataset/routes.rs` had
**no** saas/desktop distinction before this change, so one is introduced; it is
confined to the limit policy and does not spread.

### Fail-open is the wrong default here, but so is a surprise

If the SaaS ceiling setting is absent or unreadable the server falls back to the
**compiled default ceiling (64 GiB)** — never to unlimited. This mirrors the shipped
settings idiom (`SandboxResourceLimits::defaults()` is documented as "the cache
fallback if the DB read fails") and preserves exactly the pre-ruling behaviour for a
SaaS deployment that has never PUT the row. A misconfigured SaaS deployment
therefore degrades to the ceiling it always had, not to "unlimited".

### The part-count cap is a different axis and survives

`MAX_UPLOAD_PARTS` does not bound file SIZE; it bounds resident per-part state and
inode count ("small times unbounded is unbounded"). The owner's ruling is about file
size, so the cap keeps its value — but it stops being a compiled constant and moves
into the same settings row, read at use in both modes.

---

## Ruling 2 — raise the sandbox `fsize_bytes` default substantially

`sandbox/settings.rs` defaulted `fsize_bytes` (the `RLIMIT_FSIZE` applied to every
file written *inside* a sandbox, including archive extraction) to **2 GiB**, with a
validated range of 1 MiB – 256 GiB. That default is what prevents Xenium IMPORT;
upload itself already works since `ac7c6b50` (#182).

### Evidence for the new default

Measured file sizes from `docs/research/spatial-platforms/02-imaging-platforms.md`
(sizes read via HTTP range reads of the published bundles' ZIP central directories)
and `docs/research/spatial-upload-path-verification.md` §2.

**Both research files live on the unmerged branch `docs/research-spatial-platforms`,
not on `main`** — so cite them by commit, or the paths above dangle for anyone
reading this doc from `main`:

* `02-imaging-platforms.md` → commit **`2ba1bf0f`** ("docs(spatial-platforms):
  17-platform output survey + a stress test of the storage design"); the figures
  below are at lines 211-222 and 542.
* `spatial-upload-path-verification.md` → commit **`8e2853f9`**
  ("docs(spatial): verify the vendor-bundle upload path end to end (#151)"); §2's
  limit table is the source for the `RLIMIT_FSIZE` = 2 GiB row.

Recover either with `git show <sha>:<path>`. Every figure in the table below was
re-verified against those two commits on 2026-09-02; if the research branch merges,
the paths resolve directly and the SHAs remain valid.

| datum | value | source |
|---|---|---|
| Xenium `morphology.ome.tif`, XOA 3.0.0 Prime 5K human skin FFPE | **3,078 MB** | `02-imaging-platforms.md` (bundle 7.56 GB) |
| Xenium `morphology.ome.tif`, XOA 1.0.1 breast rep1 | **5,179 MB** (≈ 5.06 GiB) | `02-imaging-platforms.md` (bundle 9.86 GB) |
| Xenium `transcripts.zarr.zip` | 1,590 MB | `02-imaging-platforms.md` |
| Xenium `transcripts.parquet` | 945 MB | `02-imaging-platforms.md` |
| Xenium whole bundle, per region | **7–10 GB** (7.56 / 9.86 GB measured) | `02-imaging-platforms.md`, `07-references.md` |
| morphology OME-TIFF, design framing (#161) | 5–50 GB | quoted in `06-breaking-change-scenarios.md` |
| STARmap image deposit (another researched platform) | 14.2 GB | `02-imaging-platforms.md` |
| existing workstore per-file ingest ceiling | 8 GiB | `workstore/settings.rs` |

The binding number is the **largest single file an import must write inside the
sandbox**, because `RLIMIT_FSIZE` is per file, and the importer's `extractall`
expands a vendor bundle member-by-member to disk. The largest such member measured
is 5,179 MB; the design's upper framing for the same file is 50 GB.

**New default: 64 GiB** (`68719476736`). It clears the largest measured Xenium
member by ~12.6×, clears the design's 50 GB upper framing by ~37%, clears a whole
9.86 GB bundle written as a single file, and sits inside the already-validated
1 MiB – 256 GiB range, so no bound moves. It is the same magnitude as
`address_space_bytes` (64 GiB) and the retired `UPLOAD_BODY_LIMIT`.

### What this does and does not make possible

* It **does** remove the 2 GiB per-file write refusal inside the sandbox, which was
  the recorded blocker on extracting a Xenium morphology OME-TIFF.
* It **does not** demonstrate that Xenium import works end to end. That was not run.
  Sandbox memory, wall-clock budgets, the importer's format coverage and the
  downstream conversion are all untouched by this change and unverified here.

### Keep a bound

`RLIMIT_FSIZE` still exists so a runaway analysis cannot fill the disk, and that
reason survives the ruling: the owner asked for the *user's machine* to be the
constraint, not for the constraint to disappear. 64 GiB still refuses a single
unbounded appending file on any volume larger than 64 GiB, and it remains an admin
setting an operator can lower.

---

## The multipart-header exposure

`file/stream.rs` documents one case app-side code cannot bound: a part's multipart
**headers** are accumulated by `multer` inside axum's extractor before
`next_field()` returns, so a multi-GB `Content-Disposition` line is buffered whole
upstream of every app-side cap — bounded only by the body limit. Verified against
`multer 3.1.0`: `Multipart::poll_next_field` calls
`buffer.read_until(CRLF_CRLF)`, which returns `None` and keeps accumulating until
the terminator arrives; `MAX_HEADERS = 32` bounds the header *count* at parse time,
not the accumulated bytes. The only upstream bound is
`StreamBuffer::whole_stream_size_limit`, which is what `DefaultBodyLimit` supplies.

**Disabling the body limit therefore removes the only thing bounding that.** This
change does not leave it worse: it introduces an explicit **header-level bound**
that does not depend on the body limit —
`MAX_PART_HEADER_BYTES = 64 KiB`, enforced by a boundary-aware streaming scanner
wrapped around the request body upstream of `multer`, in **both** modes. 64 KiB is
2 KiB per header at multer's own 32-header ceiling, i.e. far above any real
`Content-Disposition` (filenames are OS-bounded at 255 bytes) and far below anything
that costs the process. Over it is `413 UPLOAD_FIELD_TOO_LARGE` — a part's headers
are part of a field, so no new error code is introduced and both OpenAPI specs stay
accurate.

## Error-code reachability by mode

The three `413`s and the `507` stay declared on all three upload operations in both
specs. Their reachability changes in exactly one place, which the operation
descriptions now say:

| code | desktop / self-hosted | SaaS |
|---|---|---|
| `UPLOAD_TOO_LARGE` | not reachable (no body ceiling) | reachable at the configured ceiling |
| `UPLOAD_FIELD_TOO_LARGE` | reachable (text-field cap, part-header cap) | reachable |
| `UPLOAD_TOO_MANY_PARTS` | reachable (part-count cap) | reachable |
| `UPLOAD_STORAGE_UNAVAILABLE` | reachable | reachable |

## Invariants

These are the non-negotiables the implementation may not reframe.

* **INV-1**: "we should not limit file size, that depends on user computer to
  process" — on desktop/self-hosted there is no artificial upload size cap.
* **INV-2**: "SaaS: keep a ceiling, but as an admin/plan setting, not a compiled
  constant, defaulting high."
* **INV-3**: "Do not let 'unlimited' become the accidental behaviour of a
  misconfigured SaaS deployment."
* **INV-4**: "Keep a bound. The limit exists so a runaway analysis cannot fill the
  disk, and that reason survives the ruling."
* **INV-5**: "Do not regress the memory fix." Peak RSS stays bounded by a constant,
  not by file size.
* **INV-6**: "Disabling the body limit therefore removes the only thing bounding
  that" — the multipart-header exposure must not be silently made worse; a
  header-level bound is kept.
