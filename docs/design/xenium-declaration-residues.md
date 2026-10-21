# Xenium declaration residues — series-bound channel identity, and the non-identifying vendor label

**Status:** design note for #319 + #320. Both are residues of the rule #270/#271 established in
`src-app/packages/spatial-import-xenium`, and neither is a new idea: each is a place that rule
was not fully applied.

The rule, stated once:

> **emit what was verified, disclose what was inferred, never let an inference occupy a field a
> consumer reads as vendor fact.**

`compute/xenium_image.py`'s `_channel_index` already carries the same rule in its own words, and
that sentence is the precedent both sections below follow rather than replace:

> *"Refusing the CLAIM rather than the image: fall through to channel 0 and say `first-channel`,
> so the declaration never asserts a stain it did not verify."*

`compute/import_xenium.py`'s `coordinate_space_id` carries the error-direction rule the same way:

> *"a MISSED collision is visible and recoverable while a FALSE collision is silent wrong data"*

---

## §1 — the emitted plane's channel identity must be bound to the EMITTED SERIES (#319)

### §1.1 What is wrong today

`_channel_index` resolves the `CYX` channel by matching `channel_names(xml)` — a regex over the
**whole OME-XML** — against `series.pages`, **positionally**:

```python
for i, name in enumerate(names[:page_count]):
    if PREFERRED_CHANNEL in (name or "").strip().lower():
        return i, "channel-name-match", (name or "").strip()
```

`names[i] ↔ pages[i]` holds only for a document declaring **one** `<Image>`. `Channel@Name` is
optional in OME and a document may declare several images, so the flat list is not the emitted
series' channel list. `channel_names`' own docstring already says so:

> *"`channel_names(xml)[0]` is 'the first channel this DOCUMENT declares', never 'the channel of
> the plane we emitted'"*

`sole_declared_channel`'s docstring already names this exact gap and files it as #319:

> *"**The `CYX` index is not a complete answer either, and saying otherwise here would be the
> same defect one paragraph up.**"*

**MEASURED** on a constructed file — `Image:0` is the emitted `CYX` series with two **unnamed**
channels, `Image:1` declares `<Channel Name="DAPI"/>`:

```
{'axes': 'CYX', 'axis': 'C', 'index': 0, 'of': 2, 'rule': 'channel-name-match',
 'channel_name': 'DAPI', 'available': ['DAPI']}
```

The emitted pixels are `Image:0`'s channel 0, which is unnamed. The declaration asserts the stain
`DAPI`, asserts `rule: "channel-name-match"` — a positive claim that a match happened — and reports
`available: ['DAPI']` for a two-channel image. Three false statements about another image's stain.

### §1.2 The binding, and the two conditions that establish it

The list `_channel_index` matches against must be the **emitted series' own** channel list. Two
facts, both readable from the document, establish that:

1. **the document declares exactly ONE `<Image>`** — then `handle.series[0]` is that image and its
   channels are the only channels the document declares. This is the same clause
   `sole_declared_channel` already uses, for the same reason.
2. **that image declares exactly `page_count` `<Channel>` start tags** — then tag `i` is page `i`.
   Without this the list is not index-aligned even for a single image: a 12-page series whose
   document declares one channel says nothing about pages 1..11, and `names[i]` is then a name
   belonging to some other channel.

3. **the tags are read from inside that image's `<Pixels>`** — `<Channel>`'s actual OME parent —
   **not from the whole document and not merely from inside the `<Image>`.** OME gives a legal
   place for a `<Channel>` to sit outside any image: `<StructuredAnnotations><XMLAnnotation>
   <Value>…`, which is how Bio-Formats-class converters preserve a file's ORIGINAL metadata. Such
   a tag does two damaging things at once — it RESTORES the count condition 2 relies on, and it
   SHIFTS every position.

   **This condition took two audit rounds and the first version of it was in the wrong place.**
   Round 1 measured the block sitting outside the `<Image>`, on a document with one `<Image>`
   declaring `18S`/`GFP` over a 3-page `CYX` series:

   ```
   {'axes': 'CYX', 'axis': 'C', 'index': 0, 'of': 3, 'rule': 'channel-name-match',
    'channel_name': 'DAPI', 'available': ['DAPI', '18S', 'GFP']}
   ```

   and the fix scoped the count to the `<Image>` span. Round 2 then moved the SAME block one level
   in — after `</Pixels>`, still before `</Image>` — and both defects came back at full strength:

   ```
   {'axes': 'CYX', 'axis': 'C', 'index': 2, 'of': 3, 'rule': 'channel-name-match',
    'channel_name': 'DAPI', 'available': ['18S', 'GFP', 'DAPI']}
   ```

   — a retired stain asserted as this plane's, at an index the image declares no channel for, with
   `available` one entry longer than the image's own channel list. **A scope check has to be taken
   at the element that actually PARENTS the thing being counted**; taken one level out it leaves
   exactly one level of room, and that room is where a converter writes.
   `xenium_image.sole_pixels_span(xml)` answers "the XML inside the one `<Pixels>` inside the one
   `<Image>`": with exactly one start tag at each level the extent is unambiguous, so this still
   needs no parser, and it fails CLOSED at either level.

The function that answers the whole question is
`xenium_image.series_channel_names(ome_xml, page_count)`, and its return value is the whole
contract: the bound list, or `[]` meaning *the binding was not established and nothing may be
indexed off it*.

Condition 2 also repairs a second, quieter misalignment that exists today: `_CHANNEL_NAME_RE` only
matches channels that CARRY a `Name` attribute, so a 12-channel image with channels 0-1 unnamed
yields a 10-element list in which `names[0]` is channel 2's name. The bound list is built from
**every** `<Channel>` start tag, in order, each contributing its name **or the empty string** — so
position is preserved by construction.

The bound list is read with the audited machinery `#270/#271` shipped (`_XML_NOISE_RE`,
`_start_tags`, `_tag_name`), not with the raw whole-document regex: a commented-out `<Channel>`, a
`<ChannelRef>`, a `FluorName=` attribute and a single-quoted `Name` are all already-measured wrong
answers there.

### §1.2b `sole_declared_channel` has the identical residue, and it is PRE-EXISTING

The same stray-`<Channel>` vector reaches #271's own verified-association rule, and there it is
worse. MEASURED on clean `origin/main` @ `778eddc3`: a document whose ONE `<Image>` declares NO
channel of its own, plus one annotation `<Channel ID="Legacy:0" Name="DAPI"/>`, returns `'DAPI'` —
asserted as the emitted plane's VERIFIED stain, with `channel_name_rule: "sole-declared-channel"`.
Exactly one image and exactly one named channel tag, so all three of that function's clauses pass
it; and the stain it names is one a converter RETIRED, which that function's own docstring calls
*"the one name most certainly not this plane's"*.

So `sole_pixels_span` is shared, and `sole_declared_channel` gains it as a **fourth clause ANDed on
top of the existing three**. (The nested-block shape above revives this defect too, and did:
against the round-1 fix, that document returned `'DAPI'` with
`channel_name_rule: "sole-declared-channel"`. It is the `<Pixels>`-level span that closes it.) That direction matters: the new clause can only ever refuse documents
the function already accepted — it never newly accepts one — so #271's verdicts are unchanged on
every fixture it shipped with and on all three real vendor documents, which is asserted rather than
argued.

### §1.3 What is emitted when the binding cannot be established

The honest output is the one this file already models. **Refuse the CLAIM rather than the image:**

