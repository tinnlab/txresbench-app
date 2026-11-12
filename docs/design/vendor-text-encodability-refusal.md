# Vendor text encodability refusal — a string this importer cannot write is refused at the parse boundary (#329)

**Status:** design note for #329. Like `image-failure-provenance-refusal.md` (#296/#297/#298) and
`xenium-declaration-residues.md` (#319/#320), this is not a new idea: it is a place
`spatial-import-xenium`'s existing rule was never applied.

The rule, in the module's own words (`compute/import_xenium.py::coordinate_space_id`, and again in
`xenium_image._channel_index`):

> *"Refusing the CLAIM rather than the image"* — and *"a MISSED collision is visible and
> recoverable while a FALSE collision is silent wrong data."*

And the posture `read_cells_csv`, `read_experiment`, `locate_members` and the `/matrix` guards all
already take:

> *"`main()` catches only `XeniumImportError`, so each was a raw traceback and exit 1 instead of a
> named refusal."*

---

## §1 — What is wrong today

`experiment.xenium` is attacker-controlled JSON. `json.loads` **accepts** a `"\ud800"` escape — a
lone surrogate — from a file that is itself **pure ASCII**, and hands back a Python `str` that no
UTF-8 encoder can write. `read_experiment` returns that document unexamined, and every read path
in the module inherits it: `_text`, `vendor_statement`, `vendor_provenance`, `vendor_frame_label`,
`section_sample_id`, `coordinate_space_id`.

Two distinct outcomes, both measured on a staged real prime bundle (`Xenium_Prime_Mouse_Ileum_tiny_outs`),
one lone surrogate per field, against `origin/main` at `a2a6f728`:

### §1.1 The traceback (5 of 19 mutants)

`analysis_sw_version`, `chemistry_version`, `panel_name`, `region_name`, `roi_uuid` reach
`spatial_declarations.mirror_declarations_into_store`, which writes with
`Path.write_text(..., encoding="utf-8")`:

```
*** UNCAUGHT UnicodeEncodeError: 'utf-8' codec can't encode character '\ud800'
    in position 978: surrogates not allowed
  import_xenium.py         run_import
  spatial_declarations.py  write_spatial_coordinates
  spatial_declarations.py  mirror_declarations_into_store -> node.write_text(body, encoding="utf-8")
  pathlib.py               write_text
```

`main()` catches only `XeniumImportError`, so this is a traceback and **exit 1**, not a named
refusal — and it happens **after** `spatial/coordinates.zarr` (plus `expression.zarr`,
`cell_id.zarr`, the column stores) are already on disk, with **no `manifest.json`**. That is the
same shape as the `ENOSPC` defect #301 recorded as a genuine DEC-7 violation: a write sitting
outside every guard, aborting an import at 95% with nothing to say what happened.

### §1.2 The silently poisoned artifact (11 of 19 mutants — and 2 of the 5 crashers too)

Eleven of the other fourteen — `instrument_sw_version`, `panel_organism`, `panel_design_id`,
`panel_type`, `preservation_method`, `run_name`, `slide_id`, `instrument_sn`, `experiment_uuid`,
`analysis_uuid`, and a trailing low surrogate — do not crash. The import reports **SUCCESS**,
because `json.dumps` defaults to `ensure_ascii=True` and writes the surrogate back out as the
ASCII escape `\ud800`, into `xenium-import-report.json` and `xenium-import-summary.html`.
`chemistry_version` and `panel_name` leave such a report behind **as well as** crashing, so
thirteen of nineteen put an unreadable escape on disk.

> **Corrected.** An earlier revision of this section said "the other fourteen", on a measurement
> that had set every field at once. Both blind audit angles re-measured it one field at a time and
> were right; §1.2b is the remainder that measurement was hiding.

The artifact that ships is unreadable. Measured with `serde_json` — the crate the server parses
`/outputs/manifest.json` and this report with — over the emitted `xenium-import-report.json`:

```
serde_json: REFUSED -- unexpected end of hex escape at line 88 column 24
```

This is exactly the failure `_finite`'s docstring already argues about `NaN`: *"ONE such number
anywhere in `experiment.xenium` would fail the whole job at ingest AFTER every byte of compute,
with a message about a malformed manifest and nothing pointing at the vendor file."* The same
sentence is true of a lone surrogate, and nothing guards it.

### §1.2b The three that were harmless — and the cost this design accepts

The remaining three — `segmentation_method`, a nested value under `images`, and a hostile **key** —
neither crash nor poison anything: no file under `/outputs` carries the escape, because nothing
reads those onto an artifact.

