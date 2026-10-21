# Image-failure provenance refusal — separating a BUG from a BAD IMAGE by the RAISING SITE (#296, #297, #298)

Closes the three escapes the #292 sweep found still reaching past the importers' per-image
guards. #292 asked "determine whether other exceptions can reach the same path"; these are the
answer, and they are one family with one shared mechanism plus two site-local repairs.

## 1. The one invariant, and the three ways it is still broken

Both importers write the same guard around the whole per-image body:

```python
except (ome_writer.ImageConversionError, SD.SpatialDeclarationError, OSError) as exc:
    skipped.append(f"{basename}: not emitted — {type(exc).__name__}: {exc}")
```

so that **"no input can abort the import"** — losing one image must never cost the matrix, the
coordinates, the columns and the report. An exception outside that tuple aborts everything.

| issue | site | what escapes | why it is there |
|---|---|---|---|
| **#296** | `xenium_image.read_plane` | `ZeroDivisionError`, `TypeError`, `IndexError`, `AttributeError`, `KeyError`, `NameError` — **re-raised on purpose** by `_PROGRAMMING_ERRORS` | a deny-list of "bug types", to stop a typo in that file being laundered into an accusation about the vendor's file |
| **#297** | `write_ome_tiff` | `MemoryError` from `np.ascontiguousarray`, and any encode-time `tifffile` refusal not pre-empted by the dtype/shape guards | the allocation is outside every `try`; the `TiffWriter` block has a `finally` and only one named `except` |
| **#298** | four smaller sites | `tifffile.TiffFileError` from a second file open; `ImportError` from deferred imports outside their `try`; `TypeError`/`KeyError` inside `_reconcile_scale`; the visium handler's own `KeyError` | each is a site the conversion never reached |

They are the SAME family: an image-path failure whose exception type is outside the tuple the
importers guard. **#296 and #297 and #298's E1/E2/E3 are the same MECHANISM too** — a failure
arriving from code this tree does not own, at a boundary that promised to convert it. #298's E4
is the one genuinely different mechanism (a handler that raises WHILE handling) and is repaired
in place rather than by the shared mechanism; it is kept on this branch because it is the same
invariant, one line, and in the same `except` body.

## 2. #296 is a DECISION, not a patch: what actually separates a bug from bad data

The deny-list's intent is legitimate and is NOT reverted. Its comment records a real,
mutation-proved defect: a typo in `xenium_image.py` came back to the user as
*"images_not_emitted: not a readable Xenium OME-TIFF"* with the import reporting SUCCESS.

But the module's own four-attempt history in `ome_writer.read_image` already measured that two
of those six types arrive **from data**:

> 3. an ALLOW-list of decoder errors — ... a TIFF with a zeroed dimension tag
>    (`ZeroDivisionError` inside `tifffile.detect_series`)

and `ome_writer.py` states verbatim that *"`tifffile` raises `TypeError` on malformed tags"*.
So the deny-list is attempt 2 reintroduced, in a sibling file, against a classification this
module had already disproved.

### The measurement

Every claim below was RUN against the installed `tifffile` 2025.5.10, at `e0276408`:

| input | exception | INNERMOST traceback frame |
|---|---|---|
| a TIFF with `ImageWidth` zeroed | `ZeroDivisionError` | `tifffile.py:4855` |
| a TIFF with `ImageLength` zeroed | `ZeroDivisionError` | `tifffile.py:4855` |
| `pages[i]` past the end of a series | `IndexError` | `tifffile.py:12535` |
| MUTANT: `series.axess` | `AttributeError` | `xenium_image.py` (own frame) |
| MUTANT: `_channel_index(names, pages, path)` | `TypeError` | `xenium_image.py` (own frame) |
| MUTANT: `selection["channel_nmae"]` | `KeyError` | `xenium_image.py` (own frame) |
| MUTANT: `pagez[index]` | `NameError` | `xenium_image.py` (own frame) |