* the plane is still emitted. `_channel_index`'s FILENAME leg is untouched and still answers, because
  it reads the filename — an independent source, and the one the leg exists for (*"a bundle whose
  `Channel@Name`s a converter stripped"*); it simply no longer decorates its answer with a name
  taken from the unbindable list. Where the filename does not answer either, the result is index 0
  with `rule: "first-channel"`;
* **no `channel_name`** — the importer asserts no stain it did not verify;
* **no `available`** — that key claims "the channels of THIS SERIES, index-aligned with its pages",
  and that is exactly what could not be established;
* the refusal is STATED with its evidence **when the document names any channel at all**, in the
  vocabulary #270/#271 shipped and no other: `channel_name_rule: "unverified-channel"` plus
  `declared_channels: [...]` — what the DOCUMENT says, in document order, paired to nothing.

  **When it names none, nothing is emitted, and that is deliberate.** `unverified-channel` means
  *the document names channels but not verifiably this plane's*; writing it for a document that
  names no channel would be a false statement in the one key whose purpose is not to make them.
  That is `declare_channel`'s outcome 3 — *"the document names no channel at all -> nothing.
  Absence stays absence (INV-3); there is no refusal to disclose because there was no claim to
  refuse."* — and this branch keeps it rather than widening the token. The cost, named because a
  blind angle raised it: for such a document a reader cannot tell "the binding was attempted and
  refused" from "this image declares no channel", and the machine-readable tell is only the
  ABSENCE of `available`. Making that distinction sayable needs a token for it, which is a
  vocabulary change across three vendored copies and is not #319.

No new disclosure vocabulary is introduced. `sole-declared-channel` is deliberately NOT reused on
this branch: it answers "the whole image is one named channel", which is a `YX`/`ZYX` question; a
`CYX` series has an index, and its verified answer is the existing `rule` value.

Where the binding IS established, every existing outcome is unchanged: `channel-name-match`,
`filename-match` and `first-channel` keep their meanings and `available` keeps its promise. The
real protein bundle (one `<Image>`, twelve named `<Channel>`s, twelve pages) is unaffected.

---

## §2 — a value that is only the name of its own field does not identify a sample (#320)

### §2.1 What is wrong today

After #270, `section.sample_id` comes from exactly one vendor leg — `region_name` — filtered
through `vendor_statement`'s closed `_VENDOR_PLACEHOLDERS` list (`"", "n/a", "na", "unknown",
"none", "null", "-"`). That list holds the spellings a vendor writes to mean **"no answer"**.

**MEASURED** on two staged copies of the shipped `xenium-prime-outs` fixture with different
`roi_uuid`s:

```
bundle a: region_name='region'  roi_uuid=…0000 -> sample_id='region'  space='xenium:…0000'
bundle b: region_name='region'  roi_uuid=…0001 -> sample_id='region'  space='xenium:…0001'
SAME sample_id, SAME index (0), DIFFERENT coordinate_space
```

Two unrelated experiments declare themselves *section 0 of sample `region`*. It is the same FALSE
COLLISION #270 removed the `slide_id` leg for, arriving through the leg that was KEPT.

### §2.2 The rule, and why it is NOT a longer placeholder list

`"region"` is **not** added to `_VENDOR_PLACEHOLDERS`. That list means *"the vendor said nothing"*,
and it is deliberately CLOSED — its own comment says a heuristic "would eventually drop a real id".
`region_name='region'` is a different fact: the vendor DID write something. The provenance block
must keep recording it verbatim, because recording what the file says is that block's whole job.

The question this branch answers is narrower, and it is about **identification**, not about
provenance:

> **A value that is only the generic name of the field it fills does not identify anything.**
> `region_name = "region"` is the word every unnamed region carries. Whatever wrote it, it cannot
> distinguish this run from any other run that left the field generic — and `section.sample_id` is
> read as "these are sections of ONE sample."

Stated as a predicate — **the self-naming-field rule**: strip a trailing `_name` / `_id` / `_label`
from the KEY and case-fold both sides; if the value equals what is left — or equals the whole key —
the value is non-identifying. `region_name → "region"`, and also `region_name → "region_name"`,
which identifies exactly as much (nothing) and which the sentence above covers in the same breath.
`slide_id → "slide"`. The predicate is DERIVED FROM THE KEY, so it is not a denylist and there is no
list to grow: it asks one structural question and the question is the same for every field.

Said precisely, because that last clause is about the RULE and can be misread as a claim about the
shipped behaviour: **when #320 shipped**, the predicate had exactly one call site, with the literal
key `"region_name"`, so what it operationally rejected was `region` / `region_name` and their case
and whitespace spellings, on one field. The generality is what makes the answer to #270's DEC-4
honest — there is no list a new vendor spelling has to be added to, and a second call site needs no
new rule — not a claim that many fields were being filtered then.

**#323 took that second call site** (§3.3): `vendor_frame_label` asks the same predicate of
`roi_uuid`, `slide_id` and `region_name`, so today it operationally rejects `roi` / `slide` /
`region` and their whole-key and case spellings, across four fields and two call sites. The rule
did not change; `_uuid` joined `_NON_IDENTIFYING_KEY_SUFFIXES` by the tuple's own derivation (a key
is its SUBJECT plus the KIND of thing it holds), which is what "a second call site needs no new
rule" was predicting.

### §2.3 The evidence

On the two shipped bundles, `xenium-prime-outs` writes

```
slide_id='slide'  region_name='region'  run_name='run'  cassette_name='cassette'
```

— **four** independent operator-supplied fields, each exactly the subject of its own key — while
`xenium-protein-outs` writes real values for all four (`Slide_1`, `hKidney_sample`,
`Xenium_4_Tiny_Test_Data`, `Cassette_1`). Four fields simultaneously carrying their own field name
is not four operator choices; it is the shape of an unfilled form. 10x's own documentation records
that Region name, Slide ID and Cassette name are operator inputs at instrument initialization —
i.e. exactly the kind of field that gets left generic on a demo or a hurried run
(<https://www.10xgenomics.com/support/software/xenium-onboard-analysis/3.4/analysis/xoa-output-understanding-outputs>).

The claim this branch makes is deliberately weaker than "10x auto-fills these", which the
documentation does not support and DEC-4 of #270 was right to refuse for lack of evidence. The
claim is only that **the string does not identify a sample**, which is checkable from the string and
its key alone and does not require knowing who typed it.

### §2.4 What is emitted

`section_sample_id` gains one leg between the vendor statement and the no-statement fallback:

| `region_name` | `sample_id` | `sample_id_source` |
|---|---|---|
| `hKidney_sample` | `hKidney_sample` | `region_name` |
| `region` | `unverified-sample:<space_id>` | `non-identifying-region-name` |
| absent / `unknown` / `""` | `unverified-sample:<space_id>` | `no-vendor-sample-statement` |

Both non-statement legs are unique per coordinate space, so two unrelated runs cannot collide. The
`source` distinguishes them, so a reader can tell "the vendor wrote nothing" from "the vendor wrote
a word that names no sample" — and the provenance block still carries `region_name: "region"`
verbatim, so the operator's own string is never lost.

### §2.5 The `coordinate_space_id` rung this rule does NOT reach, and why (WITHDRAWN → #323)

> **RESOLVED by §3.** Everything below is the record of #320 declining to half-fix this and
> filing it instead; it is kept because §3.2 turns on *why* the obvious patch was wrong. The
> three rows measured here are closed by §3, whose §3.6 tabulates them before and after.

`unverified-sample:<space_id>` is only as unique as `space_id`, and `coordinate_space_id`'s second
rung, `coordinate_space_source: "slide_id+region_name"`, is `f"xenium:{slide}_{region}"` — which on
a prime-shaped bundle with no `roi_uuid` is `xenium:slide_region`, identical for two unrelated runs.
The obvious move is to gate that rung with the same predicate. **That was written, measured, and
withdrawn.**

MEASURED on clean `origin/main` @ `778eddc3`, which is what the gate would have fallen through to:

```
nothing stated, root=/inputs/bundle    -> xenium:bundle           (bundle-directory-name)
nothing stated, root=/uploads/x/outs   -> xenium:outs             (bundle-directory-name)
nothing stated, root=/uploads/y/outs   -> xenium:outs             (bundle-directory-name)
roi_uuid='unknown', two runs           -> xenium:unknown          (roi_uuid, BOTH)
slide/region='unknown', two runs       -> xenium:unknown_unknown  (slide_id+region_name, BOTH)
```

`bundle_root`'s basename is the sandbox MOUNT NAME, which `sandbox/spec.rs` derives from the SLOT
(`derive_artifact_mount_name` / `InputDecl::declared_mount_name`) — plausibly the constant `bundle`
for every Xenium import in a deployment — and where it is the user's own directory, `outs` is XOA's
own output directory name. So the gate moves a bundle from a value shared by *prime-shaped* runs to
a value shared by *all* runs: a **wider** false collision, in the direction this module names
unrecoverable, bought at the price of altering a #270 decision.

The last three rows are on `origin/main` and have nothing to do with #320. Every rung of that ladder
has this shape, so no single-rung patch escapes it. It is **one** finding about `coordinate_space_id`
and is filed as **#323** with those measurements, pinned here by a characterization test that goes
RED the day #323 lands.

**What that costs, stated plainly — and it is a real residue, not a clean scope line.**
`section_sample_id`'s unverified leg promises *unique per coordinate space* and delivers exactly
that. It does **not** deliver INV-4 outright, and an earlier draft of this section claimed it did.
THREE shapes reach `run_import` and give two unrelated bundles the same `section.sample_id`, all
three MEASURED end to end and all three present on `origin/main`:

| shape | `coordinate_space` | `section.sample_id` | `sample_id_source` |
|---|---|---|---|
| `roi_uuid='unknown'` | `xenium:unknown` | `unverified-sample:xenium:unknown` | `non-identifying-region-name` |
| prime-shaped, no `roi_uuid` | `xenium:slide_region` | `unverified-sample:xenium:slide_region` | `non-identifying-region-name` |
| nothing stated, slot-mounted | `xenium:bundle` | `unverified-sample:xenium:bundle` | `no-vendor-sample-statement` |

What is true, and is the reason this is scoped out rather than papered over: in every row the two
runs are ALREADY declared to share a coordinate FRAME, which is a larger claim than sharing a
sample, so this leg adds no second independent lie — it inherits the first. What is also true is
that row 1's colliding value is minted by this branch's own new leg, so "inherited" is a
description of the CAUSE and not an excuse.

The cause is `coordinate_space_id` and it is not locally fixable — gating one rung moves the
rejected values onto a rung that is less discriminating, which is exactly why the gate was
withdrawn. It is filed as **#323** with these measurements and asserted by TEST-17, which carries a
"delete this row and close #323" message so the day the ladder is fixed this stops being true
loudly rather than silently.

### §2.6 What this does to a sample genuinely named "region"

It is **not** emitted as `section.sample_id`. That bundle gets `unverified-sample:xenium:<roi_uuid>`
with `sample_id_source: "non-identifying-region-name"`, and `provenance.region_name` still reads
`"region"`, so nothing the vendor wrote is lost and the report says plainly why the field was not
used.

The cost is a MISSED collision: two real sections of one sample both named `region` are not grouped.
That is the direction this module already chose by name — *"a MISSED collision is visible and
recoverable while a FALSE collision is silent wrong data"* — and it is recoverable by the operator,
who can see the reason in the report and name the region something that identifies it. The FALSE
collision it replaces is silent and is not recoverable by anyone.

### §2.7 The one #270/#271 assertion this changes, and why that is not a weakening

`tests/test_unverified_declarations.py::test_the_real_bundles_still_declare_the_vendors_own_region_name`
asserts, for the prime bundle, `section == {"sample_id": "region", "index": 0}` and
`sample_id_source == "region_name"`. #320 names that test in its own body as *"the executable
record of the current behaviour"* — the behaviour it was filed to change. Its prime-bundle leg
cannot survive any fix to #320, because it IS #320.

What that test is FOR is kept and strengthened, not removed. Its control content — "a change that
namespaced every sample id, or that started refusing the real ones, would pass every assertion
above; this is what refuses it" — is carried by the protein bundle's leg (`hKidney_sample` via
`region_name`, unchanged) and is extended here with a bundle whose `region_name` is a real name
that merely CONTAINS the generic word, so the new predicate cannot pass by being blunt.

---

## §3 — a coordinate frame identity is never a name the run could have borrowed (#323)

**Status:** this section is the design for #323. §2.5 above records the same finding being
*withdrawn* one branch earlier; what follows is why it could not be fixed there, and what has to
change for it to be fixable at all.

### §3.1 What is wrong today

`compute/import_xenium.py`'s `coordinate_space_id` is a three-rung ladder and **every rung can
answer with a value two unrelated runs share.** MEASURED on clean `origin/main` @ `5c6b499e`,
driving the shipped `coordinate_space_id` + `section_sample_id` (the same rows #323 records, which
were first measured at `778eddc3` and reproduce unchanged):

```
roi_uuid='unknown'   root=/uploads/run-A  -> space='xenium:unknown'          src=roi_uuid
roi_uuid='unknown'   root=/uploads/run-B  -> space='xenium:unknown'          src=roi_uuid
slide/region='unknown'   run-A            -> space='xenium:unknown_unknown'  src=slide_id+region_name
slide/region='unknown'   run-B            -> space='xenium:unknown_unknown'  src=slide_id+region_name
nothing              root=/inputs/bundle  -> space='xenium:bundle'           src=bundle-directory-name
nothing              root=/uploads/x/outs -> space='xenium:outs'             src=bundle-directory-name
nothing              root=/uploads/y/outs -> space='xenium:outs'             src=bundle-directory-name
```

Each pair is two unrelated experiments **declared to share one coordinate frame** — one tissue's
image registered against the other's cells — which is exactly the failure `coordinate_space_id`'s
own docstring rejects `library_ids` for. And because `section_sample_id`'s unverified leg is
`unverified-sample:<space_id>`, every one of those collisions propagates into `section.sample_id`.

Two properties of the shipped code make it this way, and they are different defects:

1. **Every rung reads the vendor string RAW.** None passes through `vendor_statement`, this
   module's own already-shipped predicate for `_VENDOR_PLACEHOLDERS` (`""`, `n/a`, `na`,
   `unknown`, `none`, `null`, `-`), and none passes through §2's
   `non_identifying_vendor_label`. The tools that answer *"did the vendor state anything?"* and
   *"does the string identify anything?"* both already exist in the file, and the field whose
   entire job is identity is the one field that consults neither.
2. **The last rung is `Path(bundle_root).name`** — a directory the importer does not control. The
   sandbox decides it: `main()` resolves `slots["bundle"] / slots["input"] / slots["dataset"]` and
   `sandbox/spec.rs`'s `derive_artifact_mount_name` / `InputDecl::declared_mount_name` derive that
   mount name from the **SLOT**, so for an artifact-backed input it is plausibly the constant
   `bundle` for every Xenium import in a deployment. Where it *is* the user's own directory, `outs`
   is 10x Onboard Analysis' own output directory name and therefore the single most likely basename
   in existence for a Xenium upload.

So the rung the ladder falls to when nothing else answers is not merely weak, it is the rung most
likely to be SHARED — which inverts the ladder's own stated law (*"the fallbacks get more specific,
never less"*).

### §3.2 Why no single-rung patch works — the trap §2.5 already fell into

§2.5 gated the `slide_id+region_name` rung with `non_identifying_vendor_label` and **withdrew the
change**, because the audit measured what the rejected bundles fell TO: `bundle-directory-name`,
which collides with *strictly more* bundles than the rung it replaced. The gate bought a WIDER
false collision.

That is a property of the ladder, not of that patch. **Making any rung stricter moves values DOWN,
so no rung can be safely tightened until the rung underneath is unshareable.** The order of work is
therefore forced: fix the BOTTOM first, then the gating of the rungs above it is strictly
narrowing and the §2.5 change becomes not merely safe but required.

### §3.3 The rule

> **A coordinate frame identity is a value the vendor stated about THIS acquisition. Where the
> vendor stated no such value, the frame identity is derived from the run's own measured content
> and DECLARED unverified — it is never borrowed from a name the run merely happens to sit under.**

Four consequences, each of which is a change to the shipped ladder:

* **Every rung reads through the two predicates that already exist.** `vendor_statement` first
  (*did the vendor answer at all?*), then §2's `non_identifying_vendor_label` (*does the answer
  identify anything?*). This is §2's self-naming-field rule applied to the fields §2 did not
  reach — the same predicate, the same key-derived question, no second vocabulary. There is no new
  denylist and `_VENDOR_PLACEHOLDERS` is untouched.
* **`bundle-directory-name` is removed outright, and `bundle_root` is removed from the signature
  with it.** #270 already removed the bundle directory name from `section.sample_id` for exactly
  this reason — *"A field a consumer reads as the vendor's sample identity, filled from an accident
  of how the user zipped their download"* — and the argument is STRONGER for the coordinate frame,
  which is the larger claim. Deleting the rung but keeping the parameter would leave the accident
  one edit away from returning; deleting the parameter makes the mount path structurally
  unavailable to this function.
* **A frame label must be a STRING.** `vendor_statement` accepts a finite NUMBER as a statement,
  which is right for a provenance value and wrong for an identity: `_VENDOR_PLACEHOLDERS` is a
  string vocabulary and the self-naming-field rule returns False for a non-string, so a number
  passes BOTH identity predicates unexamined. A blind angle measured the first version of this
  section shipping exactly that — `roi_uuid: 0`, expressible in untrusted vendor JSON, answering
  `xenium:0` for two unrelated runs, on a rung `origin/main` had guarded with `isinstance(roi,
  str)`. The type check is restored and extended to all three keys.
* **The bottom rung is unique BY CONSTRUCTION, and unreadable as a vendor id by construction.**
  It is `xenium:unverified-space:<digest>`, where `<digest>` is over **the run's own
  measurement**: the vendor's ordered `cell_id` strings from `cell_feature_matrix.h5`'s
  `/matrix/barcodes` **and** the centroids joined to them from `cells.csv.gz` — the same array that
  becomes `spatial/coordinates.zarr`. A frame is a set of positions; this is that set, keyed by the
  vendor's own names for the things in it.

  **The ids alone were not enough**, and that correction is the one this section was made to make
  twice. The first version digested only the barcodes, and a blind design-conformance angle drove
  two genuinely different measurements — one shifted 137.5 um from the other — whose matrices
  carried generically numbered ids (`"1"`..`"23"`; nothing validates the vendor's id format) into
  ONE coordinate space and ONE `section.sample_id`. That is §3.1's own indictment — *the rung that
  applies no identity check* — reproduced at the rung meant to remove it.

  The `unverified-space:` prefix is the twin of §2's `unverified-sample:`: no vendor writes it, so
  the value cannot be mistaken for a stated frame id. **That is ENFORCED, not assumed** — a vendor
  label carrying the prefix is refused as an identity, because `experiment.xenium` is untrusted and
  a bundle stating `roi_uuid: "unverified-space:<32 hex>"` would otherwise emit a value
  byte-indistinguishable from a derived one while claiming `coordinate_space_source: "roi_uuid"`.

  **Which half of §12.3 this stands on.** §12.3 says `coordinate_space` is *a CONVENTION, not a
  recomputed digest*. The half that carries the meaning is *derive it from what the vendor wrote,
  never MINT one* — a minted id makes every import a new, unrelatable frame. Every byte of this
  preimage is the vendor's: nothing generated, nothing random, nothing that depends on the clock or
  the machine, so two imports of one bundle are one frame. What §12.3 forbids is a digest STANDING
  IN for a stated identity, and this rung is reached only where there is no stated identity to
  stand in for.

### §3.4 What is emitted

| what the vendor stated | `coordinate_space` | `coordinate_space_source` |
|---|---|---|
| an identifying `roi_uuid` | `xenium:<roi_uuid>` | `roi_uuid` |
| an identifying `slide_id` + `region_name` | `xenium:<slide>_<region>` | `slide_id+region_name` |
| the vendor WROTE something in a frame key and it names no frame — a self-naming label (`region`, `slide`, `roi`), a placeholder (`unknown`, `n/a`), a number, a value forging this module's own `unverified-space:` prefix, a shape no identity predicate can read (a mapping, a list, a bool), or a real `slide_id` with no `region_name` | `xenium:unverified-space:<digest>` | `unverified-space-non-identifying-labels` |
| the vendor wrote nothing in any frame key — absent, an explicit `null`, or an empty/whitespace string, none of which the operator has anything to replace in | `xenium:unverified-space:<digest>` | `unverified-space-no-vendor-statement` |

The two bottom rows share a VALUE and differ in SOURCE, exactly as §2.4's two fallback rows do, and
for the same reason: what a consumer needs from the value is that it does not falsely collide, and
what a human needs from the report is **which** of the two happened — because only one of them is
fixable by the operator. A run that landed on `unverified-space-non-identifying-labels` can be
given a frame identity by naming its region AND its slide (rung 2 needs both), or by
carrying a real `roi_uuid`; a run that landed on
`unverified-space-no-vendor-statement` wrote nothing, and there is nothing to rename.

**A PLACEHOLDER IS IN THE FIXABLE ROW, and the first version of this section got that backwards.**
It asked "did the value survive `vendor_statement`", which drops `_VENDOR_PLACEHOLDERS` — so
`roi_uuid: "unknown"`, the FIRST row of §3.1's measured table, was reported as *the vendor wrote
nothing*, telling the operator there was nothing to rename when a placeholder is precisely the thing
they can replace. A blind angle measured it. The split is now the recoverability question the two
tokens exist to answer: *did the vendor put anything in a frame key at all?* In both rows the
provenance block still carries whatever the vendor did write, verbatim (§2 did not change it and
neither does this).

**A digest over zero content is refused, not minted.** If the matrix carries no cell identity at
all — an empty barcode list, or barcodes that are all empty strings — the import REFUSES with a
named `XeniumImportError`. A digest of nothing is the same constant for every such run, which is
the very defect this section removes; the one place the bottom rung could still manufacture a
collision is the one place it is not allowed to answer.

### §3.5 What this costs, stated plainly

**A run whose region really is called what the rule rejects does not get a vendor-derived frame.**
A slide genuinely named `slide` carrying a region genuinely named `region` — with no `roi_uuid` —
gets `xenium:unverified-space:<digest>` and `coordinate_space_source:
"unverified-space-non-identifying-labels"`, while `provenance.slide_id` and
`provenance.region_name` still read `slide` and `region`. Two such runs are NOT declared to share a
frame even if they genuinely are two acquisitions of one region. That is a **MISSED** collision,
and it is bought deliberately on this module's own stated rule — *"a MISSED collision is visible
and recoverable while a FALSE collision is silent wrong data"*:

* **visible** — the source token says the frame identity was not taken from the vendor's labels,
  and the labels themselves are in the same report;
* **recoverable** — give the run an identity and the same two bundles share a frame again: a real
  `roi_uuid`, or `slide_id` **and** `region_name` together (rung 2 needs both, because a slide
  carries several regions and names no frame on its own — the same reason `section_sample_id`
  refuses `slide_id` as a sample id). A false collision is what nobody can undo after the fact.

**The digest is not stable across a re-analysis, and that is the honest floor rather than a
regression.** #270's DEC-7 rejected `experiment_uuid` because it changes on every re-analysis,
which would mint an unrelatable second frame for one slide — the right call for a rung that is
competing with a vendor-stated identity. This rung is not: it is only reached when the vendor
stated NO usable identity, and in that state there is nothing that could relate two re-analyses of
one slide anyway. What the shipped code does in that state is not "relate them" but "relate them
AND relate every unrelated run alongside them". Two imports of the SAME bundle still collide
correctly, because the digest is a pure function of bytes the vendor wrote; a re-segmentation that
changes the cell ids is a missed collision, in the direction this module already chose.

**The bottom rung collides if and only if two runs carry the identical ordered cell ids AND the
identical centroids** — i.e. if and only if they are the same measurement. That is the property the
digest is chosen for, and including the positions is what makes the sentence true rather than
probable (§3.3).

**THE ONE RESIDUE THIS SECTION LEAVES IS ON RUNG 2, NOT AT THE BOTTOM — #328.** `f"xenium:{slide}_{region}"`
is not an injective framing, and `_` is not a character either component is free of (the shipped
protein bundle is `Slide_1` / `hKidney_sample`). MEASURED end to end, after everything above:

```
slide_id='Slide_1_HeartBlock'  region_name='R2'            -> xenium:Slide_1_HeartBlock_R2
slide_id='Slide_1'             region_name='HeartBlock_R2' -> xenium:Slide_1_HeartBlock_R2
```

Two unrelated runs, both stating a fully identifying slide and region, one frame.

**The same ambiguity reaches ACROSS the rungs, and that half was found later.** Rungs 1 and 2 emit
into ONE undelimited namespace, so `roi_uuid: "Slide_1_R2"` and an unrelated
`slide_id: "Slide_1"` + `region_name: "R2"` — both fully identifying, both passing every predicate
— answer `xenium:Slide_1_R2` alike. `coordinate_space_source` differs between them, but the frame
binding compares the VALUE by equality, so the difference is invisible where it matters. It is the
same defect (a framing that is not injective) reached across rungs instead of within one, any
injective framing closes both, and it is recorded on **#328** rather than filed twice.

It is found here,
named here and NOT fixed here, and the reason is that this one does not fit the missed-vs-false
rule cleanly: every injective framing changes the value rung 2 emits TODAY, so a re-import of an
already-imported bundle would stop matching the artifact already in the project, and **that** missed
collision is not recoverable by the operator — the old id is baked into the emitted artifact. Trading
a contrived silent-false for a systematic unrecoverable-missed is a decision about shipped ids and
it belongs to the owner, not to #323's blast radius. Filed as **#328** with the measurement and the
trade table, and asserted by a characterization test that reddens the day the framing is fixed.

**TWO MORE RESIDUES A BLIND SECURITY ANGLE NAMED, both on the VENDOR rungs and both bounded.**
Neither is fixed here and both are stated because the alternative is that a reader infers they are
not there:

* **The vendor rung is trivially FORGEABLE, and always was.** A bundle that copies another run's
  `roi_uuid` is declared to share that run's frame even though its cells and its whole geometry
  differ — `xenium:<roi_uuid>` is a verbatim echo of attacker-controlled JSON, and frame ids are
  compared by equality. That is what "`coordinate_space` is a producer CONVENTION" means, and it is
  not fixable inside this importer: an importer cannot tell a legitimate second import of one slide
  from a copied uuid, and refusing the vendor's own acquisition id would delete the one rung that
  correctly groups two imports of one slide. It bounds what §3.3 buys, precisely: **the derived
  rung is unforgeable; the vendor rungs above it are exactly as trustworthy as the uploader.**
* **A vendor frame id is length-unbounded, and `compact_declaration` truncates a declaration string
  past 120 characters on a LISTING row** — so two 133-character frame ids differing only in their
  tails are equal in what a listing row carries. Bounded rather than open: the frame BINDING reads
  the full artifact row (`spatialFrames`), not the listing row, so this is a display/fallback
  residue rather than a mis-bind, and the derived rung is 56 characters by construction (§3.3's
  digest width is chosen partly for this).

**And the `unverified-space:` prefix is belt-and-braces, not the load-bearing disclosure.** Two
angles corrected two different overclaims about it. It is NOT "the only channel a sandboxed
consumer can see it in" — that argument belongs to `unverified-sample:`, whose block
(`section(**forbidden)`) really does refuse an extra key, whereas `coordinate_space(...)` takes
`coordinate_space_source=` and #211 made that block cross into the sandbox. And the refusal of
vendor labels carrying the prefix is a tripwire on the spellings a reader confuses, not a proof: a
zero-width space or a homoglyph still renders alike. That is accepted rather than answered with a
normalisation arms race, because the harm stops at the reader — the bytes differ, so the value
collides with nothing, and `coordinate_space_source` says which leg answered.

### §3.6 What this does to §2's INV-4, and to §2.5's three rows

`section_sample_id`'s body changes in TWO narrow ways and in no other — an earlier version of this
section said it did not change at all, and a blind angle pointed out that this is the sentence
telling a reader not to re-audit the function, which is where an INV-4 hole was still living. Both
changes apply THIS section's own rules to the twin identity field, neither touches the leg
structure, and both are recorded: a `region_name` may not forge the `unverified-sample:` prefix
(DEC-17, after a measured cross-user forgery), and a `region_name` must be a STRING (DEC-15's rule,
after two unrelated runs stating `region_name: 0` were measured declaring themselves section 0 of
sample `"0"`). Its unverified leg promises *unique per coordinate
space*, and §2.5 recorded honestly that this is *"exactly as strong as the coordinate space, and no
stronger"* — three shapes reached `run_import` and gave two unrelated bundles one
`section.sample_id`. All three had ONE cause, `coordinate_space_id`, and all three are closed here:

| shape | `coordinate_space` before | after |
|---|---|---|
| `roi_uuid='unknown'` | `xenium:unknown` (both runs) | `xenium:unverified-space:<digest>`, distinct per run |
| prime-shaped, no `roi_uuid` | `xenium:slide_region` (both runs) | `xenium:unverified-space:<digest>`, distinct per run |
| nothing stated, slot-mounted | `xenium:bundle` (both runs) | `xenium:unverified-space:<digest>`, distinct per run |

So §2's **INV-4** — *two unrelated runs must not declare themselves sections of one sample, and a
run whose sample identity is unknown must say so rather than guess* — holds on all three of the
shapes it was recorded AT-RISK for, by the value being unique per coordinate space (§2) **and** the
coordinate space being unique per run (§3); neither half is sufficient alone. That claim is worth
nothing written down, so §2.5's characterization test (TEST-17) and its end-to-end residue test
(TEST-26) are INVERTED rather than deleted: each keeps its control content and now asserts the
distinctness it used to assert the absence of.

**It is not upheld OUTRIGHT, and this section will not claim that a second time.** #328 above is a
fourth shape — two unrelated runs, both with identifying vendor labels, sharing rung 2's frame and
therefore one `section.sample_id` — and it is open. The honest statement is the narrow one: every
shape #323 measured is closed, one shape #323 FOUND is named, filed and pinned, and INV-4's fidelity
verdict on this branch is AT-RISK for exactly that reason. §2.5's mistake was claiming an invariant
one measurement wider than the code delivered; repeating it here with a smaller residue would be the
same mistake in a politer font.

### §3.7 What is deliberately NOT done here

* **`spatial-import-visium`'s equivalent is not touched.** It has the same
  `bundle-directory-name` bottom rung and its `library_id` rung reads the value raw, so a bundle
  whose matrix declares a placeholder library id has the same defect one package over. That module
  is owned by the unmerged `feat/cytassist-calibration` branch and its shared modules are vendored
  byte-identically across all three spatial packages, so it is FILED rather than edited here —
  **#327**, with the same measurements taken there (`visium:unknown`, `visium:0000000_0000000`,
  `visium:outs`, `visium:bundle`, and a `section.sample_id` that falls back to the bare space id).
* **One failure MODE changes as well as the identity rule, and it belongs in this record.** Every
  untrusted string dataset in `cell_feature_matrix.h5` — `/matrix/barcodes` and the three under
  `/matrix/features` — is decoded STRICTLY (each is an IDENTITY: a barcode is the key the cells
  table is joined on, a feature id is what a gene list is matched against, so a loose decode would
  pair one row's values with another's) and now REFUSES BY NAME, naming the dataset and the entry
  index. Before, one invalid byte left `main()` as an uncaught `UnicodeDecodeError` traceback.
  Found by the blind security angle on the barcode read; extended to the other three by the blind
  error-handling angle, whose point was that a guard on one of four reads is a guard on none.
* **`section()`'s contract is not changed.** #318 still tracks the `sample_id` / `sample_id_source`
  gap that would let the unverified disclosure live in its own key instead of inside the value.
  `UNVERIFIED_SAMPLE_PREFIX` and `unverified-space:` are both conventions that #318 retires.

---

## §4 — the frame identity is ONE rule for both importers, and its framing must be INJECTIVE (#327/#328)

§3 established the rule and shipped it in `spatial-import-xenium`. Two residues survived it, and
they are the same defect seen from two sides: **§3's rule was stated but its FRAMING was not.**

* **#327** — `spatial-import-visium` never got the rule at all. Its ladder has two rungs and
  neither is guarded: the `library_id` rung reads the vendor string RAW, so a placeholder library
  id IS the coordinate frame, and the fallback is `Path(bundle_root).name` — the sandbox MOUNT
  name, which §3.3 removed from Xenium outright.
* **#328** — Xenium's rung 2 is `f"xenium:{slide}_{region}"`, and `_` is a separator neither
  component is free of. Two unrelated runs with DIFFERENT, fully identifying vendor statements
  answer ONE frame; and rungs 1 and 2 emit into one undelimited namespace, so a `roi_uuid` can
  collide with a `slide_id`+`region_name` pair as well.

MEASURED on `4b63a482`, driving the shipped functions:

```
visium  library_id='unknown'   run-A / run-B            -> BOTH visium:unknown            (library_id)
visium  library_id='0000000_0000000' run-A / run-B      -> BOTH visium:0000000_0000000    (library_id)
visium  no library_id, /uploads/x/outs, /uploads/y/outs -> BOTH visium:outs               (bundle-directory-name)
visium  no library_id, artifact-mounted A / B           -> BOTH visium:bundle             (bundle-directory-name)
xenium  slide='Slide_1_HeartBlock' region='R2'          -> xenium:Slide_1_HeartBlock_R2   (slide_id+region_name)
xenium  slide='Slide_1' region='HeartBlock_R2'          -> xenium:Slide_1_HeartBlock_R2   (slide_id+region_name)
xenium  roi_uuid='Slide_1_R2'                           -> xenium:Slide_1_R2              (roi_uuid)
xenium  slide='Slide_1' region='R2'                     -> xenium:Slide_1_R2              (slide_id+region_name)
```

`resolveOverlayBinding` (`libs/viz/src/viz-core/spatial/coordinateBinding.ts`) compares frame ids
by **string equality** and by nothing else — *"Two artifacts share a frame IFF they declare the
SAME `coordinate_space` id"* — so none of these rows errors. Each is one tissue's image silently
registered against the other's cells.

### §4.1 The rule, restated so that it constrains the FRAMING and not only the SOURCE

> **A `coordinate_space` is `<platform>:<frame>`, where `<frame>` is drawn from exactly one of
> three DISJOINT namespaces, and the map from what the vendor stated to `<frame>` is INJECTIVE.**
>
> | namespace | reached when | shape |
> |---|---|---|
> | **stated** | the vendor identified the frame with ONE field | that field's value, verbatim |
> | **composed** | the vendor identified the frame with MORE THAN ONE field | `<source-token>:` followed by the components, each LENGTH-PREFIXED |
> | **derived** | no vendor field identifies the frame | `unverified-space:<digest>` over the run's own measurement (§3.3) |
>
> The composed and derived namespaces are **RESERVED**: a vendor value that opens with either
> token (case-folded) is refused as an identity and the run falls to the derived rung — the
> enforcement §3.3 already ships for `unverified-space:`, extended to the second token.
>
> **A ladder with more than one stated rung subdivides the stated namespace per rung.** The
> "stated" row above is written for a ladder with exactly one such rung; a ladder with two has
> two stated namespaces, and two subdivisions carrying no token are not disjoint. Each stated
> rung is therefore its own namespace: its value is verbatim *within* that namespace, and the
> namespaces are kept disjoint by a token that is part of the id. The token set must be
> prefix-free — no token is a proper prefix of another — and the property is asserted over the
> TOKEN SET itself (the namespace tokens each rung's id opens with, analogous to
> `STATED_SPACE_PREFIXES`), not over sampled `(rung, value)` rows, which would miss a later
> prefix-extending token. Prefix-freeness over the token set is what makes the map from
> `(rung, value)` to the emitted id injective, so a later rung whose token extends an existing
> one is caught when it is added (#378). This is a property of the RULE, not of any one package,
> and it is orthogonal to the
> composed namespace: composed subdivides on FIELD COUNT within one rung, this subdivides on
> RUNG COUNT across multiple stated rungs. #377 is the case that motivated it —
> `spatial-import-visium-hd`'s `library_ids` and `metrics_summary.csv` `Sample ID` rungs are
> both single-field "stated", and with no token they shared one undelimited namespace, so a run
> whose `library_ids` equalled an unrelated run's `Sample ID` answered one frame, silently.

Four properties, and each one answers a measured row above:

1. **A single stated identity is verbatim, so nothing that imports today moves.** One component
   cannot be non-injectively concatenated with anything; there is nothing to escape. This is what
   keeps `visium:Visium_Mouse_Olfactory_Bulb` and `xenium:d4c2d423-83ed-4e44-8dfd-a0072bcc3afc`
   — the ids the committed REAL bundles emit — exactly as they are.
2. **A multi-component statement is length-prefixed, so the concatenation is injective.**
   `"".join(f"{len(part)}:{part}|" for part in parts)` is a prefix-free code over code-point
   counts: decoding reads decimal digits up to the first `:`, takes exactly that many code points,
   and expects a `|`. Decoding is total and deterministic, so `encode` is injective — over
   sequences of ANY arity, which is what also separates a 1-component rung from a 2-component one.
   `slide_id="Slide_1_HeartBlock", region_name="R2"` becomes
   `xenium:slide_id+region_name:18:Slide_1_HeartBlock|2:R2|` and
   `slide_id="Slide_1", region_name="HeartBlock_R2"` becomes
   `xenium:slide_id+region_name:7:Slide_1|13:HeartBlock_R2|`. Different, as they must be.
3. **The namespaces are disjoint BY ENFORCEMENT, not by hope.** `experiment.xenium` and the h5
   root attributes are untrusted, so "no vendor writes this token" is a claim about attacker input.
   It is enforced at the vendor rung, exactly as §3.3 enforces `unverified-space:`.
4. **A ladder with more than one stated rung is still one namespace per rung.** The "stated"
   row's "verbatim" promise is per-namespace, not per-ladder: two stated rungs with no token
   between them are two subdivisions of one undelimited space, and #377 measured the result —
   `spatial-import-visium-hd`'s `library_ids` and `metrics_summary.csv` `Sample ID` answered one
   frame whenever one run's `library_ids` equalled another run's `Sample ID`. Each stated rung
   gets a token that is part of the id, the token set is prefix-free, and the property is
   asserted over the TOKEN SET itself (the namespace tokens each rung's id opens with,
   analogous to `STATED_SPACE_PREFIXES`), not over sampled `(rung, value)` rows, which would
   miss a later prefix-extending token. Prefix-freeness over the token set is what makes the
   map from `(rung, value)` to the emitted id injective, so a later rung whose token extends
   an existing one is caught when it is added (#378).

### §4.2 What is emitted, per package

`spatial-import-visium` — the whole of §3.3 applied, plus §4.1:

| what the vendor stated | `coordinate_space` | `coordinate_space_source` |
|---|---|---|
| an identifying `library_ids` | `visium:<library_id>` | `library_id` |
| the vendor WROTE something in `library_ids` that identifies nothing — a placeholder (`unknown`, `n/a`, `0000000_0000000`), a self-naming label (`library`, `library_id`), a non-string, a value forging a reserved token | `visium:unverified-space:<digest>` | `unverified-space-non-identifying-labels` |
| the vendor wrote nothing in `library_ids` | `visium:unverified-space:<digest>` | `unverified-space-no-vendor-statement` |
| the matrix carries no barcode identity at all | REFUSED by name | — |

`spatial-import-xenium` — §3.4 unchanged except the one row #328 names:

| what the vendor stated | `coordinate_space` | `coordinate_space_source` |
|---|---|---|
| an identifying `roi_uuid` | `xenium:<roi_uuid>` — **unchanged** | `roi_uuid` |
| an identifying `slide_id` + `region_name` | `xenium:slide_id+region_name:<n>:<slide>\|<m>:<region>\|` — **CHANGED** | `slide_id+region_name` |
| anything else in a frame key | `xenium:unverified-space:<digest>` — unchanged | `unverified-space-non-identifying-labels` |
| nothing in any frame key | `xenium:unverified-space:<digest>` — unchanged | `unverified-space-no-vendor-statement` |

The `<source-token>` and `coordinate_space_source` are the SAME string by construction, so the
value is self-describing and the two can never disagree.

### §4.3 The one shipped id-format change, and why it is taken

#328's own trade table is the reason this was filed rather than fixed at #323: an injective framing
moves the value rung 2 emits TODAY, so a dataset already imported through rung 2 would not share a
frame with its own re-import — a MISSED collision, systematic, and not recoverable by the operator,
traded for a FALSE collision that is contrived but silent.

It is taken, on three measurements this record now has and #328 did not:

* **No committed real bundle is on rung 2.** Both `xenium-prime-outs`
  (`roi_uuid: d4c2d423-83ed-4e44-8dfd-a0072bcc3afc`) and `xenium-protein-outs`
  (`roi_uuid: c55618d8-0e12-429a-941a-071f38da06c0`) answer on rung 1, whose value does not move.
  A Xenium bundle without a `roi_uuid` is the exception, not the rule — the key sits with
  `cassette_uuid` / `well_uuid` / `calibration_uuid` in every real `experiment.xenium` observed.
* **The missed collision is visible.** `coordinate_space_source` still reads
  `slide_id+region_name` on both sides, the provenance block still carries the verbatim labels,
  and the manifest changelog states the format move — which is what an operator needs to
  understand a re-import that no longer binds.
* **The false collision is not visible at all, and is not recoverable either.** A frame id is
  baked into the emitted artifact on BOTH sides of a false collision; a user who overlays one
  tissue's image onto another's cells gets a plausible picture and no error. §3's own rule — *"a
  MISSED collision is visible and recoverable while a FALSE collision is silent wrong data"* —
  decides it, and the recoverability half that #328 correctly said does not hold here weakens the
  argument without reversing it.

### §4.4 What a run whose frame identity is genuinely UNKNOWN is given

The question §4 exists to answer, since neither package's vendor rung is guaranteed to fire.

**A derived identity, in the reserved `unverified-space:` namespace — never a minted one, and never
a borrowed one.** Three alternatives were on the table and each is rejected for a stated reason:

* **REFUSE the import.** Safe, and it rejects bundles that import today: a Space Ranger bundle with
  no `library_ids` attribute is a legal bundle, and the whole rest of the import is well-defined.
  A producer that refuses a well-formed bundle over a field nothing downstream requires is a
  regression, not a guard.
* **An explicit "unknown frame" value that never compares equal to anything.** Safe by
  construction, and it costs the property the frame id exists for: two imports of ONE bundle would
  not share a frame either, so a second image or a second section could never be placed against an
  already-imported run. It also has no expression — `coordinate_space` is a plain string in a
  declaration block that crosses into the sandbox, and every consumer compares it with `===`
  (`resolveOverlayBinding`); a never-equal sentinel would have to be understood by each of them
  separately, which is the "every consumer must handle it" cost, paid at every consumer that has
  not been written yet.
* **A DERIVED identity — chosen.** A digest over what the vendor wrote about THIS run (§3.3's
  preimage: the ordered cell/barcode identities and the positions joined to them). Always
  available, never minted, and it collides with exactly one other thing: **another import of the
  same measurement.** Two genuinely identical re-exports therefore SHARE a frame — which is correct
  by this rule's own words (*a frame is a set of positions*), and is the property that keeps a
  re-import bindable against the artifacts already in the project. A re-analysis that re-segments
  or moves a centroid is a MISSED collision, on the error direction §3 already chose.

**And where even that is empty, the import REFUSES rather than inventing.** A matrix with no
barcode identity at all would digest to one constant shared by every such bundle — this rule's own
defect, reintroduced at the rung that removes it — so it is refused by name, in both packages.
That is the invariant in one line: **a run whose frame identity is genuinely unknown SAYS so; it
never invents one, and it never borrows one.**

### §4.5 What is deliberately NOT done here

* **`spatial-types/manifest.yaml` is not touched.** #313 owns it; §4 changes no vendored
  declaration module, so nothing there needs to move.
* **Visium's `library_id` rung is NOT given a namespace token.** It is a single component, so it
  cannot be framed non-injectively, and giving it one would move the id of every real bundle that
  imports today for no property gained. §4.1's first property is the whole reason. The §4.1
  fourth property does not reach it either, and the reason is the ladder's own shape, not the
  platform's name: a stated rung needs a token only when a ladder has MORE than one stated rung,
  and Visium has exactly one — `library_id` is its only single-field, verbatim rung, so there is
  no second stated namespace to subdivide from. Xenium is the same: its only stated rung is
  `roi_uuid`; `slide_id`+`region_name` is composed and `unverified-space:` is derived, so
  neither is a second stated namespace. The safe case is a property of the rung count — a reader
  checks their own package by counting its stated rungs, not by matching on the platform's name.

  **RESERVING the composed token is a different question from EMITTING one, and both packages do
  reserve it.** §4.1's third property is written about the SCHEME: *a vendor value that opens with
  either token is refused as an identity.* A `spatial-import-visium` that reserved only
  `unverified-space:` would accept `library_ids: "slide_id+region_name:1:a|1:b|"` and emit it
  verbatim — a STATED frame sitting inside the COMPOSED namespace, i.e. the three namespaces not
  disjoint on that side. That is a reachable state, so it is enforced rather than argued away, and
  the price is a MISSED collision for an operator who genuinely names a library with a spelling no
  Space Ranger run produces.

  It is also the "single component" premise's own condition: `library_ids` is PLURAL and
  array-shaped, so *one component* is something the code must ENFORCE (a multi-valued attribute is
  not one stated value and falls to the derived rung), not something the rung gets for free.
* **`vendor_provenance` still records the vendor's raw `library_ids`.** The predicates gate the
  IDENTITY path; the provenance block is EVIDENCE and must keep saying what the vendor actually
  wrote — the same call `spatial-import-xenium` makes for `matrix_library_id`, whose uselessness
  is exactly what is worth being able to see.
* **No `sample_id_source` key is added to Visium's report.** `section()` cannot carry one (#318),
  and the disclosure is folded into the VALUE by `unverified-sample:` — §2.4's convention, which
  #318 retires for both packages at once.

### §4.6 `0000000_0000000` joins the placeholder vocabulary, in BOTH packages

`_VENDOR_PLACEHOLDERS` is not "a vocabulary of real words" — `-` was never one. It is the
vocabulary of **the spellings a vendor uses for *no answer***, and `0000000_0000000` is one of
them, on a measurement this repo already made and already acted on: #270's DEC-7 rejected
`library_ids` as Xenium's frame identity **because both committed real bundles carry exactly that
value there**, and `test_provenance.py::test_the_visium_rule_would_collide_on_both_real_bundles`
pins the measurement. #327's own table carries the Visium consequence —
`library_id='0000000_0000000'` answering ONE frame for two unrelated runs.

It is added as **one exact-match spelling on one measurement**, not as a denylist. #320's DEC-4
refused a longer `_VENDOR_PLACEHOLDERS` as the ANSWER to the self-naming-field problem, because
that problem is unbounded (there is a generic label for every field name); it did not forbid
recording a measured null spelling, which is the whole of what this vocabulary is.

**Its limit, said out loud so nothing rests on more than it carries.** A vendor-stated identity is
only ever as unique as the vendor made it: two Visium runs a human genuinely named `Sample1` do
collide, correctly, because by the vendor's own account they are one frame. §4.1's injectivity is
injectivity in the STATEMENT, not global uniqueness — and it is `vendor_statement` /
`non_identifying_vendor_label` that keep a NON-statement out of the identity path in the first
place. This entry moves one measured spelling from the first category to the second.

### §4.7 The injectivity guard, specified (#378)

#378's own suggestion — *"a guard asserting that every `coordinate_space` a package can emit is
injective in `(rung, value)` would be package-local and cheap, and would have fired on
`spatial-import-visium-hd` the day it was created"* — is written here as a specification, so a
package that needs it can build it without re-deriving it.

**What it asserts.** For every `coordinate_space` value a package's `coordinate_space_id` can
emit, the map from `(rung, value)` to the emitted id is injective: two runs that answer on the
same rung with the same vendor statement are the same frame (correctly), and two runs that
answer on different rungs — or on the same rung with different statements — are different
frames. The tuple is `(rung, value)`: the rung's `coordinate_space_source` and the raw vendor
statement that reached it. It is not the emitted string alone, because the emitted string is
what the guard is checking the construction of.

The property is scoped to rungs that carry a VENDOR STATEMENT — the stated and composed rungs.
The derived rung is explicitly OUT OF SCOPE: its id is a function of the MEASUREMENT (the run's
own cell ids and positions, §3.3), not of a vendor statement, so "same measurement ⇒ same
frame" is correct behaviour, not a collision. A literal `(rung, value)` reading — rung =
`coordinate_space_source` — would treat the derived rung's two sources as two rungs and flag
that correct behaviour as a collision, so the scope is part of the specification, not a
footnote.

**How a package enumerates its own rungs.** A rung is one `return` site of `coordinate_space_id`
that emits a vendor-derived id, and the enumeration is the function's own ladder read as data:
each `return (f"...", source)` is one rung, named by the `coordinate_space_source` it reports. A
rung whose source is COMPUTED rather than literal — one return site, two possible sources, as in
Xenium's derived rung — is still ONE rung for injectivity purposes, grouped by the vendor-
statement class it answers for, not by the literal source string; and a derived rung that
carries no vendor statement is excluded from the guard's scope ("What it asserts" above). A
package with one stated rung, one composed rung and one derived rung enumerates three; a package
with two stated rungs enumerates two stated rungs and whatever else it carries. The guard is
written against the enumeration, so a rung added later is a row the guard sees the day it lands.

**What "prefix-free over the token set" means, concretely.** The token that separates one stated
rung from another is part of the id, and no token may be a proper prefix of another token —
otherwise a value on the shorter-token rung can open with the longer token and emit a
byte-identical id to the longer-token rung's value. The property is asserted over the TOKEN SET
itself — the namespace tokens each rung's id opens with, analogous to `STATED_SPACE_PREFIXES` —
not over sampled `(rung, value)` rows, which would miss a later prefix-extending token. The
`(rung, value)` framing is the CONSEQUENCE, not the assertion: because the token set is
prefix-free, the map from `(rung, value)` to the emitted id is injective — two different
`(rung, value)` pairs cannot produce one id. A later rung whose token extends an existing one is
therefore caught when it is added, by the same assertion that caught the original pair.

**Why it is package-local and cheap.** It reads only the package's own `coordinate_space_id`
and its own rung enumeration — no cross-package knowledge, no shared fixture, no vendored
module — and it is a handful of rows driven through the shipped function. It would have fired on
`spatial-import-visium-hd` the day that package was created, because its two stated rungs
(`library_ids`, `metrics_summary.csv`'s `Sample ID`) emitted into one undelimited namespace
(#377).

**Why it is NOT shipped in `spatial-import-xenium`.** Measured on this document's own package:
`coordinate_space_id` has exactly ONE stated rung — `roi_uuid`, emitted verbatim as
`xenium:<roi_uuid>` with `coordinate_space_source: "roi_uuid"` — and its other two rungs are
composed (`slide_id`+`region_name`, `xenium:slide_id+region_name:<n>:...|<m>:...|`) and derived
(`xenium:unverified-space:<digest>`). No other function in the package mints a `coordinate_space`
value. The guard is scoped to rungs that carry a vendor statement ("What it asserts" above), and
the failure it exists to catch is a ladder with MORE THAN ONE stated rung subdividing the stated
namespace without tokens. Xenium has exactly ONE stated rung, so there is nothing for a
stated-rung-scoped injectivity guard to discriminate — and it is not shipped. It is specified
here for the package that has two stated rungs (`spatial-import-visium-hd`, #377/#378), where
the shipped reference implementation is the four `TEST_51` tests in
`spatial-import-visium-hd/tests/test_coordinate_space.py`.