**This design refuses them anyway, and that is a real reduction in what imports.** It is stated
here rather than glossed, because it is the honest cost of §2's "once, at the boundary" choice.
It is accepted for one reason: *which* fields are read onto an artifact is a property of TODAY's
module, so a rule scoped to today's readers would silently stop covering a field the day someone
reads one more — which is precisely the `section_sample_id` defect (#320) that this module has
already shipped once. A vendor document carrying a string that cannot be written is malformed as a
whole, and is refused as a whole.

**A guard on the identity path alone would fix none of it.** The same string reaches the artifact
through `vendor_provenance` as well, so an identity-path guard leaves §1.1 and §1.2 exactly where
they are while making the report look defended. Measured one field at a time on the pre-change
body, only THREE fields reach the coordinates store's `zarr.json` at all — `analysis_sw_version`,
`region_name`, `roi_uuid`; `chemistry_version` and `panel_name` crash later, arriving through the
provenance block.

### §1.3 The same defect at a second parse boundary — the h5 root attributes

There are **two** shapes here, not one, and the second is the one the vendor actually writes.

**(a) A UTF-8-typed string attribute.** `h5py` decodes it with `surrogateescape`, so invalid bytes
come back as lone surrogates in the `U+DC80..U+DCFF` range. `run_import` does
`attrs = dict(h5.attrs)` and passes it to `vendor_provenance` as `matrix_attrs`. Measured, root
attribute `library_ids = b"\xff\xfeBAD"` written with `h5py.string_dtype("utf-8")`:

```
  ROOT attr 'library_ids' -> '\udcff\udcfeBAD'
  -> NO REFUSAL — import completed; report carries a lone-surrogate escape
     provenance.matrix_library_id='\udcff\udcfeBAD'
```

**(b) A fixed-length BYTES attribute — what the real bundle uses.** The committed prime fixture
stores `library_ids` as `|S15`:

```
array([b'0000000_0000000'], dtype='|S15')
```

`h5py` returns `bytes`, not `str`, so there is no surrogate to find — and `_text` /
`vendor_provenance` put it through `decode(errors="replace")`. Measured, three different invalid
byte strings in the vendor's own shape:

```
b'\xff\xfeBAD'  ->  import OK; provenance.matrix_library_id = '\ufffd\ufffdBAD'
b'\xfe\xffBAD'  ->  import OK; provenance.matrix_library_id = '\ufffd\ufffdBAD'
b'\x80\x81BAD'  ->  import OK; provenance.matrix_library_id = '\ufffd\ufffdBAD'
```

Three distinct vendor byte strings collapse into ONE emitted identifier, **sanitised**, with no
refusal. That is the false collision §2 refuses to make, and it is invisible to a guard that only
inspects `str`. (This shape was missed by the first revision of this design and of its guard; both
blind audit angles found it independently, and it is the reason bytes are decoded strictly at the
boundary rather than loosely at the consumer.)

Same class, one parse boundary over. #323 already closed the sibling on `/matrix/barcodes`
(decoded strictly, refused by name); the root **attributes** were not covered.

---

## §2 — The decision: REFUSE, and refuse at the parse boundary

**Refuse, do not sanitise.** A replacement character silently substituted into a `roi_uuid` is a
silently altered coordinate-frame identity, and into a `slide_id` a silently altered sample
identity — the exact defect class #320 and #323 exist to remove. Sanitising also cannot be stated
honestly in the artifact: the importer would have to declare a value the vendor did not write,
under a `*_source` key that says the vendor wrote it. This module's habit is to refuse the claim
rather than guess at it, and there is no interpretation of a lone surrogate to guess at — it is
not a character, it is half of one.

**Once, at the boundary.** The check belongs where the vendor document is parsed, not at any
consumer of it: there are eight read paths and three write sites downstream, and a per-field guard
is the "same rule applied to one field fewer" defect this module has already shipped twice
(#320's `section_sample_id`, #319's channel list).

---

## §3 — Invariants

- **INV-1**: A bundle this importer cannot carry is REFUSED BY NAME — `XeniumImportError` — never a
  traceback and never an exit-1.
- **INV-2**: The refusal fires BEFORE any artifact byte is written, so a refused import leaves no
  store, no partial store and nothing for a later reader to find.
- **INV-3**: ONE predicate, applied at the boundaries where a vendor document is parsed, to EVERY
  string it carries — every key and every value, `str` and `bytes`, at every depth — not per field
  and not on the identity path alone.
- **INV-4**: A lone surrogate is REFUSED, never sanitised: a silently replaced character in a
  vendor identifier is a silently altered identity.
- **INV-5**: The refusal must itself be safe to emit — ASCII, bounded, and free of control
  characters, in every part of the message including the path to the offending field, so a vendor
  cannot choose what a reader's terminal, log or error column receives.

    > **WIDENED BY #343.** As SHIPPED at #329 this invariant was scoped to the refusal THIS
    > design adds — the module's own scope sentence, "every value THE #329 REFUSAL interpolates
    > goes through here", was REPLACED by the widened one below, and this note is now the record
    > of what #329 shipped. It is no longer the state of the module: #343 routed EVERY value
    > EVERY `XeniumImportError` in `compute/import_xenium.py` interpolates through the same two
    > funnels, and pinned it with a STRUCTURAL guard, `spatial-import-xenium/tests/xenium_refusal_sites.py`,
    > which derives the refusal sites from the module's own AST rather than from a list — 35
    > unprovable interpolations across 28 sites on `1e94c77d2`, 0 across 28 after. It matters
    > because `scheduler.rs::drain_logs` writes one `job_logs` row per stderr line with no
    > per-line cap and the UI is ANSI-unsafe, so a vendor `\n` could forge a log row and a vendor
    > `\x1b` could drive the operator's terminal. The guard is a ROUTING guard — it proves every
    > interpolated value reaches a funnel; it cannot prove the funnel still escapes anything,
    > which is what the behavioural byte-level tests in `tests/test_refusal_escaping.py` hold.

## §4 — What a consumer sees after the refusal

`run_import` refuses inside `read_experiment`, which is the FIRST thing it calls after
`locate_members`. `main()` catches `XeniumImportError`, prints
`spatial.import-xenium: <the refusal>` to stderr and exits **2**. `/outputs` holds only the empty
directory `io_dirs()` created: no `spatial/`, no `*.zarr`, no `xenium-import-report.json`, no
`manifest.json`. Because there is no manifest, the platform records the run as failed with the
importer's own words, rather than ingesting a partial output set.

### §4.1 A write that fails because of the LOCALE, not the bundle

Found at FIX_ROUND-2 while building the test for the explicit parse encoding. This module wrote its
`manifest.json`, its report and its summary with `write_text(...)` and NO `encoding=`, i.e. the
LOCALE default. MEASURED under `LC_ALL=C`, on an ORDINARY bundle:

```
UnicodeEncodeError: 'ascii' codec can't encode character '\u2014' in position 232
  import_xenium.py  run_import
  pathlib.py        write_text        <- xenium-import-summary.html
store on disk: True | outputs entries: 184
```

`\u2014` is an em dash in **this module's own prose** — not vendor text, not hostile input. So on a
machine with a non-UTF-8 locale, EVERY import died with an uncaught `UnicodeEncodeError` and exit 1
after 184 paths were on disk. That is §1.1's sentence exactly, reached by the environment instead of
by an attacker, and the declaration mirror's own comment had already predicted it: *"with
`ensure_ascii=False` a non-ASCII library id would abort the writer under an ASCII locale"*.

**ONE of the three writes is load-bearing, not three.** An earlier revision of this section said
"three `encoding="utf-8"` keywords close it"; a blind angle falsified that. `manifest.json` and
`xenium-import-report.json` are serialised by `json.dumps` at its default `ensure_ascii=True`, so
they are pure ASCII by construction (measured: 0 non-ASCII bytes in each) and could not have raised
under any locale — removing both keywords leaves the whole package suite green. Only
`xenium-import-summary.html`, which carries free prose, actually fails. It is the one TEST-14 kills
(verified red); the other two keywords are the cheap half of a rule that should hold for every text
write here, and are labelled as such rather than as a fix.

The general form, worth stating once: **a producer's text write is part of its refusal contract.**
A write whose encoding comes from the environment can abort a job for a reason the job's own inputs
cannot explain.

### §4.2 The honest limits of INV-2

**INV-2 is a statement about the two guards this design adds, not about the module.** The blind
angles measured two neighbouring families that still leave output behind. Neither is changed here,
and neither is claimed to be.

**(a) Refusals that fire after the first writer.** EVERY `cells.csv.gz` refusal leaves 14 paths of
`expression.zarr` behind — a NUL byte, invalid UTF-8, an oversized field, a header-only file, a
short row, all `exit=2, outputs_paths=14`. (An earlier revision named only the invalid-UTF-8 case;
the error-handling angle measured the rest.) Those refusals are correct and named; they simply
happen later in `run_import` than the first write. This argues for the general form of the rule:
**every refusal a bundle can trigger should be reachable before the first writer call**, which
today is true of the two boundaries this design guards and of no others.

**(b) A filesystem error at any write is still an uncaught traceback.** Measured at five sites
(`manifest.json`, the report, the summary, `_lib/txr_deps.py`'s `run-environment.json`, and
`io_dirs()`'s mkdir): `exit=1`, a traceback, and 183–186 paths on disk. `write_manifest` is called
AFTER `main()`'s `try/except` closes, so that site is not catchable even in principle without moving
the call. That is #301's `ENOSPC` shape, still open, **filed as #332** with the measurements rather
than fixed here: the fix is a control-flow change to a runtime block that is deliberately
byte-identical across every builtin's compute, which is not a one-package change.

## §5 — Explicitly out of scope

`spatial-import-visium` has the same holes — **both** of them — and is NOT touched here: `compute/spatial_declarations.py`
is vendored byte-identically across three packages, and the unmerged `feat/cytassist-calibration`
owns visium. **Filed as #330**, with the measurement: an invalid-UTF-8 h5 ROOT attribute
(`software_version`) makes that importer die with an uncaught `UnicodeEncodeError` and exit 1 with
`spatial/coordinates.zarr` already on disk, poisoning `provenance.pipeline` AND
`provenance.sample_id`. Its `read_scalefactors` (`compute/import_visium.py:452`) parses vendor JSON
with the identical `json.loads(Path(path).read_text())` this design guards.

It also carries §4.1's write-side half, which needs no hostile input at all. Measured on the
committed visium fixture, ordinary bundle, under `LC_ALL=C`:

```
UnicodeEncodeError: 'ascii' codec can't encode character '\u2014' in position 517
  import_visium.py:1563  run_import  ->  visium-import-summary.html
paths on disk: 117
```

So every Visium import dies on a non-UTF-8 locale exactly as every Xenium import did. Its three
write sites are `import_visium.py:293`, `:1551` and `:1563`. Recorded on #330.

Also out of scope and reported to the owner rather than changed: `import_xenium.py`'s
`unverified_space_id` encodes cell ids with `errors="replace"` and cites this very
`UnicodeEncodeError` as its justification — a sanitisation sitting ON the identity path. The blind
angle that raised it could NOT reach it (h5py returns `bytes` for string datasets and #323's
`_decoded_strings` decodes those strictly, so that guard fires first), so it is recorded as an
unreproduced hypothesis rather than acted on under one.

---

# §6 — The same rule at `spatial-import-visium`'s own boundaries (#330)

§5 above scoped visium OUT of #329 and filed it as #330 with a measurement. This section is
that item's design. It is deliberately not a new idea: it is §2's decision and §3's invariants,
applied at the boundaries this package parses, with the measurements re-taken on THIS package
rather than inherited from the Xenium side.

Everything below was measured on the committed real fixture bundle
(`spatial-import-visium/tests/fixtures/visium-outs`, `Visium_Mouse_Olfactory_Bulb`,
Space Ranger 2.0.0), on `origin/main` at `d263fac0`, one mutation at a time.

## §6.1 — THERE ARE TWO DOORS, and closing one is not closing the defect

> **Two PARSE boundaries.** §6.7 adds a THIRD place in the same file where vendor text is read —
> the h5 identity DATASETS — found after this section was written. It is not a fourth "door" in
> this section's sense: it is not a parsed document and it does not go through the encodability
> predicate; it is a strict decode of a join key, refused by its own named error. INV-3's "BOTH
> boundaries" means the two boundaries where a vendor DOCUMENT is parsed, and it is left as
> written rather than widened, because widening it would blur two different rules together.


### Door (a) — the h5 ROOT attributes

`run_import` does `attrs = dict(h5.attrs)` on `filtered_feature_bc_matrix.h5` and hands the
dict to `vendor_provenance` as `matrix_attrs`. The three attributes that function reads are
`software_version`, `chemistry_description` and `library_ids`. What h5py hands back for them on
the REAL fixture:

```
'chemistry_description'  -> str      'Visium V1 Slide'
'library_ids'            -> ndarray  array([b'Visium_Mouse_Olfactory_Bulb'], dtype='|S27')
'software_version'       -> str      'spaceranger-2.0.0'
```

Note the shapes: two `str`, one `ndarray` OF FIXED-LENGTH BYTES. That split is the whole reason
a `str`-only guard is not a guard here — it is the same finding both blind angles made on #329,
and it is true of this package's real fixture too.

Each attribute was then rewritten in each of the two dtypes the vendor can use, holding
`b"\xff\xfeSR"` — bytes that are not valid UTF-8. **Two outcomes, and the crash is the smaller
of the two:**

```
software_version       utf8-str-dtype       h5py-> str   '\udcff\udcfeSR'
    UNCAUGHT UnicodeEncodeError: 'utf-8' codec can't encode characters in position
    1171568-1171569: surrogates not allowed
    outputs_paths=117   spatial/coordinates.zarr on disk: True
chemistry_description  utf8-str-dtype       -> same, position 1171634-1171635, 117 paths
library_ids            utf8-str-dtype       -> same, position 981-982, 59 paths

software_version       fixed-length-bytes   h5py-> np.bytes_(b'\xff\xfeSR')
    COMPLETED, exit 0.  provenance.pipeline   = '��SR'
chemistry_description  fixed-length-bytes   COMPLETED.  provenance.chemistry = '��SR'
library_ids            fixed-length-bytes   COMPLETED.  provenance.library_id = '��SR'
                                            AND coordinate_space = 'visium:��SR'
```

* The `utf-8` string dtype is the CRASH #330 reports: `h5py` decodes it with `surrogateescape`,
  the lone surrogates reach a writer, and `main()` — which catches only `VisiumImportError` —
  emits a traceback and exit 1 with 59-117 paths already under `/outputs` and no `manifest.json`.
  `library_ids` dies EARLIEST (59 paths, inside the declaration mirror that
  `SD.write_spatial_coordinates` runs); the other two get past it and die at the
  `visium-import-summary.html` write instead (117 paths).
* The FIXED-LENGTH BYTES dtype — **the shape the real fixture actually uses** — does not crash
  at all. `vendor_provenance`'s own `text()` helper does `v.decode(errors="replace")`, so the
  import reports SUCCESS and ships a SANITISED identifier. See §6.2.

### Door (b) — `scalefactors_json.json`

`read_scalefactors` parses the vendor's scale file with the identical
`json.loads(Path(path).read_text())` #329 guards on the Xenium side, and `json.loads` **accepts
a `"\ud800"` escape out of a file that is itself pure ASCII**. Measured, adding
`"vendor_note": "\ud800BAD"` to the fixture's own scale file and writing it back as ASCII:

```
file bytes pure ASCII: True    contains the literal escape \ud800: True
json.loads -> '\ud800BAD'      .encode('utf-8') -> UnicodeEncodeError at 0
IMPORT COMPLETED, exit 0, 117 output paths
visium-import-report.json line 22:  "vendor_note": "\ud800BAD"
visium-import-summary.html carries the escape too
```

> **The counting convention, stated because a blind angle re-measured these and got a different
> number.** Every path count in this section comes from `run_import` alone, which is how the
> measurement harness drives it. Through the ENTRYPOINT a completed run is **119**: `main()`
> adds `manifest.json` and the run-environment record after `run_import` returns. So 117 is a
> complete `run_import`, 119 a complete job, and 51/59 are partial stores. The auditor's 119 and
> this section's 117 are the same measurement counted at two different points.

The whole parsed scale document is echoed into the report under `"scalefactors"`, so this door
does not crash — it POISONS, exactly as thirteen of #329's nineteen Xenium mutants did. The
emitted `visium-import-report.json` then carries a lone-surrogate escape, which is the artifact
`serde_json` — the crate the server parses `/outputs/manifest.json` and this report with —
refuses with "unexpected end of hex escape" (§1.2's measurement, on the same emitted shape).

A hostile KEY and a hostile value on a REAL scale key (`spot_diameter_fullres`) were measured
too: both COMPLETE, 117 paths (119 through the entrypoint).

**A fix at one door is not a fix.** Door (a) is the reported crash and door (b) is the silent
one; they hand the SAME unwritable `str` to the same downstream writers, and the module has
already shipped the "same rule applied to one field fewer" defect three times (#319, #320, #323).

## §6.2 — The decision: REFUSE. Measured, not asserted

§2 already settled this for #329. It is RE-MEASURED here rather than cited, because the
sanitising alternative is not hypothetical on this package — it is what `vendor_provenance`'s
`text()` helper DOES TODAY, and door (a)'s bytes arm reaches it.

Three DIFFERENT invalid vendor byte strings in `library_ids`, one import each:

```
b'\xff\xfeSR'  -> COMPLETED  provenance.library_id = '��SR'
b'\xfe\xffSR'  -> COMPLETED  provenance.library_id = '��SR'
b'\x80\x81SR'  -> COMPLETED  provenance.library_id = '��SR'

DISTINCT emitted library_ids: 1, from 3 distinct vendor byte strings.
```

And `coordinate_space_id` derives the frame id from that value, so all three also emitted the
SAME coordinate space:

```
report.coordinate_space = 'visium:��SR'
```

That is the FALSE COLLISION of #320's class, on the coordinate-frame identity, produced by
sanitisation: three slides that are not the same slide become one frame, and
`resolveOverlayBinding` compares frame ids by EQUALITY, so they would bind to each other
silently. A missed collision is visible and recoverable; a false one is silent wrong data. So
the value is REFUSED, never repaired.

## §6.3 — Where the guard goes, and why BOTH call sites move BEFORE the first write

The predicate is the one #329 shipped (`unencodable_vendor_text` /
`refuse_unencodable_vendor_text`), PORTED rather than reinvented: same walk, same two arms,
same bounded-ASCII message renderer, raising `VisiumImportError`. A second spelling of one rule
is a rule that answers differently in two places.

Its two call sites here are `dict(h5.attrs)` in `run_import` and the parse inside
`read_scalefactors`. **The second one is not where it is called from today.** Measured on the
pre-change body, `read_scalefactors` is invoked at `import_visium.py:1869`, while the FIRST
artifact write — `txr_csc.write_csc_zarr(... "expression.zarr")` — is at `:1733`. A refusal
raised where that call sits today fires with the expression store, both axis stores and the
metadata columns already on disk. **MEASURED by actually un-hoisting the read on a copy of the
fixed body and re-running door (b): 51 paths, `expression.zarr` present,
`spatial/coordinates.zarr` absent, no report.** An earlier revision of this sentence said
"130-odd paths", which a blind angle correctly called impossible on its face — a COMPLETE
`run_import` is only 117. The conclusion survives the correction; the number did not. So the
scale file is
READ EARLY, immediately after `locate_members`, and the already-read document is passed to the
site that consumes it. The read is pure and its result is not used before `:1869`, so nothing
else about the import moves.

`read_scalefactors` keeps its degrade-to-`{}` contract for an UNPARSEABLE file (an ABSENT one
never reaches it — `locate_members` refuses the bundle first, measured identically on
`origin/main`; an earlier revision of this sentence said "ABSENT or UNPARSEABLE" and a blind angle
found the correction had landed in the changelog and the docstring but not here): a
bundle with a damaged scale file still imports and simply declares no scale. That is a different
fact from a file that parses cleanly and carries a string this importer cannot write — the
latter is a malformed vendor document and is refused as a whole, per §2.

## §6.4 — THE TEST IS THE ENCODE, and #329's stated reason for that is FALSE

The predicate asks `value.encode("utf-8")` (and, for the bytes arm,
`bytes(value).decode("utf-8")`) — the operations the writers actually perform — so it cannot
drift from the failure it prevents.

`unencodable_vendor_text`'s docstring on the Xenium side justifies this by saying a
`U+D800..U+DFFF` codepoint-range check "would also REFUSE a legitimate astral character".
**That is false in CPython, and it is not carried forward here.** Measured:

```
json.loads('"🧬"')                        -> '🧬'  len=1  ord=0x1f9ec
any(0xD800 <= ord(c) <= 0xDFFF for c in that str)   -> False
that str.encode('utf-8')                            -> b'\xf0\x9f\xa7\xac'
```

`json.loads` assembles the surrogate PAIR into ONE codepoint before any guard sees it, so a
range scan over the resulting Python `str` accepts every astral character. Right conclusion,
wrong reason — and a true rule kept alive by a false reason is a rule the next reader deletes
after checking the reason.

The reasons that are true:

1. **A range scan cannot see the BYTES arm at all.** `b"\xff\xfeSR"` has no codepoints to scan,
   and on this package's real fixture the poisoned attribute (`library_ids`, `|S27`) arrives as
   bytes. The encodability question is the only one that has an answer for both shapes.
2. It is a **second, hand-maintained spelling** of what the writer does — the syntactic-guard
   class with an unbounded evasion space.

The astral character is still a mandatory POSITIVE CONTROL (TEST-6 below), because without it
the guard could be "refuse anything that is not ASCII" and every negative test would still pass.

## §6.5 — Invariants (#330)

- **INV-1**: A bundle this importer cannot carry is REFUSED BY NAME — `VisiumImportError` — never
  a traceback and never an exit-1.

  > **Scoped like INV-2, and for the same reason.** This is a statement about the failures THIS
  > DESIGN reaches, not about every state the module has. §6.8 records three that remain: a scale
  > document nested at exactly depth 991 (the parse and the walk both succeed and the REPORT
  > WRITER then dies), a bundle DIRECTORY NAME carrying invalid UTF-8, and a filesystem error at
  > `write_manifest`, which runs after `main()`'s `try/except` closes. Each is measured, each is
  > filed, and none is claimed closed here.
- **INV-2**: The refusal fires BEFORE any artifact byte is written, so a refused import leaves no
  store, no partial store and nothing for a later reader to find.

  > **Scoped exactly as §4.2 scopes it on the Xenium side, and a blind angle was right to ask.**
  > INV-2 is a statement about THE REFUSALS THIS DESIGN ADDS, not about the module. Other,
  > correctly-named refusals still fire after the first writer: MEASURED, every
  > `tissue_positions.csv` refusal leaves **51 paths** (`expression.zarr` and the axis stores),
  > because `read_positions` is called after `write_csc_zarr`. Those refusals are named and
  > correct; they simply happen later in `run_import`. The general form of the rule —
  > **every refusal a bundle can trigger should be reachable before the first writer call** —
  > is true today of the boundaries this design guards and of no others, and is recorded in
  > §6.7 rather than claimed here.
- **INV-3**: ONE predicate, applied at BOTH boundaries where a vendor document is parsed — the h5
  root attributes AND `scalefactors_json.json` — to EVERY string each carries: every key and
  every value, `str` and `bytes`, at every depth; not per field and not at one door only.
- **INV-4**: An unwritable vendor string is REFUSED, never sanitised: a silently replaced
  character in `library_ids` is a silently altered sample identity AND a false coordinate-frame
  collision.
- **INV-5**: The refusal must itself be safe to emit — ASCII, bounded, and free of control
  characters, in every part of the message including the path to the offending field.

  > **Scoped to the refusals THIS DESIGN adds**, exactly as #329 scopes the same invariant
  > ("every value THE #329 REFUSAL interpolates goes through here"). §6.8 item 1 records that the
  > module's OTHER refusals interpolate vendor text raw and unbounded, with measurements.
  >
  > **WIDENED BY #336, for `spatial-import-visium` only.** The scope sentence above is what this
  > design shipped and is left standing as the record of that. It is no longer the state of the
  > module: #336 routed EVERY value EVERY `VisiumImportError` in `compute/import_visium.py`
  > interpolates through the same funnel, and pinned it with a STRUCTURAL guard
  > (`tests/visium_refusal_sites.py`) that derives the refusal sites from the module's own AST rather
  > than from a list — 26 unprovable interpolations across 19 sites on `c34b3a1f`, 0 across 20 after. See §6.8 item 1.
  > The Xenium side was NOT widened when this was written, and that sentence is left standing as
  > the record of it; #343 has since widened Xenium identically — see §3's INV-5 note.
  > "Bounded" here also covers WORK, not only message length: see `_MAX_WALKED_ATTRIBUTE_BYTES`
  > and §6.9. Past that bound the failure is not a long line on stderr, it is an OOM SIGKILL with
  > no message at all.
- **INV-6**: Legitimate non-ASCII vendor text — including an ASTRAL character — still IMPORTS and
  round-trips to the artifacts. The guard tests the ENCODE, so it can never become "refuse
  anything that is not ASCII".

  > **This is a property of the READS as well as of the guard**, which the first revision of this
  > design missed and a blind angle measured: with the vendor documents read at the LOCALE
  > default, the SAME ordinary bundle produced a different `microns_per_pixel` and a different
  > `section.sample_id` under `LC_ALL=C` than under a UTF-8 locale, and a positions table with
  > legitimate UTF-8 in it died with a traceback and 51 paths on disk. See §6.6.

### The cost of walking the WHOLE attribute dict, disclosed

`vendor_provenance` reads exactly three root attributes, but the guard walks all of
`dict(h5.attrs)`. So **a bundle whose h5 carries an unreadable-by-us root attribute — a checksum,
an opaque vendor blob, perfectly legal HDF5 — is now REFUSED even though that value could never
have reached an artifact.** MEASURED: `vendor_blob = np.array([b"\x89PNG\xff\xfe"], dtype="|S10")`
on the committed fixture -> `exit 2, 0 paths`.

That is a real reduction in what imports, and it is the same trade §1.2b states for the Xenium
side: WHICH attributes are read onto an artifact is a property of THIS revision of the module, so
a rule scoped to today's readers silently stops covering an attribute the day someone reads one
more — the `section_sample_id` defect (#320) this importer has already shipped once. It is
accepted, disclosed in the manifest changelog, and PINNED by a test (TEST-13), because a blind
angle measured that narrowing the guard to the three read attributes left the entire package
suite green.

What is NOT walked is stated as a DENY-list — bool, signed and unsigned int, float, complex,
`datetime64`, `timedelta64` — rather than as an allow-list of what is, so an unknown or future
dtype kind is walked. FIX_ROUND-1 got this backwards and it cost a re-opened door; see §6.9. A
text-dtype array past a declared size cap is refused by name rather than walked, because
`.tolist()` on a large one is a denial of service (§6.9).

## §6.6 — The LOCALE half, which needs no hostile input at all

§5 records that visium carries §4.1's write-side half too, and it is closed here rather than
left, for the reason §4.1 gives: **a producer's text write is part of its refusal contract.**
RE-MEASURED on this branch's base, on the ORDINARY committed fixture, in a subprocess whose
preferred encoding is `ANSI_X3.4-1968`:

```
RAISED UnicodeEncodeError: 'ascii' codec can't encode character '\u2014' in position 517
   import_visium.py:2211  run_import   ->  visium-import-summary.html
   pathlib.py:1155        write_text
paths on disk: 117
```

`\u2014` is an em dash in this module's OWN prose. So on a machine with a non-UTF-8 locale
EVERY Visium import died with an uncaught `UnicodeEncodeError` and exit 1 with 117 paths on
disk — INV-1 and INV-2 both false, reached by the ENVIRONMENT instead of by an attacker, on a
bundle with nothing wrong with it.

The three text writes are `import_visium.py:525` (`manifest.json`), `:2192`
(`visium-import-report.json`) and `:2211` (`visium-import-summary.html`). **ONE of the three is
load-bearing**, the same way #329 measured it: the first two are serialised by `json.dumps` at
its default `ensure_ascii=True` and are pure ASCII by construction, so they could not raise
under any locale. The summary carries free prose and is the one that fails. All three get an
explicit `encoding="utf-8"` — the other two as the cheap half of a rule that should hold for
every text write here, labelled as such rather than as a fix. (Both are unpinned by any test,
and that is disclosed rather than papered over: removing either keyword leaves the whole
package suite green, because both files really are ASCII by construction.)

### §6.6.1 — THE WRITES WERE HALF THE RULE. The READS are the other half

The first revision of this section stopped at the writes. All three blind angles measured
independently that this leaves the same defect on the way IN, and one of the three shapes is
worse than the crash because it is SILENT. Every measurement below is on an ORDINARY bundle
carrying LEGITIMATE UTF-8 — no hostile input anywhere:

```
scalefactors_json.json   "vendor_note": "spot pitch 100 um"  (with a real µ)
   UTF-8 locale : exit 0, scalefactors round-trip, microns_per_pixel = 0.8829802566973034
   ASCII locale : exit 0, scalefactors = {},       microns_per_pixel = null
                  scale_note: "declares neither `microns_per_pixel` nor
                               `spot_diameter_fullres`"        <- A FALSE STATEMENT

metrics_summary.csv      "Sample ID": "Bulb-um-01"  (with a real µ)
   UTF-8 locale : coordinates.zarr/zarr.json  section.sample_id = "Bulb-µm-01"
   ASCII locale : coordinates.zarr/zarr.json  section.sample_id = <the library id fallback>

tissue_positions.csv     a legitimate UTF-8 column
   UTF-8 locale : exit 0, 119 paths
   ASCII locale : exit 1, TRACEBACK, 51 paths  (UnicodeDecodeError: 'ascii' codec, byte 0xc2)
```

The scale case is the worst of the three and it is the one at the door this design guards:
`UnicodeDecodeError` subclasses `ValueError`, so it was swallowed by `read_scalefactors`'
degrade-to-`{}` arm and the importer then **stated something untrue about the vendor's
document** — the "declare a value the vendor did not write" outcome §2 exists to prevent,
arriving from the environment rather than from an attacker. The metrics case is §6.2's
false-identity class by the same route: the SAME bundle stamps TWO DIFFERENT identities into the
coordinate store depending on `LC_ALL`.

So all three vendor-document reads name `encoding="utf-8"`: `read_positions`
(`open(..., newline="", encoding="utf-8")`, with a NAMED refusal for a positions table that is
not valid UTF-8 — its first column is the barcode, a join key), `read_scalefactors`
(`read_text(encoding="utf-8")`) and `vendor_provenance`'s metrics read. `read_json` in the
shared compute runtime block is deliberately NOT touched: it reads `inputs.json`/`params.json`,
which are the platform's own documents, not the vendor's, and that block is byte-identical
across the builtins.

`read_scalefactors`' narrowing also gains `RecursionError`. `json.loads` raises it at nesting
depth >= 992 on a file that is otherwise pure ASCII, and `RecursionError` subclasses
`RuntimeError`, not `ValueError` — so a deeply nested vendor scale file walked past the
degrade-to-`{}` arm and out through `main()` as a raw traceback. A document too deep for the
parser is UNPARSEABLE, which is exactly the case that arm exists for.

## §6.7 — The THIRD door in the same file, closed in FIX_ROUND-1

All three blind angles found this independently, and it sits TWENTY-FOUR LINES below the
root-attribute guard, inside the same `with h5py.File(...)` block, on the same file the guard
had just walked. `run_import` read `/matrix/barcodes`, `/matrix/features/id` and
`/matrix/features/name` as `[b.decode() if isinstance(b, bytes) else str(b) for b in ...]`.
MEASURED with `matrix/features/name[0] = b"\xff\xfeEVIL"` (and again on the other two):

```
rc=1  paths=0  UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 0
  import_visium.py  run_import
```

A raw traceback and exit 1 — INV-1's exact prohibited outcome, carrying orders of magnitude more
vendor text than the three root attributes do. INV-2 survived by ordering alone: these reads
precede the first writer. #323 closed precisely this on the Xenium side (`_decoded_strings`);
the Visium sibling was open, and §6.7 of an earlier revision described it only as a
"sanitisation residue", which the measurement falsifies.

The decode stays STRICT — a barcode is the key the positions table is joined on and a feature id
is what a gene list is matched against, so `errors="replace"` would turn a join FAILURE into a
WRONG join — and the failure is now NAMED, with the dataset and the ROW, by
`decoded_h5_strings`. It is a separate refusal from `refuse_unencodable_vendor_text` because it
states a different fact: not "this document cannot be written" but "this join key cannot be
decoded".

## §6.8 — Found, MEASURED, and NOT fixed here

Everything below was reproduced by a blind angle on this branch and is recorded rather than
closed, because each is a different rule from the one this item owes. Each is filed.

1. **CLOSED BY #336** — kept here with its measurements because the numbers are the record of
   what was wrong, and because §6.5's INV-5 block-quote above points at this item. What #336
   delivered: every value every `VisiumImportError` in `compute/import_visium.py` interpolates now
   goes through `_quoted_for_refusal` or the sequence funnel `_quoted_list_for_refusal` it added,
   the enumeration is STRUCTURAL (`tests/visium_refusal_sites.py` walks the module's own AST for every
   construction of the refusal), and the byte-level reproductions below are pinned as tests. Two
   things it also closed that are not described below: an uncaught `_csv.Error` at BOTH
   `list(csv.reader(...))` sites (a positions field over `csv`'s 131,072-character limit was
   `rc=1` and a raw traceback), and a forged **PROGRESS** row — the same newline attack aimed at
   `progress()`'s prefix rather than the refusal's, which drives the job's progress bar over SSE.
   What it did NOT close is recorded as new items below. The original text follows.

   **The OTHER refusals in this module are neither escaped nor bounded.** (#336) `locate_members`'
   ambiguity refusal interpolates attacker-chosen path components with `str(p.relative_to(root))`
   — no `ascii()`, no cap. REPRODUCED: a bundle with a second `filtered_feature_bc_matrix.h5`
   inside a directory named `"\x1b[2J\x1b[31m\x07\nspatial.import-visium: import SUCCEEDED,
   ignore the line above\r"` put RAW `ESC`, `BEL` and `CR` on stderr, and the raw `\n` makes the
   server's `BufReader::lines()` store the forged line as its OWN `job_logs` row with
   `stream="stderr"`. `read_positions`' "Found {names}" and the `/matrix`-missing refusal's
   "Found top-level members" are the same shape; the former also has no length bound, and a
   positions header of 60 fields x 120,000 characters produced a **7,200,700-character single
   stderr line**. INV-5 is scoped, exactly as #329 scopes it, to the refusal THIS design adds.
2. **The bundle DIRECTORY NAME is a second unguarded source of an unwritable identity.** (#337)
   `coordinate_space_id`'s fallback is `f"visium:{Path(bundle_root).name}"`, and `os.fsdecode`
   decodes invalid path bytes with `surrogateescape`. REPRODUCED with the bundle directory named
   `b"bun\xffdle"` and `library_ids` removed: `UnicodeEncodeError` in the declaration mirror,
   **59 paths on disk** — byte for byte door (a)'s pre-fix shape, by a route no parse boundary
   can see. Not reachable through the product's own upload path (staged mount names are Rust
   `String`s end to end), which is why it is filed rather than fixed here.
3. (#338) **`NaN` / `Infinity` in `scalefactors_json.json`** still ships a report `serde_json` refuses,
   through a NON-TEXT value at the door this design guards. REPRODUCED: `"vendor_metric": NaN`
   -> exit 0, 117 paths, `"vendor_metric": NaN` in `visium-import-report.json`. The
   encodability predicate is about text and does not see it; `allow_nan=False` on the dumps, or
   a numeric leg in the walk, closes it.
4. (#338) **A scale document nested to depth exactly 991** passes the walk and then kills
   `render_report_html`'s own `json.dumps` with `RecursionError` — **116 paths** under this
   section's `run_import`-alone counting convention, **115** through the entrypoint (a blind angle
   measured the second and both are right; see §6.1's note). Depths 990 and 992 both complete.
   Passing the encodability predicate is not evidence a document is writable.
5. (#338) **`</script>` breakout into `visium-import-summary.html`.** `embedded = json.dumps(report)` is
   interpolated into a `<script type='application/json'>` block with no `</` escaping, and the
   report echoes the whole parsed scale document. REPRODUCED with
   `"vendor_note": "</script><img src=x onerror=alert(1)><script>"`.
6. **`vendor_provenance`'s `text()` still spells `errors="replace"`.** The boundary guard makes
   it unreachable for anything arriving through a guarded boundary; it remains as a sanitisation
   spelled on an identity path, the same residue #329 recorded for `unverified_space_id`.
7. **`write_manifest` runs after `main()`'s `try/except` closes**, so a filesystem error there is
   still an uncaught traceback with outputs on disk. #301's `ENOSPC` shape, filed as #332 against
   a runtime block that is deliberately byte-identical across every builtin.
8. **`metrics_summary.csv` whose BYTES are not UTF-8** still degrades rather than refusing, so the
   sample id falls from the vendor's `Sample ID` to the library-id rung and the coordinate store
   carries no marker of it. MEASURED: the same `Sample ID` written as UTF-8 vs latin-1 gives
   `section.sample_id = 'Bulb-µm-01'` vs `'Visium_Mouse_Olfactory_Bulb'`, both exit 0.
   FIX_ROUND-1's `encoding="utf-8"` closed the LOCALE route to this and not the BYTES route. It
   is left because `metrics_summary.csv` is an OPTIONAL member with a documented degrade contract
   (`metrics_summary_unreadable: true` is recorded in the report) and the fallback is a documented
   LADDER rather than a fabricated value — but the coordinate store not carrying the marker is the
   part worth revisiting.
9. (#341) **`read_json` in the shared compute runtime block reads at the LOCALE default**, and
   `inputs.json` is not purely the platform's own document: its `sandbox_path` carries
   `declared_mount_name()`, a user string that `validate_subpath` screens only for control
   characters, and the server serialises it with `serde_json::to_vec_pretty`, which does not
   escape non-ASCII. MEASURED, a complete ordinary bundle with one non-ASCII byte in
   `inputs.json` (e.g. a bundle directory named `bündle-µm`), under `LC_ALL=C`: **rc=2, 0 paths,
   "the bundle has no filtered feature-barcode matrix"** — a FALSE statement about a complete
   bundle, produced by the machine's locale, through the identical swallow-into-a-false-statement
   route FIX_ROUND-1 closed in `read_scalefactors`. NOT fixed here because that block is
   deliberately byte-identical across every builtin's compute; changing it is a cross-package
   change, the same argument #332 makes.

## §6.9 — FIX_ROUND-2: what FIX_ROUND-1's own fixes broke

Round 1 fixed a denial of service and re-opened door (a) doing it. Both facts are recorded,
because "the fix round introduced a defect" is the thing a fix round is least likely to say about
itself and the blind angles are why it is said here.

**(1) The DoS bound was an ALLOW-list, and it was wrong.** `dtype.kind not in "SUO"` also skips
`V`, and `V` is not only the HDF5 OPAQUE dtype — it is the STRUCTURED/COMPOUND dtype, whose fields
can be `S` or `U`. The comment beside it asserted the opposite as fact ("`V` … is raw binary that
no reader of this module turns into text"); `vendor_provenance`'s `text()`, 700 lines below, does
exactly that. MEASURED end to end on the committed fixture:

```
library_ids = np.array([(b"\xff\xfeSR",)], dtype=[("v", "S8")])    # h5py -> dtype.kind 'V'
  rc=0  paths=119  provenance.library_id = '\ufffd\ufffdSR'
                   coordinate_space      = 'visium:\ufffd\ufffdSR'
b'\xff\xfeSR' / b'\xfe\xffSR' / b'\x80\x81SR'  ->  DISTINCT coordinate spaces: 1
```

§6.2's false collision, verbatim, on the coordinate-frame identity, re-introduced by a bound meant
to be free — and pinned by nothing, because TEST-17 pinned the fix and not the hole. The repair is
to state the skip as what CANNOT carry text (`biufcMm`) so an unknown dtype is WALKED: a guard's
default has to be to look. `np.void` scalars gain an arm for the same reason.

**(2) The dtype check did not bound the work it claimed to.** `|S1` is kind `S` and passes every
text check. MEASURED, one root attribute of `np.zeros(100_000_000, dtype="|S1")`:

```
dict(h5.attrs)   0.28 s, maxrss 323 MB     <- the cost origin/main already pays
THE WALK        28.85 s, maxrss 894 MB     <- and it returns None
```

Same order as the `int64` case the dtype check removes, and a worse amplification ratio. So there
is now a SIZE cap (`_MAX_WALKED_ATTRIBUTE_BYTES`, 1 MiB — four orders of magnitude above the 27
bytes of the largest attribute on any committed fixture) and an array past it is REFUSED by name.

**(3) `decoded_h5_strings` said "every way the read can fail" and missed `KeyError`.** An h5 with
no `/matrix/barcodes` still produced `rc=1` and a raw traceback — the INV-1 violation the function
was added to remove, inside the function that removed it.

**(4) The new positions refusal fired AFTER the first writer.** It was correctly NAMED and it left
**51 paths** — which made INV-2's own new scope note ("*other*, correctly-named refusals still
fire after the first writer") false about a refusal this design had just added. `read_positions`
now joins `read_scalefactors` at the top of `run_import`. Every refusal this design adds now
precedes the first writer.

**(5) The `utf-8-sig` argument was backwards.** The comment said the header check "must keep"
stripping the BOM "for the HEADERLESS spelling too". It never did: the `lstrip` acts on a
temporary list the headerless branch discards, and `.strip()` does not remove `U+FEFF`. MEASURED:
headered + BOM -> `rc=0, 119 paths`; **headerless + BOM -> `rc=2, 51 paths`** ("1 of the matrix's
120 barcodes have no row"). `utf-8-sig` — the option the comment rejected — fixes it, and is what
`spatial-import-xenium`'s `read_cells_csv` already uses.

**(6) TEST-15's scale leg was VACUOUS.** It wrote the file with `json.dumps(doc)` at the default
`ensure_ascii=True`, so the µ landed as the ASCII escape `\u00b5` and the file was pure ASCII —
dropping `read_scalefactors`' `encoding="utf-8"` left the ENTIRE package suite green. The fix was
real; the test was not. `ensure_ascii=False`, with an assertion that the file really carries a
non-ASCII byte.

**(7) TEST-18's astral leg measured 1,969 characters**, not the ~3.2 kB its own prose claimed —
because the prose says "twice (value + path)" and the code made only the VALUE astral. Both legs
are built now.

Every one of the seven is pinned: reverting each in turn reddens TEST-20, TEST-21, TEST-22,
TEST-23, TEST-24, TEST-15 and TEST-18 respectively.