The four MUTANT rows carry no line number on purpose: they were cited by line and every one
went stale the first time the file's comments grew, which teaches a reader to distrust the half
of the table that IS exact (the `tifffile.py` citations are pinned to the installed 2025.5.10
and were re-verified by a blind audit). The mutants themselves are executable — see
`_READ_PLANE_BUG_MUTANTS`.

The three mutation-proved bugs the deny-list exists for **all raise in this file's own frame**.
Every measured data-caused failure **raises inside the library**. The type does not separate
them. **The raising SITE does.**

### The decision

Replace the deny-list with a **provenance discriminator**: at the boundary, the innermost
traceback frame is the raising site.

* raised by a line **in this module's own file** → a bug in this file → **propagate unchanged**;
* raised **inside a library this file called** → the library refused our input → **convert to
  `ImageConversionError`**, naming the original type.

This is not a fourth exception filter. Attempts 2 and 3 both failed because they GUESSED a
partition of the exception TYPE space; `downsample`'s own docstring concludes *"no exception
filter separates a bad input from a bug"*. That conclusion is correct and this mechanism does
not contradict it — it does not filter on the type at all. It asks the only question that was
ever being approximated: *did OUR code raise this, or did we hand a library something it
refused?*

### Where it is wrong, and which way that errs

Four limitations, stated rather than discovered. The first two are the **declared carve-outs** —
the only two places this mechanism decides on the exception TYPE, and the only two it may have
without a further design edit (`ome_writer._SITE_RULE_IS_BLIND_TO`, pinned structurally and
behaviourally by TEST-15).

1. **A C-extension frame is invisible to a Python traceback.** A `MemoryError` raised inside
   `numpy.ascontiguousarray` is attributed to the CALLING Python line — ours. So numpy-raised
   failures read as our own bug. That is why `MemoryError` is a **declared carve-out**, always
   converted, on the argument `read_image` already wrote down: a 170-megapixel 16-bit RGBA
   image allocates ~1.4 GB under PIL's bomb threshold, so resource exhaustion here is *"an
   input-caused abort wearing a resource-shaped exception"*. Re-measured under `RLIMIT_AS`: the
   traceback is one frame deep and that frame is the caller's.
