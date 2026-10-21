# Provenance methods narrator — repair (design)

Consolidates the repair contract for `src-app/server/src/modules/provenance/export/methods.rs`,
the generator of `methods.md` — the **out-of-app scientific trust deliverable**. Five
of six parallel analysis research spikes independently found the same defects; the
repair is filed once here rather than worked around six times.

Upstream issues (the evidence base, quoted verbatim below where it is binding):

- **#131** — *methods.md ships two KNOWN-WRONG outputs today: literal `{name}` braces
  in 5 manifests, and a false "no criteria were recorded" accusation.*
- **#77** — *methods.md cannot narrate a model / reference-asset version (closed
  param-role vocabulary, package-only Key Resources Table).*
- **#132** — *`scanpy.__version__` is deprecated — every package's `library_versions`
  recorder will silently record null for its most important library.*

Related spike findings: #123 (differential-abundance) names the same two traps as
"avoid this"; the trajectory/pseudotime and velocity spikes hit the note-drop
independently; the cell-cell-communication spike argued the reference-asset shape.

---

## §1 — What `methods.md` is for

It is the one artifact that travels OUTSIDE the application and is cited in a
publication. Its single governing rule, already stated in `methods.rs`:

> **every constraint the run applied is narrated, and a constraint that cannot be
> faithfully narrated is DISCLOSED by name.** Nothing is ever dropped — methods.md
> is the out-of-app trust deliverable, so understating a method is the worst failure
> mode this module has.

Every defect below is a violation of that rule, or a false statement about the run.

**The corollary the repair had to add: a param earns its exemption from the
undeclared-param disclosure by being NARRATED, never by being DECLARED.** Declaring a
role states an INTENT; every role's rendering is conditional on the recorded value being
renderable (a threshold list can yield no phrase, an allow-list can be empty, a cap can
be non-numeric, a commit phrase can fail to substitute). Exempting on declaration
therefore leaves a recorded param able to be absent from the narration AND absent from
the disclosure — silently dropped, which is the one thing the rule above forbids. Both
shipped `embedding` analyses were in that state for the user's chosen output name.

## §2 — Defect A: `commits` substitutes only `{label}` (#131, Defect 1)

`methods.rs`:

```rust
Some(c) => format!(", committing {}", c.replace("{label}", label.unwrap_or(""))),
```

`{label}` is the **only** token replaced. Every other brace goes to the deliverable
verbatim. Five shipped manifests (six declarations) ship a different token:

| manifest | declared `commits` |
|---|---|
| `packages/clustering/manifest.yaml` | ``one per-cell cluster-label column, labelled `{name}` `` |
| `packages/differential-expression/manifest.yaml` (×2) | ``… gene table, `{name}` `` |
| `packages/geneset/manifest.yaml` | ``… collection, `{name}` `` |
| `packages/embedding/manifest.yaml` | `a {n_pcs}-component PCA embedding over {n_hvg} highly-variable genes` |
| `packages/embedding/manifest.yaml` | `a 2-D {method} embedding` |

The issue states the two options and the resolution criterion:

> **(b) widen the substitution** to any recorded param name (`{<param>}` → that
> param's recorded value, unresolved tokens **failing the build** rather than
> printing). This is what the five manifest authors evidently expected, and it makes
> `commits` genuinely useful.

**Decision: (b).** Option (a) would delete `{n_pcs}`/`{n_hvg}`/`{method}` from the
sentence — an under-report, which §1 forbids. The build-time half is the load-bearing
half: a placeholder that cannot be substituted must fail the BUILD, because a
verbatim `{name}` in the deliverable is invisible until a human opens an exported
bundle, and "silently accept anything" reproduces exactly the failure being repaired.

