# OME-TIFF dtype refusal — the dtypes OME-XML cannot express (#292)

**Status:** accepted. **Owner:** the writer (`spatial-types/compute/ome_writer.py`, #155/#176/#162).
**Reported by:** the round-3 blind design-conformance audit of #266, which measured the gap and
filed it rather than absorbing it. `docs/design/ome-tiff-sample-classification.md` §4 names it in
as many words: INV-5 there is *"scoped deliberately to the sample axis, and the gap that leaves
is named rather than implied"*. This is that gap.

## 1. The defect

`write_ome_tiff` has exactly two refusal taxonomies, and they were chosen so that **a bad image
costs ONE image rather than the import**:

* `ome_writer.ImageConversionError`
* `spatial_declarations.SpatialDeclarationError`

Both importers guard exactly those (plus `OSError`) around the whole per-image body —
`import_visium.py:995`, `import_xenium.py:1344`:

```python
except (ome_writer.ImageConversionError, SD.SpatialDeclarationError, OSError) as exc:
    skipped.append(f"{basename}: not emitted — {type(exc).__name__}: {exc}")
```

A dtype OME-XML has no `PixelType` for is in NEITHER taxonomy. `tifffile.OmeXmlError.__mro__` is
`(OmeXmlError, Exception, BaseException, object)` — not `RuntimeError`, not `ValueError`, not
`OSError` — so it propagates past both guards and **aborts the entire import**: the matrix, the
coordinates, the columns and the report, all lost to one unusual vendor image.

Reproduced end to end on `origin/main` (`301cd345`) through the REAL Xenium importer, not through
a mock: stage the prime fixture bundle, replace `morphology_focus/morphology_focus_0000.ome.tif`
with a plain `int64` MINISBLACK TIFF of the same plane, call `run_import`. `read_plane` accepts it
(its `YX`/`YXS` branch validates the AXIS ORDER and returns `series.asarray()` with no dtype
conversion — `read_image`'s own docstring states the same of its TIFF branch), and `run_import`
dies with `tifffile.OmeXmlError: data type 'int64' not supported`. Zero artifacts are written.

## 2. What is ACTUALLY escaping — measured, not the one that was found

The issue names `OmeXmlError`. Sweeping every dtype in `np.sctypeDict` (deduped by `dt.str`) plus
six non-numeric constructions, at `S in {None,1,2,3,4,5}`, through the real `write_ome_tiff` on
`301cd345` finds **THREE** escaping families, not one — three different exception types raised
from three different frames:

| family | dtypes | count | raised at | type | in the guards? |
|---|---|---|---|---|---|
| A | `int64`, `uint64`, `float16`, `float128`, `complex256` | 5 dtypes, **20 pairs** | `TiffWriter.__exit__` -> `close()` -> `_write_image_description()` -> `OmeXml.addimage` — the PixelType table | `tifffile.OmeXmlError` | **no** |
| B | `bytes`, `bytes32`, `datetime64`, `datetime64[s]`, `object`, `str`, `str128`, `timedelta64`, `timedelta64[s]`, `void16` | 10 dtypes, **40 pairs** | one frame EARLIER, in `TiffWriter.write`, at `sampleformat = {'u':1,'i':2,'f':3,'c':6}[datadtype.kind]` | bare **`KeyError`** | **no** |
| C | `void` — the UNSIZED `V0`, itemsize 0 | 1 dtype, **4 pairs** | `TiffWriter.write`, earlier still, on the zero-data path | bare **`ValueError`** (`truncate can only be used with imagej or shaped formats`) | **no** |

**64 escaping `(dtype, S)` pairs over 16 distinct dtype spellings.** All of them at `S in
{None,1,3,4}`; `S in {2,5}` is already refused by `READABLE_SAMPLE_COUNTS` before any of this is
reached. Family A's 20 is the count #266's audit reported — it saw the family the exception type
made visible and not the other two.

**Fixing A and leaving 44 is the shape this issue is about**, so the refusal is written against
the dtype, not against `tifffile`'s exception taxonomy. Family C is worth its own line because it
shows the taxonomy approach failing twice over: it arrives as a bare `ValueError` carrying the
SAME message the module's existing `S < 1` refusal already quotes, reached by a zero ITEMSIZE
instead of a zero sample count — i.e. one more spelling of a failure this module had already met
and closed on the shape axis.

The dtypes OME-XML CAN express are a closed, readable list — `tifffile`'s own table:

```
int8 int16 int32 uint8 uint16 uint32 float32 float64 complex64 complex128 bool
```

Everything numpy can produce that is not in that list is one of the two families above.

`tifffile` exposes exactly two exception classes (`OmeXmlError`, `TiffFileError`); neither
subclasses anything the guards catch.

## 3. The decision: REFUSE by name at the WRITER, against an explicit dtype allowlist

Three choices, each of which the issue puts as a real question rather than a mechanical wrap.

**Refuse, not convert.** `int64` tissue data is often `int32`-representable and `float16` is
always `float32`-representable, so a widening cast would keep the image — and would silently
change the dtype a consumer reads back, which is the same shape of defect #266 filed. It is also
not universally lossless: an `int64`/`uint64` value above `2**31` does not fit `int32`, and
`float128`/`complex256` do not fit `float64`/`complex128`. A cast that is lossless for some inputs
and lossy for others, with nothing in the artifact saying which, is exactly what this module's
`LOSSY_CODECS` refusal exists to prevent. The module's stated posture is *"Refusing rather than
guessing."*

**Refuse at EMIT, not at decode.** The constraint is OME-XML's `PixelType` vocabulary, which only
the writer knows. `write_ome_tiff` is reachable WITHOUT going through `read_image` — Xenium's
`xenium_image.read_plane` is a second producer, and the module's own `ndim` guard sits in the
writer for precisely this reason (*"made here because `write_ome_tiff` is reachable without going
through `read_image`"*). Refusing at decode would leave the writer's own contract with the hole
still in it and would need the same check written twice.

**Allowlist, not exception translation.** Catching `tifffile.OmeXmlError` and re-raising it as
`ImageConversionError` is the smaller edit and closes family A — 20 of the 64. It does NOT close
families B and C, which are a bare `KeyError` and a bare `ValueError` from different frames. An
explicit `OME_EXPRESSIBLE_DTYPES` allowlist,
checked before a byte is written, closes both with one named predicate — and it is the idiom this
module already uses for the same job (`READABLE_SAMPLE_COUNTS`, `LOSSLESS_CODECS`). It also
produces a message naming the dtype AND what OME-XML supports, which a translated `OmeXmlError`
("data type 'int64' not supported") cannot.

**And the guard is NOT widened in the importers.** Adding `tifffile.OmeXmlError` to both `except`
tuples spreads knowledge of a third-party library's exception types into two importers that
otherwise never name `tifffile` in a guard, and it would have to be repeated for every future
consumer of `write_ome_tiff` — *"a guarantee a new consumer has to volunteer for is a courtesy,
not a guarantee"* (`test_vendored_contract.py`). Converting at the writer boundary keeps the
taxonomy at two names, in one file, and both vendored copies inherit it byte-identically.

**A narrow backstop is kept.** The allowlist mirrors a table inside a pinned third-party library.
A `tifffile` upgrade that narrowed that table would silently re-open family A. So the
`TiffWriter` block additionally translates `tifffile.OmeXmlError` — ONE named type, never
`except Exception` — into `ImageConversionError`. `OmeXmlError` also carries `tifffile`'s own
non-dtype refusals ("ImageDepth not supported", "empty arrays not supported", "N dimensions not
supported"), all of which this system already refuses earlier but a future `tifffile` could raise
for a shape we admit.

**Two things about the backstop that have to be said, because getting them wrong is how a
backstop becomes a second bug:**

* **It is unreachable for a dtype today, and that is MEASURED rather than asserted.** The claim
  is only worth making if something observes WHICH mechanism refused, and `isinstance(exc,
  guards)` cannot: the backstop satisfies it exactly as well as the guard. The observable is
  `__cause__` — the backstop is `raise ... from exc` and so always carries the `OmeXmlError` it
  converted, while the up-front guard always carries `None`. The acceptance tests assert
  `__cause__ is None` over the named dtypes AND over the whole swept dtype space, which is what
  turns "the guard is what refuses" from a comment into a measurement. Without it a mutant whose
  guard covered only the non-numeric kinds — letting every dtype this issue NAMES fall through to
  the backstop, writing the whole plane to disk and then discarding it — passed the entire suite.
* **Its message reports and does not DIAGNOSE.** `OmeXmlError` is raised from ~14 sites in
  `tifffile`, and most are about the caller's arguments rather than the dtype ("dimension order
  not supported", "metadata Size{ax} does not match", "more than 8 dimensions"), several of them
  reachable from a bug in the `metadata` dict `write_ome_tiff` itself builds. A message asserting
  "the installed tifffile refuses something `OME_EXPRESSIBLE_DTYPES` admits — the two have
  drifted" would send a reader hunting a library drift that never happened. It states the
  library's own words and the array it was given, and stops.

## 4. Invariants

These are the promises this change may not reframe. INV-1 and INV-2 are lifted VERBATIM from the
sources named beside them.

- **INV-1** — *"An input whose ... this writer cannot emit correctly and usefully is REFUSED BY
  NAME, in the taxonomy the importers' guards catch, never guessed at"* — lifted from
  `docs/design/ome-tiff-sample-classification.md` INV-5, with its deliberate scoping to the sample
  axis removed: a dtype OME-XML cannot express is such an input, and it is refused by name too.
- **INV-2** — *"no input can abort the import"* — lifted verbatim from `ome_writer.py`'s
  `read_image` policy comment (which glosses it: *"losing one image must never cost the matrix,
  the coordinates, the columns and the report"*). The refusal must cost ONE image, end to end,
  through the real importer.
- **INV-3** — The refusal NAMES THE DTYPE and what OME-XML supports, so a user can act on it. A
  refusal a user cannot act on is a crash with better manners.
- **INV-4** — The refusal is NAMED, never broad. No `except Exception` around image emission: a
  genuine logic bug on an untested path must still propagate rather than be reported as a skipped
  image. This is `read_image`'s four-attempt history applied to the writer.
- **INV-5** — The three shipped `compute/ome_writer.py` copies stay BYTE-IDENTICAL. *"A vendored
  file that drifts is a second implementation wearing the first's name."*
- **INV-6** — Every dtype OME-XML CAN express still emits exactly the bytes it emitted before.
  This change refuses inputs that previously crashed; it moves nothing that previously worked.

## 5. What this change is NOT

It is not a widening of either importer's `except` tuple — those two lines are unchanged. It is
not a conversion of any pixel value. It is not a change to the BEHAVIOUR of `read_image` or
`read_plane`, whose contract (validate the axis order, return the file's own dtype) is
deliberately left as it is and is the reason the writer has to be the one that refuses.

> **Amended by #296.** `read_plane`'s DTYPE contract is still as described — it validates the
> axis order and returns the file's own dtype — but its FAILURE contract was changed by
> `docs/design/image-failure-provenance-refusal.md`: the `_PROGRAMMING_ERRORS` deny-list that
> re-raised six exception types was replaced by a raising-site discriminator, which this
> document's own §2 escape sweep is what found. The sentence above described the scope of #292
> and is left standing as that; it is not a claim about the file today.

One `read_image` COMMENT does change, and it is declared here rather than left for a reviewer to
find as scope drift. Its policy note referred to a `_PROPAGATE` constant that no longer exists:
it was real (`_PROPAGATE = (MemoryError, RecursionError)`, added by #155 FIX_ROUND-8) and was
deliberately removed by `6f2ee131` — "coverage replaces the exception filter" — which is attempt
3 in the four-attempt history that same comment narrates. The comment outlived the mechanism, so
a reader auditing this taxonomy goes looking for a filter whose REMOVAL is the thing attempt 4
rests on. That history is this design's own governing precedent for INV-4, so it is corrected
here and recorded in #298.

## 6. Known limitation, stated rather than discovered

The failing input is reachable through **Xenium** (its morphology image is a TIFF, and
`read_plane` passes the file's own dtype through) and **not** through Visium's bundle contract
today: `VENDOR_IMAGES` names two `.png` members, `read_image` dispatches on suffix, and the PIL
branch yields only `uint8`/`uint16`: it converts every mode to `RGB` EXCEPT `L` and `I;16`,
which it leaves alone (`im.convert("RGB" if im.mode not in ("L", "I;16") else im.mode)`) — so
`I` (int32) and `F` (float32) collapse to `uint8` rather than being passed through. So Visium's
end-to-end proof of this specific input does not exist and is not faked. Visium is covered three
ways instead — its own vendored `ome_writer` copy is exercised behaviourally by the same
parametrized suite, its guard tuple is read out of its source and asserted to name
`ImageConversionError`, and the copies are asserted byte-identical — and it inherits the closure
the moment a TIFF row joins `VENDOR_IMAGES`, which #266's design says is *"one `VENDOR_IMAGES`
row away"* (`cytassist_image.tiff`).

## 7. Related

* **#266** — the sample-axis classification fix. Its INV-5 names this gap and points here; §4 of
  that document is updated by this change to record the closure rather than the gap.
* **#289** — the other `read_image`/`read_plane` contract gap (the source photometric is
  discarded). Untouched.
* **#288** — widening `READABLE_SAMPLE_COUNTS`. Untouched.