2. **`importlib` raises a MISSING module on the `import` statement's own line** — so a deferred
   `import tifffile` inside a boundary is attributed to the boundary. This is why moving those
   imports inside their `try` (§3, #298 E2) accomplished nothing on its own: the site rule then
   re-raised them and the abort was unchanged. `ImportError` is therefore the **second declared
   carve-out**, and it is the narrowest thing in this design because every widening of it was
   measured laundering something. It took three corrections, each from a blind round, and the
   shipped rule is the conjunction of all three:

   | it converts only when | because otherwise |
   |---|---|
   | the failure was raised in OUR frame | asking `exc.name` first short-circuited the site rule, so a library that is PRESENT BUT BROKEN (Pillow's hand-constructed `_imaging` signal, `exc.name is None`; or a missing TRANSITIVE dependency) propagated and aborted the import — E2 re-opened |
   | it is a `ModuleNotFoundError`, not a plain `ImportError` | `from PIL import Imagee` raises a plain `ImportError` whose `.name` is the PACKAGE, so a typo of ours matched the list and came back as a skipped image |
   | the ROOT PACKAGE of `exc.name` is one this file imports | a half-installed wheel reports the dotted `PIL.Image`, which matched nothing, so an environment fact aborted the import |

   The one case those three cannot separate — a typo'd SUBMODULE of a declared package, which
   is indistinguishable from a half-installed wheel — is removed **by construction**: no
   boundary imports a dotted or relative module, and `test_every_boundary_import_is_a_plain_declared_module` keeps that true.

   `_DECLARED_LIBRARIES` is **derived from this file's own boundary imports**, by `ast`, as an
   EQUALITY. It is deliberately NOT read from the manifests: this file is vendored
   byte-identically into three packages whose manifests disagree (`spatial-import-visium` says
   `imagecodecs` is *"deliberately NOT declared"*, `spatial-import-xenium` says the same of
   `pillow`), so no single constant can mirror all three. An earlier draft claimed it did.
3. **A bug of ours that a pure-Python library raises for us** — passing a wrong-typed argument
   into `tifffile` — is attributed to the library and CONVERTED. This is a real
   misclassification and the direction this design errs. The concrete instance, measured rather
   than hypothesised, is a plane-SELECTION bug: `pages[index]` with an index this code computed
   wrongly raises `IndexError` from inside `tifffile`, so it reads as the file's fault. That is
   the one class the deleted deny-list DID cover and this mechanism does not, and it is the
   class that produces a wrong-plane image rather than no image. The remedy is attempt 4's:
   COVERAGE. Both such mutants are killed by the positive-path selection tests today — so the
   property holds, carried by the suite rather than by the mechanism, and that is the honest
   statement of it.
4. **`raised_in_own_code` compares against ONE file.** A bug in a *sibling* module of this tree,
   raised inside a guarded body, would be attributed to "a library" and converted. Latent, not
   reachable: every guarded body was walked and none calls across modules today
   (`write_ome_tiff`'s encode block calls only `tifffile` and `os`; `read_plane` calls only its
   own file; `emit_image`'s E1 block calls `ome_physical_size`, which is defined in
   `import_xenium.py` itself). It becomes reachable the moment one of those blocks grows a
   cross-module call, and there is no guard that would notice.

Erring the direction of (3) and (4) is deliberate. The two costs are not symmetric: a
misclassified bug is reported to the operator *by exception type and message* in
`images_not_emitted` and costs one image, while a misclassified data error costs the whole
import — every artifact, over one unusual vendor file. And it is the same direction
`read_image` attempt 4 chose, with the same remedy attached: **coverage**, not a filter. Every
decode and encode branch behind this mechanism is exercised by a test, and the mechanism's own
propagate arm is proved by mutation — nine exception types at each of the two boundaries, plus
a typo'd import name at each, because the propagate arm is the half a widened carve-out would
silently remove.

## 3. The shape of the change

**One named, shared mechanism** in `ome_writer.py` — vendored byte-identically into all three
packages, so both importers inherit it:

```python
def raised_in_own_code(exc, module_file):   # the discriminator
def image_failure_is_a_bug(exc, module_file):  # + the MemoryError carve-out
```

and, at each boundary, five explicit lines that a reader and an `ast` guard can both see:

```python
except Exception as exc:
    if ome_writer.image_failure_is_a_bug(exc, __file__):
        raise
    raise ome_writer.ImageConversionError(f"... ({type(exc).__name__}: {exc})") from exc
```

The boundaries are `write_ome_tiff` (three regions: the deferred imports, the contiguous copy,
the encode), `read_plane`, `tifffile_version`, and — for E1 below — the second file open inside
`import_xenium.emit_image`. **None of them is either importer's `except` tuple**, and those two
lines are unchanged. #292 settled that: converting at the boundary keeps the taxonomy the
importers already guard, in one place, and spreads no third-party exception vocabulary into any
consumer. E1's site is a NEW block rather than a fold into an existing one — there was no
conversion beside it to fold into — so it carries its own site-rule arm and its own message.

The site-local repairs, which the shared mechanism does not reach:

* **E1** the second `tifffile.TiffFile` open in `import_xenium` is folded into the conversion it
  already sits beside;
* **E2** each deferred `import` moves INSIDE the `try` that converts everything else;
* **E3** `_reconcile_scale` validates the types it divides and multiplies by, in its own
  `SpatialDeclarationError` taxonomy, exactly as it already validates `downsample_factor`;
* **E4** the visium handler stops re-reading `spec['basename']` inside its own `except` body.

## 4. Invariants

INV-1 and INV-2 are lifted VERBATIM from the sources named beside them.

- **INV-1** — *"no input can abort the import"* — lifted verbatim from `ome_writer.py`'s
  `read_image` policy comment, which glosses it: *"losing one image must never cost the matrix,
  the coordinates, the columns and the report"*. Proved END TO END through the real importer on
  a multi-artifact bundle, for each closed escape that is REACHABLE through an importer: #296
  (a zeroed dimension tag), #297 (both legs — the allocation and the encode), #298 E1 (a
  truncation between the two opens), #298 E2 (a rootfs without `tifffile`, through the Visium
  path that calls `tifffile_version` before the writer), and #298 E4 (a spec with no basename).
  **#298 E3 is the one exception and it is declared, not omitted**: `_reconcile_scale` is
  unreachable through either importer because both build the placement through `SD.image_meta`,
  which is exactly why its own docstring says it exists for the hand-built caller. Its test is a
  regression pin on that construction, as #298's own acceptance asks for — see §6 residue 4.
