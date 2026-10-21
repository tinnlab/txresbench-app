# The Visium micron scale is a property of the SLIDE DESIGN, not of the assay

**Issue:** [#257](https://github.com/phibya/cytoanalyst/issues/257), split out of #222.
**Status:** implemented on `feat/cytassist-calibration`.

## 1. The question

`spatial-import-visium` derives the coordinate space's `microns_per_pixel` as

```
microns_per_pixel = RENDERED_SPOT_DIAMETER_UM / scalefactors_json.json:spot_diameter_fullres
```

#222 fixed the numerator at **65.0 µm** — the circle Space Ranger renders for a standard
Visium spot — and verified it on a committed vendor bundle. #257 asks what that numerator
should be for a **Visium CytAssist** bundle, which reaches the same code path today (it
carries no `binned_outputs/`, so the Visium HD refusal does not fire) and is silently given
the 65 µm number.

The only figure in circulation when #257 was filed was **70.65 µm**, arithmetically
back-solved from one user's report in a third-party forum thread
([jinworks/CellChat#92](https://github.com/jinworks/CellChat/issues/92)) that a CytAssist
run's nearest-neighbour spot distance came out at ≈ 92 µm instead of 100 µm. #257 says
plainly that this is not enough to hard-code, and that "whatever number is chosen cites what
it IS, not what it fixes."

## 2. The vendor's answer: the field varies by SLIDE DESIGN

10x Genomics documents `spot_diameter_fullres` in
[Space Ranger → Spatial Outputs](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/spatial-outputs)
(retrieved 2026-09-06 via the Wayback snapshot `web.archive.org/web/20260520193934/…`;
`www.10xgenomics.com` returns HTTP 429 to a direct fetch), **verbatim**:

> `spot_diameter_fullres`: The number of pixels that span the diameter of a spot in the
> original, full-resolution image. **This field is intended for visualization purposes, and
> can vary for different slide designs, ranging from 60-70 µm.** Spot diameters and spot
> positions are estimates. It is better to use the known pixel dimensions of a calibrated
> microscope rather than trying to infer pixel dimensions from the spot diameter.

That single sentence settles the shape of the answer and refutes the premise of the question
as #257 posed it. The numerator is **not** a property of the ASSAY (CytAssist vs direct
placement). It is a property of the **slide design**, and it ranges over 60–70 µm. #222's
65.0 is one point in that range — the vendor's own worked example on the same page:

> The spot diameter and fiducial diameter are estimated fractional pixels of the spot
> diameter in the original image. **The estimation is based on the registration solution as
> well as the known size of the spots and fiducial frame.** Prior knowledge of the image
> pixel sizes is not used. In this example, the estimated pixel size was calculated from the
> spot diameter for the full resolution image: **microns/pixels = 65/89.44 ≈ 0.73**

The emphasised sentence is also the *mechanism* this design rests on (§4): both diameters
come out of **one** registration solution applied to **two known physical sizes**, so the
registration scale cancels in their ratio and what is left is the ratio of the two physical
circles.

The slide vocabulary, from the
[Space Ranger glossary](https://www.10xgenomics.com/support/software/space-ranger/latest/getting-started/space-ranger-glossary)
(Wayback `20260311130735`), verbatim:

> **Visium v2 includes assays that use the Visium CytAssist Spatial Gene Expression slides
> (v2, 6.5 mm and v2, 11 mm). Only compatible with the Visium CytAssist instrument. Visium
> v1 refers to direct placement assays that use Visium Spatial Gene Expression slides
> (v1, 6.5 mm).**

> **Visium v1 and v2 capture areas have an array of ~5,000 barcoded spots, 55 µm in
> diameter, spaced 100 µm apart.**

So the two constants #222 established for the *slide* are unchanged by CytAssist: the
capture spot is still 55 µm and — this is what makes `registration_qc`'s external referent
still apply — the pitch is still **100 µm** for every v1 and v2 capture area, CytAssist
included. Only the RENDERED circle moves. And the row counts, same page:

> Excluding the header column, the file has **4,992 rows for Visium slides with a 6.5 mm
> Capture Area and 14,336 rows for Visium slides with an 11 mm Capture Area**, which is the
> number of spots in the spatial array.

## 3. The measurement: 24 real vendor bundles

#222's bar is a measurement against the manufactured 100 µm pitch on a real committed
bundle. The same measurement, on every real Space Ranger bundle obtainable here — 14
downloaded from `cf.10xgenomics.com` for this work, 8 spatialLIBD DLPFC sections, the
committed repo fixture, and one further vendor archive already on the build host:

```
implied_rendered_spot_diameter_um = spot_diameter_fullres * (100 um / measured_pitch_px)
```

`measured_pitch_px` is the median distance between **same-row** neighbours
(`array_col ± 2`), which is the centre-to-centre pitch by construction. (The median
nearest-neighbour estimator `registration_qc` uses is the DIAGONAL neighbour and sits
~0.5% low of it, because the rendered lattice is not exactly equilateral — that difference
is inside `PITCH_TOLERANCE` and is why the tolerance is 5%, not 1%.)

| bundle | rows | `fiducial/spot` | pitch px | `pitch/spot_d` | implied µm | `regist_target_img_scalef` | `cytassist_image.tiff` |
|---|---:|---:|---:|---:|---:|:--:|:--:|
| CytAssist_FFPE_Human_Breast_Cancer | 4992 | 1.500000 | 183.003 | 1.431545 | 69.8546 | yes | yes |
| CytAssist_FFPE_Human_Lung_Squamous_Cell_Carcinoma | 4992 | 1.500000 | 366.000 | 1.428999 | 69.9791 | yes | yes |
| CytAssist_FFPE_Mouse_Brain_Rep1 | 4992 | 1.500000 | 365.001 | 1.427036 | 70.0753 | yes | yes |
| CytAssist_FFPE_Mouse_Brain_Rep2 | 4992 | 1.500000 | 365.166 | 1.427205 | 70.0670 | yes | yes |
| CytAssist_FFPE_Protein_Expression_Human_Tonsil | 4992 | 1.500000 | 365.005 | 1.428333 | 70.0117 | yes | yes |
| CytAssist_Fresh_Frozen_Mouse_Brain | 4992 | 1.500000 | 365.005 | 1.427538 | 70.0507 | yes | yes |
| spatialLIBD DLPFC 151507 | 4992 | 1.500000 | 138.000 | 1.431905 | 69.8370 | **no** | **no** |
| spatialLIBD DLPFC 151670 | 4992 | 1.500000 | 138.000 | 1.432116 | 69.8267 | **no** | **no** |
| spatialLIBD DLPFC 151671 | 4992 | 1.500000 | 138.000 | 1.431737 | 69.8453 | **no** | **no** |
| spatialLIBD DLPFC 151672 | 4992 | 1.500000 | 138.000 | 1.432039 | 69.8305 | **no** | **no** |
| spatialLIBD DLPFC 151673 | 4992 | 1.500000 | 138.004 | 1.431561 | 69.8538 | **no** | **no** |
| spatialLIBD DLPFC 151674 | 4992 | 1.500000 | 138.004 | 1.431901 | 69.8372 | **no** | **no** |
| spatialLIBD DLPFC 151675 | 4992 | 1.500000 | 138.004 | 1.431677 | 69.8481 | **no** | **no** |
| spatialLIBD DLPFC 151676 | 4992 | 1.500000 | 138.004 | 1.431817 | 69.8413 | **no** | **no** |
| Parent_Visium_Human_BreastCancer | 4992 | 1.615385 | 273.002 | 1.538052 | 65.0173 | no | no |
| V1_Breast_Cancer_Block_A_Section_1 | 4992 | 1.615385 | 273.002 | 1.538197 | 65.0112 | no | no |
| Visium_FFPE_Human_Breast_Cancer | 4992 | 1.615385 | 290.000 | 1.537891 | 65.0241 | no | no |
| Visium_FFPE_Mouse_Brain | 4992 | 1.615385 | 290.000 | 1.537566 | 65.0379 | no | no |
| Visium_Mouse_Olfactory_Bulb (committed fixture) | 160 | 1.615385 | 113.000 | 1.535027 | 65.1454 | no | no |
| CytAssist_11mm_FFPE_Human_Colorectal_Cancer | 14336 | 1.750000 | 365.005 | 1.665649 | 60.0366 | yes | yes |
| CytAssist_11mm_FFPE_Human_Glioblastoma | 14336 | 1.750000 | 365.001 | 1.665407 | 60.0454 | yes | yes |
| CytAssist_11mm_FFPE_Human_Ovarian_Carcinoma | 14336 | 1.750000 | 365.005 | 1.665915 | 60.0271 | yes | yes |
| CytAssist_11mm_FFPE_Mouse_Embryo | 14336 | 1.750000 | 365.000 | 1.665230 | 60.0518 | yes | yes |
| CytAssist_FFPE_Human_Colon_Post_Xenium_Rep1 | 14336 | 1.750000 | 366.001 | 1.668746 | 59.9252 | yes | yes |

Grouped:

| `fiducial/spot` | n bundles | implied µm (min…max) | mean | the constant |
|---|---:|---|---:|---:|
| 1.615385 = 21/13 | 5 | 65.0112 … 65.1454 | 65.0472 | **65.0** |
| 1.500000 = 3/2 | 14 | 69.8267 … 70.0753 | 69.9113 | **70.0** |
| 1.750000 = 7/4 | 5 | 59.9252 … 60.0518 | 60.0172 | **60.0** |

Three clusters, each landing on a round number to better than **0.25%** — the same order as
the 0.2237% #222 accepted for 65.0 on the committed bundle, and slightly LOOSER at its worst
(DLPFC 151670 at 0.2476% off 70.0), which is stated because an earlier draft of this
paragraph claimed "tighter than 0.22%" and that half was false. All three sit inside the
vendor's stated 60–70 µm range, with 60 and 70 exactly ITS ENDPOINTS. The 70.0 figure also
explains and supersedes the forum report #257 was left with: applying 65 µm to a 70 µm slide
predicts a pitch of `100 × 65/70 = 92.86 µm`, which is the "≈ 92 µm" that thread measured.

### Why the constants are ROUND, and why that is not a fit

A blind audit put the sharpest possible question to this section: the measured means are
69.9113 and 60.0172, no vendor sentence states 70.0 or 60.0 as such, and §4 refuses the one
derivation that would make them exact — so is "roundness" doing the work? It would be, on the
measurements alone. It is not, because of a fourth constraint the measurements do not supply:

```
fiducial/spot  ×  rendered spot µm     =  105.0 µm   for every design
   21/13       ×        65             =  105
    3/2        ×        70             =  105
    7/4        ×        60             =  105
```

The three ratios are EXACT and INDEPENDENT — three different slide designs, three different
rationals, measured on 24 bundles across five Space Ranger versions. There is exactly one
assignment of rendered diameters that makes all three consistent with a single rendered
fiducial circle, and it is (65, 70, 60). Round numbers are not chosen here; they are the
unique solution to three exact constraints, and the measured means sit 0.13% and 0.03% from
it. That is why 70.0 is preferred to 69.9113 — not because it is tidier, but because 69.9113
would require the fiducial circle to be a different physical size on the CytAssist 6.5 mm
slide than on the other two, which nothing supports.

The 105 µm figure itself is NOT vendor-stated, which is why §4 keeps it out of the code path.
It is load-bearing here as a CONSISTENCY argument and nowhere as a value: the shipped
constants are the three measured diameters, each cited to its own bundles.

### What is committed

Two of those bundles are committed to this repository as fixtures, by the same recipe as the
existing `visium-outs/` one — vendor bytes only, subset, nothing synthesised:

| fixture | vendor sample | design | rendered spot | fixture's own measurement |
|---|---|---|---|---|
| `tests/fixtures/cytassist-v4-outs/` | `CytAssist_FFPE_Human_Lung_Squamous_Cell_Carcinoma` (Space Ranger 2.0.0, `Visium V4 Slide`) | 6.5 mm, 3/2 | **70.0 µm** | the COMPLETE 4,992-row table (3,858 in tissue); same-row pitch 366.000 px → implied **69.979 µm** (0.030%); nearest-neighbour 366.000 px → 69.979 µm |
| `tests/fixtures/cytassist-v5-11mm-outs/` | `CytAssist_11mm_FFPE_Human_Colorectal_Cancer` (Space Ranger 2.0.1, `Visium V5 Slide`) | 11 mm, 7/4 | **60.0 µm** | the COMPLETE 14,336-row table (9,080 in tissue); same-row pitch 365.005 px → implied **60.037 µm** (0.061%); nearest-neighbour 363.077 px → 60.356 µm |

**The positions tables are COMPLETE, not windows, and that is load-bearing.** They were
170-row windows until a blind audit measured what a window cannot see: a producer switching
its numerator on `len(positions) >= 1000` — a threshold no window reaches — passed the entire
package suite AND the cross-package gate while applying 55 µm to every real vendor bundle, a
21.4% under-estimate and #222 restored in full. That is #243's lesson one file over, where an
undersized image fixture hid an incoherent artifact for months. The tables are now 10x's own
documented row counts for these capture areas (4,992 and 14,336), which closes every
threshold at or below a real capture area; and
`test_the_numerator_does_not_depend_on_how_many_spots_the_table_has` closes the SHAPE of it
for any threshold, by importing the same bundle windowed and whole and requiring the same
numerator. The `.h5` files stay subsets — the filtered matrix legitimately holds fewer
barcodes than the positions table, which is the shape the standard fixture has too.

Cost, stated: a full 11 mm import spends ~7 s in `registration_qc.measure_spot_pitch`, whose
`PITCH_EXACT_MAX_SPOTS = 20_000` means 14,336 spots are measured exactly. That is shipped
behaviour on every real 11 mm bundle, not something the fixture introduced — the fixture is
simply the first thing in this repo to exercise it.

**Both estimators, stated, because they differ and the difference matters.** The corpus table
above is built on the SAME-ROW pitch, which is the centre-to-centre distance by construction.
`registration_qc` uses the median NEAREST-NEIGHBOUR pitch, which is the DIAGONAL neighbour and
sits up to ~0.5% low of it on a rendered hex lattice that is not exactly equilateral. On the
V4 subset the two coincide exactly; on the V5 subset they are 0.53% apart. An earlier draft
of this table quoted the V4 row's "they agree exactly" note on the V5 row too, and quoted the
V5 row's nearest-neighbour figure against the corpus table's same-row column — a blind audit
caught both. `PROVENANCE.json` now records both estimators for both fixtures.

Licence, source URL, archive sha256 and each fixture's measured numbers are in
`tests/fixtures/PROVENANCE.json`. Both datasets are CC BY 4.0, read verbatim from Internet
Archive snapshots of their 10x dataset pages (10x hard-429s a live fetch); each snapshot also
names its sample and its Space Ranger version, which match the committed `.h5` root
attributes.

## 4. The discriminator is `fiducial_diameter_fullres / spot_diameter_fullres`

**The assay is the wrong key, and the data says so — twice, and the first time on data this
repository commits.**

*First, from a committed bundle.* `CytAssist_11mm_FFPE_Human_Colorectal_Cancer` is a real
CytAssist run (`regist_target_img_scalef` present, `chemistry_description: "Visium V5 Slide"`)
whose rendered spot circle is **60 µm, not 70**. So "CytAssist implies 70" is false on
licence-recorded, sha256-recorded vendor data sitting in `tests/fixtures/`, with no appeal to
anything off-repo. That alone settles that the assay is not the key.

*Second, and this is the part that shows the assay could not be REPAIRED into a key.* The
eight spatialLIBD DLPFC sections in the table are **direct-placement Visium** —
`chemistry_description: "custom"`, `software_version: "4509.5.5"`, an internal Space Ranger
predating the CytAssist instrument, no `regist_target_img_scalef`, no `cytassist_image.tiff` —
and they render spots at 70 µm, the same circle CytAssist 6.5 mm uses. So even "CytAssist
6.5 mm implies 70, everything else 65" is wrong.

**That corpus is quoted, not redistributed**, and its provenance is stated so a reader can
check it: spatialLIBD / Maynard et al. 2021, *Nat Neurosci* 24:425-436; sample 151673's
`spatial/scalefactors_json.json` has sha256
`91c4beb9ca8145855a6a6df0a00eda6541931fc12d82d09cf8f01c9c15179dbc` and contents
`{"spot_diameter_fullres": 96.40082438014726, "tissue_hires_scalef": 0.150015,
"fiducial_diameter_fullres": 144.6012365702209, "tissue_lowres_scalef": 0.045004502}`, whose
fiducial/spot ratio is 1.5 exactly. `test_the_assay_does_not_decide_the_constant` leads with
the committed refutation and carries this one as labelled corroboration.

A rule keyed on `chemistry_description` fails for the same reason and one more: it reads
`custom` on that corpus, and would have to be extended every time 10x mints a slide version.

What separates the three clusters exactly is a quantity the bundle states about itself:

```
fiducial_diameter_fullres / spot_diameter_fullres
```

Both fields are, in the vendor's own words, "estimated ... based on the registration
solution as well as the known size of the spots and fiducial frame". One registration
solution, two known physical sizes — so the pixel scale **cancels** and the ratio is the
ratio of the two physical circles. Measured, it is not merely close to a rational, it IS
one:

| slide design | `fiducial/spot` measured | exact rational | rendered spot |
|---|---|---|---|
| Visium 6.5 mm, 65 µm rendered spot | 1.6153845317888516 | 21/13 = 1.6153846153846154 | 65.0 µm |
| Visium 6.5 mm, 70 µm rendered spot | 1.5 (exact, all 14) | 3/2 | 70.0 µm |
| Visium 11 mm, 60 µm rendered spot | 1.75 (exact, all 5) | 7/4 | 60.0 µm |

The worst deviation from the exact rational anywhere in the corpus is **5.2 × 10⁻⁸**
(relative), on the 21/13 cluster; the other two are exact in IEEE-754 double. The closest
two designs are **7.1 % apart**. The classifier therefore has ~6 orders of magnitude of
headroom, and `SLIDE_DESIGN_RATIO_TOLERANCE = 1e-3` sits four orders above the noise and
seventy times below the signal — derived the same way `PITCH_TOLERANCE` was, from the two
ends it has to separate, and not from a fixture.

Every design's rendered diameter is `105 µm / (fiducial/spot)` to within a rounding — i.e.
the rendered fiducial circle is a constant ~105 µm across all four designs. **That is an
observation, not the rule.** No vendor document states 105 µm, so it is recorded here as
corroboration and is deliberately NOT the constant the code divides by; the code carries the
three measured spot diameters, each cited to its own bundles.

### Why the table snaps rather than computing

`rendered = 105 × spot_d / fiducial_d` would be a one-line derivation, and it is refused:
105 is a number no vendor document states, and using it would (a) invent an uncited constant
to avoid citing three measured ones, and (b) perturb standard Visium by ~5 × 10⁻⁸, which is
noise but is still a change to the number #222 pinned. Matching a ratio against a table of
**observed slide designs** and taking that design's own measured constant keeps 65.0 exactly
65.0 and keeps every constant cited to bundles rather than to arithmetic.

### When the ratio matches nothing

A bundle whose `fiducial/spot` matches no known design — a design 10x ships after this is
written, or a `scalefactors_json.json` with no `fiducial_diameter_fullres` — falls back to
the standard 65.0 µm, which is exactly today's behaviour, and the report SAYS SO, naming the
measured ratio. It does not refuse (DEC-7: this importer reports loudly rather than denying
a user their data) and it does not guess a new constant. `registration_qc`'s scale check is
then the backstop: an unrecognised design whose rendered circle is really 60 or 70 will fail
the 100 µm referent by 8%, loudly, with the design's identity in the reason.

## 5. The assay is still detected — for the REPORT

Which slide design is on the slide answers "what circle does `spot_diameter_fullres`
measure?". It does not answer "what kind of run was this?", and #257 asks for that too: a
run report that does not name the assay leaves a reader to derive it, which is the #222
lesson restated.

**Authoritative signal: `regist_target_img_scalef` in `scalefactors_json.json`.** Present in
11 of 11 CytAssist bundles above; absent from 13 of 13 non-CytAssist ones, including the
DLPFC set that shares their 70 µm rendered circle. It is chosen over the two alternatives
because it lives in a file this importer must already read and already parses, so it cannot
be lost by an upload that flattens or renames the tree.

**Corroborating: `cytassist_image.tiff` present under the bundle** (agrees on all 24: 11/11
and 0/13) — but it is an OPTIONAL member, and this importer's member matching is by
basename over a possibly-flattened upload, so its absence is not evidence.

**Corroborating: `chemistry_description` in the matrix `.h5` root attributes** — reads
`Visium V4 Slide` (6.5 mm CytAssist) or `Visium V5 Slide` (11 mm CytAssist) on the bundles
above. It is a free-text vendor string that reads `custom` on real data, and gating on it
would need a new match arm for every slide version 10x ships. It is recorded and compared,
never decisive.

All three are written into the report beside the verdict, so a human sees agreement — or
disagreement — rather than a bare classification.

## 6. `cytassist_image.tiff` is explicitly NOT emitted

`VENDOR_IMAGES` maps a vendor image basename to the **scalefactor that places it**; the
affine is the inverse of that scalefactor, which is what lets several images share one
coordinate space. There is no such scalefactor for the CytAssist image. From the same
vendor page, verbatim:

> `cytassist_image.tiff`: Copy of the original CytAssist image input, which is a
> eosin-stained brightfield image in TIFF format that contains the fiducial frame. **It has
> a resolution of 3,200 x 3,000 pixels (Visium HD) or 3,000 pixels in both dimensions
> (Visium v2).**

> `regist_target_img_scalef`: A scaling factor that converts pixel positions in the original,
> full-resolution microscope image to the downsampled version used in image registration.

Measured on `CytAssist_FFPE_Mouse_Brain_Rep2`: the full-resolution frame implied by
`tissue_hires_scalef` is 23740 × 28062; `regist_target_img_scalef = 0.21381228` maps it to
5076 × 6000, which is EXACTLY the size of `aligned_tissue_image.jpg` — so that key places
the registration target, as the vendor says, and not the CytAssist image. The CytAssist
image is a fixed **3000 × 3000** copy of the instrument's own input: no single scale factor
maps a square frame onto a 23740 × 28062 one, and the two aspect ratios differ by 18%.

So the image cannot be placed from anything in the bundle, and emitting it with a
constructed affine is precisely the failure `registration_qc` exists to catch — #155's
TEST-9 records that a deliberately wrong affine survives the declaration constructor, the
writer, the reader and the placement round trip. It is therefore reported in
`images_not_emitted` with that reason, which is the channel that exists so an optional
member cannot vanish in silence.

### …and the OTHER CytAssist-only image, which this section nearly left silent

`aligned_tissue_image.jpg` is written on the same runs and only on them:

> `aligned_tissue_image.jpg`: This image is generated when both CytAssist and microscope
> image inputs are provided (Visium CytAssist v2 and Visium HD). It captures the results of
> the image registration by merging the registered images in a checkerboard pattern with
> adjacent squares alternating between the two images.

The first implementation of this design handled `cytassist_image.tiff` and put this one in no
table at all — neither emitted, nor refused, nor reported — which is exactly the silence the
section above exists to remove, one image over. A blind design-conformance audit found it by
reading this document's own §6 measurement back against the code.

It does NOT belong in `NON_PLACEABLE_VENDOR_IMAGES`: the measurement above shows
`regist_target_img_scalef` maps the full-resolution frame onto precisely its pixel dimensions,
so it IS placeable and "no scalefactor places it" would be a false reason. What it is, in the
vendor's own words, is a QC rendering of a registration — the same kind of thing as
`aligned_fiducials.jpg` and `detected_tissue_image.jpg`, which this importer already treats as
diagnostics: embedded in the report, capped, and never emitted as artifacts (§7.2, "diagnostics,
not data"). It joins them in `DIAGNOSTIC_BASENAMES`.

## 7. What this does NOT claim

- It does not make `spot_diameter_fullres` a physical measurement. 10x says it is
  "intended for visualization purposes" and that the diameters "are estimates". It is used
  here for exactly one thing — recovering the pixel scale — because it is the only scale
  the common bundle carries, and the result is checked against the slide's 100 µm pitch
  rather than trusted.
- It does not touch `VISIUM_CAPTURE_SPOT_DIAMETER_UM = 55.0` (what a spot IS) or
  `SLIDE_SPOT_PITCH_UM = 100.0` (what the glass IS). Both are vendor-stated for v1 and v2
  alike, CytAssist included, per §2.
- It does not cover Visium HD, where `spot_diameter_fullres` "refers to the side length of
  the Visium HD squares (2 µm)" — a different quantity entirely. HD is refused by name
  before any of this runs (DEC-5, #160).
- The 70 µm rendered circle on the spatialLIBD DLPFC sections means **standard Visium was
  also affected**, on a corpus of widely-used public data, by the same 7% error #257 found
  for CytAssist. That is fixed here as a consequence of keying on the slide design rather
  than the assay; it was not what #257 asked for, and it is called out so the scope of the
  change is not understated.