**Non-negotiable (verbatim, #131 Acceptance):**

> No unsubstituted `{…}` token can reach a generated `methods.md` — enforced by a
> test over the **shipped** manifests, not by inspection.

## §3 — Defect B: a FALSE "no criteria were recorded" accusation (#131, Defect 2)

`declared_sentence` takes a no-constraints branch when the analysis declares no param
with a constraint-producing role (`predicate_list` / `threshold_list` /
`opaque_predicate` / `allow_list`). On that branch it prints:

> `NOTE: no criteria were recorded for this run, so the predicate it applied is not
> documented here.`

> For `embedding.reduce`, `embedding.visualize`, `clustering.cluster` and (per this
> spike) both trajectory analyses, **there is no predicate**. The sentence tells a
> reader the analysis hid something it never had — in the one document meant to
> travel outside the app and be trusted.

**The fix (verbatim, #131):**

> emit `note` unconditionally, and distinguish *"this analysis applies no predicate"*
> from *"this analysis applies a predicate that was not recorded"*. Those are
> different facts and only the second warrants a warning.

## §4 — Defect C: the note trap — `note` is appended ONLY on the constraint branch

Same branch, second consequence (#131, Defect 2, part 1):

> **drops `note:` entirely** — the trap #123 names. Consequence on `main` today: the
> carefully written `note:` blocks in `clustering`, `embedding` (both analyses) and
> `differential-expression` (both) are **absent from every exported `methods.md`**.
> Those notes carry the double-dipping disclosure, the "resolution is a reported
> operating parameter" disclosure, and the pseudobulk unit-of-replication disclosure.
> The honest parts are the parts being dropped.

A package that declares no constraint-producing param role therefore silently drops
its entire scientific caveat with every gate green.

**Non-negotiable (verbatim, #131 Acceptance):**

> An analysis declaring `note:` gets it narrated **regardless** of whether it declares
> a constraint-producing param role. Asserted against a real shipped manifest.

## §5 — Defect D: no way to narrate a versioned reference asset (#77)

> An analysis that ran a pretrained model can narrate *that* it ran, but not *which
> model* or *which version*. That makes the result scientifically untraceable in the
> one artefact meant to travel outside the app.

The param-role vocabulary is CLOSED (seven roles) and none means "a pinned reference
asset with identity and version". The nearest role, `opaque_predicate`, renders

> `a recorded `model` expression (not narrated here — see `manifest.json` …)`

— an **actively wrong** sentence: a pinned model is not a predicate and it *is*
narratable. The cell-cell-communication spike therefore argued against a param role.
#77's own deliverable statement:

> Either a new `MethodsParamRole` (e.g. `resource_version`) or — probably better — a
> first-class `MethodRun` field plus a richer Key-Resources-Table row than
> `<id> v<version>`, carrying `(name, version, source, digest)`.

**Decision: the first-class shape.** A declared `reference_assets:` block on the
`methods` narration, a first-class resolved `ReferenceAsset` in the narrator, prose
that names identity + version, and a Key-Resources-Table row carrying
`(name, version, source, digest)`.

#77 also notes a captured-then-dropped field:

> **The env/rootfs digest is captured but never printed.** … the Data-and-Code-
> Availability paragraph says environment digests "are shipped in this reproducibility
> bundle" without printing one.

**Non-negotiables (verbatim, #77 Acceptance):**

> A package can declare a versioned external resource in its `methods:` block and the
> exported `methods.md` **names it, with its version**, in prose and in the Key
> Resources Table.
>
> The build gate still rejects an unknown role (the closed-vocabulary property is
> preserved).
>
> An analysis that declares nothing is unchanged.

## §6 — Defect E: silent-null library versions (#132)

```python
out[mod] = getattr(m, "__version__", None)
```

> When it is removed, `getattr(..., None)` returns **`None`** — and because the
> fallback *is* `None` rather than a failure, **every one of those recorders will
> silently write `null` for scanpy**, the single most consequential library in the
> record. … This is a **provenance regression that presents as nothing at all**.

Suggested shape:

> A single helper in `src-app/packages/_lib/` … resolving in order:
> `importlib.metadata.version(dist)` → `module.__version__` → an explicit sentinel
> that is **not** `None`. Note the distribution name and the import name differ for
> some of the stack (`scikit-learn`/`sklearn`, `python-igraph`/`igraph`,
> `umap-learn`/`umap`), so the helper needs an import-name→dist-name map rather than
> a naive call.

**Non-negotiable (verbatim, #132 Acceptance):**

> A test asserts that a resolved version is never `null` for a library the run
> actually imported — the assertion that is missing today.

### SUPERSEDED — closed by #80, not by this change

This branch did build the helper above (`_lib/cyto_versions.py`). It is **not what
ships**, and the file is gone: while this branch was in review, `#80`
(*feat/analysis-dep-contract*) landed `_lib/cyto_deps.py` on `main`, which closes
Defect E and two defects this section did not identify.

| | this section's helper (#132) | what ships (`cyto_deps`, #80) |
|---|---|---|
| subject set | a tuple of module names hand-typed at each call site | the entry's `run.dependencies[]` **declaration**, the same source the build gate reads |
| unresolvable version | a loud non-`None` sentinel, run continues | a named `DependencyRefusal` — the run is **refused** |
| version vs. declaration | not compared | range-**checked** against the declared supported range |
| import-vs-dist names | an import-name→dist-name map inside the helper | moot: a declaration names the **distribution**, so there is nothing to translate |

The `#132` acceptance criterion above is still met, and met more strongly: a library
the run actually imported can no longer reach the record as `null`, because a version
that cannot be resolved now stops the run instead of being written down.

One decision this reverses is worth stating plainly, because this document argued the
other way. §6 chose to **degrade** the report rather than refuse the run (the branch's
`DEC-11`). `#80` **refuses**, deliberately and with its reasoning recorded in
`cyto_deps.py`'s module docstring: a published result that came from an environment
contradicting its own declaration is worse than no result. `#80`'s choice is the newer
one and is what stands.

## §7 — The hard coordination constraint

Three analysis packages (trajectory, doublet, differential-abundance) are being built
in parallel against the current manifest contract. Every change here is therefore
**ADDITIVE and BACKWARD-COMPATIBLE**: existing manifests keep parsing, existing
narration keeps working — only its BUGS change. Concretely:

- No field is removed or renamed on `MethodsNarration` / `MethodsSubject`.
- No `MethodsParamRole` variant is removed or renamed; the vocabulary stays CLOSED
  and `deny_unknown_fields` stays on in both places.
- `{label}` remains a RESERVED alias for the `output_label` param's value, so a
  manifest that spells `{label}` while naming its label param something else keeps
  working.
- The one new *refusal* is the placeholder lint (§2), which converts a
  silently-wrong render into a named build error. That is the intended direction of
  the repair and its message states the exact fix.

## §8 — Scientific-trust reading of the deliverable

The test of this repair is: **can a reader of `methods.md` reconstruct what actually
ran?** Params, versions, reference assets, environment, and caveats. Any path where
the document silently under-reports is a defect, including a path where a value is
declared-but-not-rendered: a param promoted out of the undeclared-param disclosure
must be genuinely narrated, or it must fall back into that disclosure.