- **INV-2** — *"a genuine logic bug on an untested path must still propagate rather than be
  reported as a skipped image"* — lifted verbatim from `docs/design/ome-tiff-dtype-refusal.md`
  INV-4. The refusal stays NAMED: no mechanism here may swallow a bug in this tree's own code,
  and that property is proved by MUTATION, not asserted.

  **Half of the sentence this is lifted from is SUPERSEDED, and saying so is part of lifting it
  honestly.** #292's INV-4 reads *"The refusal is NAMED, never broad. **No `except Exception`
  around image emission**: a genuine logic bug on an untested path must still propagate rather
  than be reported as a skipped image."* This design keeps the SECOND sentence, which is the
  promise, and replaces the first, which was the mechanism #292 had available for it. Four
  `except Exception` handlers are introduced, each conditioned on `image_failure_is_a_bug`, and
  the shipped `ast` guard is STRENGTHENED rather than relaxed to match: it now refuses a bare
  `except:`, refuses any type filter, and admits a broad handler only in the exact shape
  `if image_failure_is_a_bug(...): raise` as its FIRST statement — a rule that PROVES
  propagation, which the flat name-list it replaced could not do at all. Six evasion mutants
  (inverted, negated, dead-conditioned, nested, converting, absent) are each required to go RED.
  A design that claims verbatim inheritance while quietly superseding half the sentence would be
  the reframing INV-2 exists to prevent.
- **INV-3** — The discriminator is the RAISING SITE, never the exception TYPE. No new deny-list
  or allow-list of exception types is introduced at any boundary. **Exactly two** declared
  carve-outs exist, both argued in §2 from a measurement, and both are carve-outs FROM the site
  rule rather than filters standing in for it. They live in one constant, which the
  `except`-clause guards structurally CANNOT see — so that constant carries its own structural
  pin and its own behavioural battery. This is not belt-and-braces: a blind audit put
  `read_image`'s attempt-3 allow-list into that tuple verbatim and the entire suite stayed
  green, which is how attempt 3 would have grown back.
- **INV-4** — The refusal NAMES the original exception type in the message an operator reads, so
  a resource problem is distinguishable from a data one.
- **INV-5** — The three shipped `compute/ome_writer.py` and `compute/spatial_declarations.py`
  copies stay BYTE-IDENTICAL, and every package whose files changed moves its manifest version.
- **INV-6** — Nothing that emitted before stops emitting: every previously-successful image
  still emits exactly the bytes it emitted before.

## 5. What this change is NOT

It is not a widening of either importer's `except` tuple. It is not a bare `except Exception`
that swallows bugs — the propagate arm is the point of the mechanism, and it is mutation-proved.
It does not change which images are ACCEPTED: nothing that emitted before stops emitting, and no
pixel value or dtype is converted.

## 6. The residue — what still reaches past the guards after this change

#292's value was the SWEEP, not the patch: it was filed about ONE escaping family and measuring
it found **64 escaping `(dtype, S)` pairs in three families from three different frames**. So the
enumeration is repeated here, and it is an EXECUTED test (`TEST-14`) rather than prose, because
prose records what a sweep found and a test is what keeps it true.

**The battery**, run against `e0276408` and against this branch, with identical inputs:

| boundary | inputs | escaped on `e0276408` | escaped on this branch |
|---|---|---|---|
| `read_plane` — every byte of the header/IFD region set to `0x00` and `0xFF`, every truncation up to 64 bytes plus five longer ones, an empty file, plain text, PNG magic | **672** | **28** — `ZeroDivisionError` 23, `TypeError` 4, `IndexError` 1 | **0** |
| `write_ome_tiff` — twelve exception types injected at each of its four third-party call sites (`np.ascontiguousarray`, `TiffWriter`, `TiffWriter.write`, `os.replace`), plus thirteen hostile arrays/placements and five codecs | **66** | **44** — eleven distinct types, eleven at each of the four sites; all 44 come from the 48 injected cases, and the 18 hostile-array/codec cases escaped on neither side | **0** |

The 28 decode escapes are exactly the three types #296 names, and each one aborted the whole
import. Every one of the 672 + 66 now leaves in
`(ImageConversionError, SpatialDeclarationError, OSError)`.

**What the sweep does NOT cover, stated rather than left to be discovered:**

1. **A bug of ours that a pure-Python library raises on our behalf** is converted, not
   propagated. This is §2's stated misclassification and it is BY DESIGN; no sweep can find it,
   because the sweep cannot know the intent behind a call. The remedy is coverage, and it is the
   same remedy attempt 4 attached to the same decision.
2. **`BaseException` that is not `Exception`** — `KeyboardInterrupt`, `SystemExit`,
   `GeneratorExit`. Deliberately not caught anywhere here, so Ctrl-C still works. These abort the
   import and should.
3. **A relative `co_filename`.** `raised_in_own_code` compares `os.path.realpath` of the frame's
   filename against the module's own; a module compiled with a relative path and consulted from a
   different working directory would not match itself. The failure direction is CONVERT rather
   than propagate — one image lost, not a whole import — and every loader in this tree
   (`importlib.util.spec_from_file_location`, the sandbox entry) passes an absolute path.
4. **Everything OUTSIDE the per-image guarded body.** The matrix, the coordinate and the column
   paths have their own taxonomies and were never in scope. A failure there still aborts the
   import, which is correct: there is no "rest of the import" to protect.
5. **The encode sweep cannot exercise the PROPAGATE arm.** Every injection is raised from a
   function defined in the test file, so the site rule always answers "not ours" and all 48 legs
   convert. It is evidence for INV-1 and for INV-4's naming, and none at all for INV-2 — which
   is why the propagate arm has its own battery (nine own-code exception types at each of the
   two boundaries, plus a typo'd import name at each) rather than resting on this sweep.
6. **The `spatial-types` package has no importer of its own**, so its vendored copy is proved
   behaviourally and by byte-identity rather than end to end. That is the same limit
   `docs/design/ome-tiff-dtype-refusal.md` §6 records for Visium's dtype coverage, for the same
   reason, and it is why TEST-13's byte-identity assertion carries a FLOOR of three.

## 7. Related

* **#292** — the dtype gap in `write_ome_tiff`; this design inherits its INV-2/INV-4 verbatim
  and follows its "refuse at the boundary, not in the caller's tuple" precedent.
* **#155 FIX_ROUND-8/10** — `_PROPAGATE = (MemoryError, RecursionError)` and its deliberate
  removal; attempt 3 of the four-attempt history, and the precedent every later refusal rests on.
* **#272, #263, #289, #288** — open and untouched.
