# Runbook — republishing the analysis env image, and moving a dependency pin

Owner: whoever is changing `src-app/env-rootfs/<env>/requirements.txt` or its
`Dockerfile`. Filed under #80.

---

## 0. Read this first: what is and is not automated

**Nothing about the environment image is currently published automatically.**

`.github/workflows/env-images.yml` builds, pushes and signs the image on every recipe
change to `main`. It is presently `env-images.yml.disabled`. The reason is recorded in
commit `3f6452b8`:

> chore(ci): disable all GitHub workflows (Actions billing off, no credit)
>
> Rename every `.github/workflows/*.yml` → `*.yml.disabled` so GitHub no longer registers
> or triggers them (they otherwise only accrue failed/queued runs while tinnlab Actions
> billing is disabled). … The gates run LOCALLY (just check + pre-push hook).
> gate-wiring.test.mjs updated to read the .disabled path — the workflow WIRING is
> preserved so re-enabling is a pure rename-back, not a rebuild.

Three things follow, and they are the whole reason this document exists:

1. **The workflow is not broken.** All four workflows in the repository are disabled, for
   one billing reason. There is no failing build to fix, so "fix and re-enable" is not the
   available option — re-enabling would resume accruing failed and queued runs and publish
   nothing.
2. **Re-enabling is a one-line change, once billing is restored.**
   `git mv .github/workflows/env-images.yml.disabled .github/workflows/env-images.yml`.
   The workflow's contents are preserved intact; that was the point of the rename.
   `src-app/server/tests/sandbox/env_publish_runbook_test.rs` asserts this document and
   `scripts/publish-env-rootfs.sh` still encode the same publish sequence the workflow
   does, so the manual path cannot quietly drift away from the automated one while it is
   parked.
3. **Until then, a recipe change is invisible to every deployment until someone runs the
   manual publish below.** The runtime resolves the *moving* tag
   `schema<N>-latest-<arch>`; editing the recipe changes nothing that any running
   deployment can see. A merged pin bump that nobody publishes is a merged no-op.

### The re-enable trigger

| condition | action |
|---|---|
| tinnlab GitHub Actions billing restored | `git mv` the workflow back; the manual script becomes break-glass |
| billing still off | use §2 below for every recipe change |

---

## 1. What lives where

| thing | path | what it decides |
|---|---|---|
| the pinned direct dependency set | `src-app/env-rootfs/<env>/requirements.txt` | what is installed, at exactly which versions |
| the recipe | `src-app/env-rootfs/<env>/Dockerfile` | how the image is built, the build-time import smoke line, the baked closure lock |
| the declared default recipe | `src-app/env-rootfs/DEFAULT_ENV` | which env **the build** stages when no `TXR_ENV_ROOTFS_ID` is given. **A publish does NOT read it** — `publish-env-rootfs.sh` refuses and names the candidates unless you pass `--env` (see below) |
| the schema version | `src-app/server/src/modules/rootfs/version.rs` | the tag family the runtime resolves — **do not bump it for a package change, and NOT for a second image** |
| what each analysis requires | `src-app/packages/<pkg>/manifest.yaml` → `run.dependencies[]` | the build gate's left-hand side |
| the build gate | `src-app/server/build_helper/processor_manifest.rs` | resolves declarations against the pin set at `cargo check` time |
| the run-time check + record | `src-app/packages/_lib/txr_deps.py` | refuses a run whose environment contradicts its declaration; records what it resolved |
| the manual publish | `scripts/publish-env-rootfs.sh` | build → push → re-point the moving tag → sign |
| the automated publish (parked) | `.github/workflows/env-images.yml.disabled` | the same sequence, on CI |

---

## 2. Republishing the image

Prerequisites: `docker`, `oras` ≥ 1.2, `cosign` ≥ 2.4, and a GHCR token with
`write:packages`.

```sh
export GHCR_USER=<your github username>
export GHCR_TOKEN=<a token with write:packages>

# always dry-run first — it prints every command and the exact tags it will move
scripts/publish-env-rootfs.sh --dry-run

scripts/publish-env-rootfs.sh
```

The script prints the two tags it publishes. Only the second matters to a running
deployment:

* `schema<N>-<sha>-<arch>` — **immutable**. Provenance pins this; it is the tag you can
  point at six months from now and get the same bytes.
* `schema<N>-latest-<arch>` — **moving**. This is what `OciEnvImageProvider` resolves at
  run time. Re-pointing it is the step that makes the change take effect.

### More than one recipe now ships — `--env` is not optional

Since #191 the tree holds two recipes (`single-cell`, `single-cell-r`), and the publish
script **refuses and names the candidates** rather than guessing which moving tag to
re-point. Name the one you mean:

```sh
scripts/publish-env-rootfs.sh --env single-cell-r --dry-run
scripts/publish-env-rootfs.sh --env single-cell-r
```

Each env is its own GHCR repository (`ghcr.io/tinnlab/txresbench-env/<env>`) with its own moving
tag, so publishing one never touches the other. **Publishing the wrong one is not a
recoverable mistake** — the moving tag is what every running deployment resolves — which
is why nothing in this path defaults, and why the tree's default for a *build* is
DECLARED in `src-app/env-rootfs/DEFAULT_ENV` rather than falling out of sort order. A
declaration naming a recipe that does not exist is an error, not a fall-through.

### Signing off CI — the one place the manual path is not equivalent

On CI, `cosign sign` uses the workflow's keyless OIDC identity, and the runtime's verifier
is configured to accept exactly that identity. Run by hand, cosign signs with **yours**,
which that verifier will reject.

Options, in order of preference:

1. **Publish from a machine/identity the deployment's verification policy accepts**, and
   widen that policy deliberately and in writing.
2. **Sign with a key** the deployment trusts (`cosign sign --key`), same caveat.
3. `--skip-sign`, and **only** against a deployment with verification disabled. Never for
   an image any published result depends on — an unsigned image defeats the reason the
   verification exists.

This limitation is a property of the billing outage, not of the script. It disappears the
moment the workflow is re-enabled.

### Do not bump `ROOTFS_SCHEMA_VERSION`

For a package addition or a pin move, leave it alone. `rootfs/version.rs` records why, and
the reasoning is stronger while the workflow is disabled, not weaker: the constant selects
the tag family the runtime resolves, so bumping it re-points every deployment at a tag
that does not exist until someone publishes under it. With automated publishing off, that
window is however long it takes a human to notice. Bump it only for a genuine LAYOUT
change — a different interpreter prefix, a different mount point, a changed sandbox PATH —
and then publish *before* merging the bump.

---

## 3. Upgrading a pin

A pin move is a scientific change, not a maintenance chore: a library's defaults decide
numbers this product publishes. Work through all six steps.

1. **Edit exactly one line** in `src-app/env-rootfs/<env>/requirements.txt`. Keep the
   `# import=<module> — <why>` comment accurate.

2. **Re-resolve, and check nothing else was dragged along.** A pin move can force a
   transitive downgrade that silently changes a *different* library:

   ```sh
   docker run --rm -v "$PWD/src-app/env-rootfs/<env>":/w -w /w python:3.11-slim sh -c \
     'pip install -q uv && uv pip compile --python-version 3.11 requirements.txt -o -' \
     | grep -E '^[a-z0-9_.-]+=='
   ```

   Diff that against the previous resolution. If another *direct* pin is now
   unsatisfiable, you are making a bigger change than you think.

3. **Build the image and let the smoke line gate it.**

   ```sh
   docker build -f src-app/env-rootfs/<env>/Dockerfile \
     --build-arg ROOTFS_SCHEMA_VERSION=$(grep -E 'const ROOTFS_SCHEMA_VERSION' \
       src-app/server/src/modules/rootfs/version.rs | grep -oE '[0-9]+' | tail -1) \
     src-app/env-rootfs/<env>
   ```

   A distribution added to the pin file without a matching import on the smoke line is a
   red test — `sandbox::env_image::every_env_recipe_smoke_verifies_every_pinned_import` —
   not a silent absence. That guard runs over **every** recipe
   `rootfs::version::discover_env_recipes` finds, so a second env image is covered the day
   its directory lands. It finds each recipe's smoke line by the `# txr:env-smoke` comment
   directly above it, because no syntactic rule tells "installs" from "loads" across
   package managers; a recipe that declares no such marker fails, naming what to add.

4. **Ask the build gate who declared a range you just left.**

   ```sh
   cd src-app/server && cargo check -p txresbench
   ```

   The gate resolves every `run.dependencies[]` in the tree against the new pin set and
   fails, naming the package and the analysis, if any declaration no longer holds. This is
   the step that catches "the recipe moved out from under a shipped analysis" — do not
   skip it because the image built.

5. **Reconcile whichever side is wrong.** Either widen/move the analysis' declared range
   (if the upgrade is intended and the analysis is validated against the new version), or
   revert the pin (if it is not). Both are one-line changes; the decision is not.

6. **Republish (§2), then say so.** Until the moving tag is re-pointed, the pin change is
   inert. After it, every subsequent run records the new resolved version in its
   provenance row — which is how you can later tell which results predate the upgrade.

### Adding a new library

Same as above, plus: add the pin **with a comment naming the analysis that needs it**, add
its import to the smoke line, and declare it in that analysis' `run.dependencies[]`. The
gate is deliberately one-directional — a declared library must be installed, but an
installed library needs no declaration — so an unconsumed pin is caught by review, not by
the build. The precedent is in the recipe's own history: TileDB-SOMA was carried for a
release as "installed, smoke-tested and shipped for nobody" before being removed. If the
analysis a pin was added for is abandoned, remove the pin.

**`scvelo` is a live example.** Its resolution was verified clean (`scvelo==0.3.4`, no
downgrade to any other pin) but it is deliberately NOT installed, because the analysis
that needs it is blocked on a data gap. Adding it later is one pin line, one smoke import
and one declaration.

---

## 4. What is recorded, and what a reproducer can actually do

This is the reproducibility claim, stated exactly — including its limits.

**Recorded per run** (`provenance_run_repro`):

| column | what it identifies |
|---|---|
| `env_rootfs_sha256` | which environment IMAGE the run mounted |
| `lockfile_json` | the RESOLVED version of every library the analysis declared, the digest of the image's full 148-distribution closure lock, and the interpreter version |
| `code_sha256` | the entry script's bytes |
| `params`, `seed`, `inputs_json` | the scientific inputs |

**What that supports.** Given a run row you can say exactly which versions of the
libraries the result depends on produced it, and whether two runs shared an environment.
Combined with the immutable `schema<N>-<sha>-<arch>` tag, you can re-mount the same image
and re-execute the same code against the same inputs.

**What it does not support, stated plainly.** The pins make the *declared* stack
reproducible; they do not make an image build bit-for-bit reproducible. Wheels can be
rebuilt, the base image moves, and the transitive closure is pinned only by the baked lock
inside a given image — which is why the lock's digest is recorded per run: a closure change
is *visible* in the record of the run it affected, rather than prevented. Promoting that to
a committed, hash-pinned lockfile is the documented escalation:

* do it when an arm64 publish path exists (so a `--universal` lock has a consumer and a
  single-platform lock cannot silently break the wired-but-unpublished arm path), or
* do it as soon as a real transitive drift is observed in a recorded run's environment
  record — at that point the risk has stopped being theoretical and the maintenance cost
  is justified.

---

## 4a. The `single-cell-r` env — coordinates, budget, and what differs from the python one

Added by #191 so R analyses (`run.runtime: rscript`) have an interpreter and a bounded
Bioconductor set. Everything above applies to it; this section is only the differences.

### The two coordinates that make its pins exact

R has no PyPI, so `uv pip install -r requirements.txt` has no direct analogue. Exactness
comes from two coordinates plus an assertion. **Since #192 the coordinates are declared in
`requirements.txt`, not as build ARGs** — see §4b for why, and for what each class of
source guarantees:

| declared as | | |
|---|---|---|
| `# txr:pin-source=dated-snapshot:<url>` | CRAN | a **dated** Posit Package Manager binary snapshot (`.../__linux__/noble/<date>`). A dated snapshot is a function from name to version, and it serves Ubuntu-noble BINARIES, so the CRAN half compiles nothing. |
| `# txr:pin-source=release-channel:bioconductor-<rel>` | Bioc | a **fixed** Bioconductor RELEASE CHANNEL — **not** a snapshot, and the difference is load-bearing (see the warning below). Bioconductor has no binary channel, so its half compiles from source — which is why the recipe installs a `-dev` toolchain and then purges it. |
| — | the assertion | after installing, the recipe compares **every** installed version against `requirements.txt` and FAILS the build on a mismatch, naming the package. |

**Moving either coordinate is a pin upgrade, not a maintenance chore.** It will move
versions, the assertion will then reject them, and reconciling the pin file is the work.
That is the intended loop: the build tells you exactly what moved instead of shipping it.
There is no `--build-arg` override any more, deliberately (#192): an overridable
coordinate is an unrecorded input to a published number.

> ### ⚠ THE TWO COORDINATES ARE NOT SYMMETRIC, AND ONLY ONE OF THEM IS REPRODUCIBLE
>
> This section used to present them as a pair. They are not one.
>
> * **CRAN is a DATED SNAPSHOT.** `…/noble/2026-09-01` is a function from name to version.
>   Two builds a month apart resolve the CRAN half identically. That is INV-5's property,
>   fully delivered.
> * **Bioconductor 3.23 is a RELEASE CHANNEL.** It serves new patch versions continuously
>   and older ones leave the index. Nobody has to "move" it for it to move. So a rebuild a
>   month from now does **not** reproduce this image: it goes RED, names the package that
>   moved, and demands a pin edit — after which you have a *different* image.
>
> That is fail-loud and it is strictly better than a range, but it is **not** the
> reproducibility INV-5 states, and pretending otherwise is how a provenance claim quietly
> becomes false. There is no Bioconductor snapshot service to point at (P3M lists a
> `bioconductor` repo in its API but serves no dated or versioned index — every probed URL
> shape returns 404). If exact Bioconductor reproducibility is ever required, the options
> are a self-hosted mirror pinned by date, or committing the resolved tarball hashes
> alongside the pins — both real work, neither in this item.
>
> Note the asymmetry this creates with DEC-8, which DEFERS SPARK/SPARK-X and PANORAMIC for
> failing a reproducibility standard the shipped Bioconductor half does not itself meet.
> That tension is real and is flagged for the owner rather than resolved here.

**Case matters here and does not in the python recipe.** R package names are
case-sensitive (`Matrix`, `scDblFinder`). The build gate used to normalize PEP 503-style —
i.e. to lowercase — so two R packages differing only in case would collide into one pin,
and a declaration could match the wrong one and report green. **#192 fixed that at the
mechanism**: the recipe declares `# txr:ecosystem=r`, from which the gate takes an exact,
case-preserving name rule and applies it to BOTH sides of every comparison. A declaration
spelled `scdblfinder` against a pin `scDblFinder` is now refused, naming both spellings.
The interim guard that held the line before then
(`test_no_two_r_package_names_collide_under_the_gates_lowercasing`) is retired; two names
differing only in case are, correctly, two pins.

### The size budget is enforced by the build — and here are the numbers

`ARG ROOTFS_MAX_MB` in the packer stage. If the packed squashfs exceeds it, the build
FAILS and prints both numbers. Raising it is a decision someone records **here**, in this
section, in the same commit — not something a build does silently.

**Measured 2026-09-03** (x86_64, `rocker/r-ver:4.6.1`, CRAN snapshot `2026-09-01`,
Bioconductor 3.23; 18 direct pins, 358-package resolved closure):

| | value |
|---|---|
| untrimmed `/usr` inside the image | 2338 MB |
| `/usr/include` (C/C++ headers), REMOVED by the trim | 239 MB — 3038 headers, ~a third of the untrimmed image. `--auto-remove=false` keeps the transitive `-dev` packages the named purge pulled in (85 of them survive), so the headers outlived the purge until the trim removed the directory outright. zstd -22 compresses them ~20:1, so the PACKED artifact fell only ~12 MB while the MOUNTED rootfs shrank by 239 MB |
| **packed squashfs** (`-comp zstd -Xcompression-level 22 -b 1M`) | **680.8 MiB = 713,859,072 bytes** (was 692.9 MiB before the trim stopped shipping `/usr/include`) |
| **committed budget** (`ARG ROOTFS_MAX_MB`) | **800 MiB** — the measurement plus ~15% headroom |
| the python sibling, for scale | ~316 MB |

The R image is **2.2× the python one**. That is the honest cost of a Bioconductor set, and
it is the number the budget is set against rather than a hope.

**Cold-fetch**, measured through the same `oras` path the runtime uses, against a local
registry: `oras resolve` (the moving-tag lookup, performed on every `provide()` call)
**16-19 ms**; `oras pull` of the 714 MB artifact **1.23-1.28 s** on loopback. Loopback removes the
network, so that is a FLOOR, not a prediction. What a deployment actually waits is
bytes ÷ link, once per host per image version (the digest cache holds it thereafter):

| link | this image (714 MB) | python (~316 MB) |
|---|---|---|
| 1 Gbit/s | 5.7 s | 2.5 s |
| 200 Mbit/s | 28.6 s | 12.6 s |
| 100 Mbit/s | 57.1 s | 25.3 s |

At 100 Mbit/s the first R job on a fresh host waits about a minute. **That is what the
budget defends.** The failure mode of letting the image grow unchecked is not a build
error — it is a user waiting on a first-run fetch, which is invisible to every other gate.
The headroom is deliberately narrow: a pin upgrade that adds a few MB passes; a
Bioconductor sub-universe (hundreds of MB) fails, which is the whole point.

The enforcement is checked by mutation rather than assumed — built with `ROOTFS_MAX_MB`
below the measured size, the build exits non-zero with `BUDGET EXCEEDED: the packed rootfs
is 693 MB, over the 600 MB budget.`

### Its exclusions are part of the recipe, not an omission

`requirements.txt` names what is deliberately NOT installed and why (`zellkonverter` /
`basilisk`, `rhdf5` / `HDF5Array`, `Seurat`, SingleR/celldex, the domain-clustering set,
and the four corpus entries marked "assumed; not individually verified"). Two named
spatial packages — SPARK/SPARK-X and PANORAMIC — are DEFERRED because they exist on
neither CRAN nor the pinned Bioconductor release, so the only upstream is an unversioned
GitHub HEAD; pinning against one records the same version string for different trees,
which is worse than a range. Adding either later is a pin-file edit plus a republish.

### Verifying a locally built rootfs

```sh
docker build -t txresbench-env-r src-app/env-rootfs/single-cell-r
docker create --name txresbench-env-r-x txresbench-env-r && docker cp txresbench-env-r-x:/rootfs.squashfs .
docker rm txresbench-env-r-x
scripts/verify-r-rootfs-local.sh ./rootfs.squashfs single-cell-r
```

That script mounts the rootfs under the same bwrap shape the sandbox constructs and checks
the schema marker, that `Rscript` resolves on the sandbox PATH, that the Tier-A stack loads
after the trim, that numerics are single-threaded, and that the network is unreachable. It
REFUSES when the squashfs is absent rather than passing green.

---

## 4b. The pinning REGIME — what identity a dependency records (#192)

§3 and §4a are procedures. This section is the rule they rest on, and it applies to every
recipe, not just the R one.

### A pin's identity is (name, version) — but only if its SOURCE says so

`requirements.txt` records `<name>==<version>`. That is an identity only when the upstream
guarantees that pair denotes exactly one source tree. Every recipe therefore declares
where its pins were resolved, machine-readably, as one or more

```
# txr:pin-source=<class>:<coordinate>
```

lines, and the CLASS is what states the guarantee:

| class | `(name, version)` → one tree? | pin still fetchable later? | verdict |
|---|---|---|---|
| `immutable-index` | yes — a published release is immutable | yes | reproducible (PyPI; the `single-cell` recipe) |
| `dated-snapshot` | yes, and name→version is fixed too | yes | reproducible (P3M CRAN snapshot; the R recipe's CRAN half) |
| `release-channel` | yes | **no** — new patch versions arrive, old ones leave | **fails loud** on a rebuild: the recipe's assertion names the package that moved (Bioconductor; the R recipe's Bioc half) |
| `vcs-head` | **NO** — two builds a day apart record the same version string for different code | no | **REFUSED by the build** — see below |

Read the last two rows together, because they are the distinction §4a previously flagged
as an unresolved tension and this is its resolution. A `release-channel` pin is *honest*:
what it recorded is true of the run that recorded it, and a rebuild that cannot reproduce
it says so out loud. A `vcs-head` pin is *false*: it records an identity that does not
distinguish the code it was built from. Fail-loud and lie are different failures, and only
one of them is admissible.

### The refusal, and #209

Adding `# txr:pin-source=vcs-head:<url>` to any recipe FAILS the build — in the Rust gate
(`cargo check`) and again in the recipe's own installer, so an operator who builds the
image directly hits the same wall. The message names #209.

That is why `SPARK`/`SPARK-X` and `PANORAMIC` are absent from the R recipe: verified absent
from CRAN and from Bioconductor 3.23, their only upstream is an unversioned GitHub HEAD.
Shipping them needs a **commit pin plus a source hash**, so the recorded identity
distinguishes two trees — which is #209, and which is a recipe change rather than a change
to this regime. Nothing about the regime has to move to unblock them: a `vcs-head` source
that carries a verified content hash stops being a `vcs-head` source and becomes a new
class whose `identifies_one_tree` answer is yes.

### Upgrading a pin (R)

Everything in §3 applies. The R-specific differences:

1. **Edit exactly one line** in `src-app/env-rootfs/single-cell-r/requirements.txt`, keeping
   the `# import=<library> — <why>` comment accurate. Versions are RAW `DESCRIPTION`
   strings: `Matrix==1.7-6`, not `1.7.6`. The recipe compares raw strings.
2. **There is no re-resolve step you can run without building**, because R has no
   `uv pip compile`. The equivalent is step 3: the build resolves, and the assertion
   reports every disagreement at once.
3. **Build the image.** The recipe reads its coordinates out of the pin file, installs
   exactly the pinned set, asserts every installed version against it, and writes the
   closure lock. A pin that moved under you fails the build and names the package.
   ```sh
   docker build -f src-app/env-rootfs/single-cell-r/Dockerfile src-app/env-rootfs/single-cell-r
   ```
4. **Ask the build gate who declared a range you just left** — `cargo check -p txresbench`,
   exactly as in §3 step 4. R names are compared **case-sensitively**, so a declaration
   that differs only in case is refused with both spellings named.
5. **Reconcile, then republish (§2).**

### Adding a new library (R)

Same as §3's "Adding a new library", plus: the package must resolve on one of the declared
coordinates. If it does not, you are adding a *source*, not a *pin* — declare it as a
`txr:pin-source` line with the class that honestly describes it, and read the table above
before assuming it is admissible.

### Which versions did a run actually use?

For the python lane this is recorded inline: `_lib/txr_deps.py` is staged into the sandbox
and writes the resolved versions into the run's `run-environment` record, which the server
lifts into `provenance_run_repro.lockfile_json` (§4).

**For the R lane it is answered BY REFERENCE**, because helper staging is Python-gated
(`sandbox/processors/mod.rs`) and closing that is #194's (E6's). The chain is total, and
every link exists today:

1. the run records the content digest of the image it mounted —
   `provenance_run_repro.env_rootfs_sha256`, made run-scoped by #189;
2. pull the artifact **by that digest** — `oras pull <repo>@sha256:<env_rootfs_sha256>`.
   **Not by tag, and the difference is not pedantry:** the `<sha>` in
   `schema<N>-<sha>-<arch>` is a *git commit* (`publish-env-rootfs.sh` derives it from
   `git rev-parse HEAD`) and nothing annotates the artifact with its content digest, so
   there is no mapping from the recorded value to a tag — following that route literally
   means enumerating tags and hashing candidates. The recorded value **is** the OCI
   content digest the run mounted (`sandbox/env_image.rs` returns the resolved digest to
   the caller, which is what makes it run-scoped), so the by-digest pull is exact. The
   artifact IS the squashfs; there is no container to `docker cp` out of;
3. the image carries the full resolved closure, frozen in at build time before the trim,
   at `/usr/local/lib/R/.txresbench-env-lock.txt` — one line per package as
   `<name>==<version>  # source=<repository>`, plus `# shadowed` comments for any second
   copy R does not load;
4. read it:
   ```sh
   scripts/env-lock-of.sh <path/to/rootfs.squashfs>       # or an extracted root
   ```
   It refuses, loudly, if the image carries no lock — verifying nothing is not a pass.

The `source=` column is what makes step 4 an answer rather than a list: it says which of
the table's rows each version came from, i.e. whether a rebuild would reproduce that
version, fail loud, or was never able to promise anything. It has a third value,
`r-base` / `r-recommended`, for the packages R itself ships — those legitimately record no
`Repository` and never will, and filing them under the same word as "came from somewhere
nothing here can name" would have made the column unable to distinguish the most
trustworthy provenance in the file from the least. A package that is neither is written
`UNRECORDED-NOT-FROM-A-DECLARED-COORDINATE`, and the recipe **fails the build** if any
DIRECT pin is in that state — so an `install_github` line added to the recipe cannot
quietly become a pin with no traceable identity.

**Practical note:** step 2 extracts a ~700 MB artifact to read one text file. That is the
cost of the by-reference answer, and it is one of the reasons #194 making the record
inline is worth doing.

**This is weaker than the python lane and it is stated rather than smoothed over.** The R
record is by-reference first and inline second; #194 makes it inline. It is not weaker in
what it can *establish* — the versions are recoverable exactly — only in how many steps it
takes and in requiring the image to still be pullable.

---

## 4c. The local build + run loop — no GHCR, no token, no workflow

**E5 / #193.** This is the development route the owner's ruling names: *"we can build it
locally and change the rootfs repo for testing."* Section 2 above publishes; this
section does not, and the difference is the point.

```sh
just env-rootfs-local --all            # build + stage every recipe on this box
just env-rootfs-local --env <id>       # …or just one
just env-rootfs-local --print-seam     # the `env '...'` prefix for what is staged
```

Each run does: **discover → build → extract → verify → stage**, and stops exactly where
`publish-env-rootfs.sh` starts needing a registry. It prints the artifact's packed size,
its sha256 and the wall-clock of each leg. `scripts/build-env-rootfs-local.sh --list`
prints the derived env set; with more than one recipe and no `--env` it **refuses and
names them**, exactly as the publisher does.

### What it verifies, and what it does not

It asks three questions **of the artifact**, never of the recipe source:

1. the schema marker in the packed squashfs equals `ROOTFS_SCHEMA_VERSION`;
2. `jq` is present in the rootfs (the shared consumer check in
   `scripts/lib/env-image-verify.sh`);
3. `jq` **runs** inside the sandbox's own bwrap shape — `/usr` bound read-only, the
   fixed PATH, no network. Presence is not execution: a binary can be in the image and
   still fail to load because its libraries are not where its loader looks.

For the R env, `scripts/verify-r-rootfs-local.sh <squashfs> <env-id>` goes further
(Rscript resolves, the Tier-A stack loads post-trim, numerics are pinned to one thread,
the network is unreachable). Run it after the loop; the loop stages the file it wants.

### What binds these bytes to this env — and what does not

This is the part worth understanding before you trust a staged artifact, because the
answer is narrower than it looks.

**Nothing inside the squashfs says which env it is.** The rootfs carries a *schema*
marker, not an *env* marker, and the three checks above are deliberately env-AGNOSTIC —
`jq` was chosen precisely because it names no analysis domain, which is the same property
that makes it unable to tell one env's rootfs from another's. The
`com.txresbench.env` label the loop stamps lives on the docker **image**, and it does not
survive `docker cp`.

So two things carry the binding, and both are enforced:

1. **At build time**, `--reuse-image` accepts only an image LABELLED for the env you
   named. A mismatched label, an absent label and an unreadable label are all refusals,
   with **no override** — building is what applies the label, and on a warm layer cache
   that costs about a second.
2. **At use time**, `--print-seam` re-hashes each staged artifact and compares it to the
   sha256 the loop recorded when it built that env's recipe, refusing by name (both
   digests shown) on a mismatch. `scripts/e2e-processors-preflight.sh --seams` goes
   through that path, so a cache slot overwritten by anything — a stray `cp`, an
   interrupted stage, a tool run by hand — cannot be emitted as that env's seam.

Without (2), a substituted cache slot passed every check and was handed to the runtime,
which then served those bytes **by name** for the env the filename claimed. That was
demonstrated end to end before it was closed; it is the reason the hash check is there and
the reason it is not optional.

### Verification posture — the honest difference (INV-3)

**A locally built image is not verified, and it is not signed by anything a deployment
trusts.**

- Seam 1 (`TXR_ENV_ROOTFS_SQUASHFS…`), which this loop feeds, has **no signature in
  its path at all**. The provider content-hashes the file, stages it by digest and
  mounts it. The operator vouches for the bytes; cosign is never consulted.
- The published path is different: the runtime resolves the moving tag, then
  **cosign-verifies against the CI workflow's keyless OIDC identity**
  (`DEFAULT_IDENTITY_RE` in `src-app/server/src/modules/sandbox/env_image.rs`) before
  mounting anything. A locally built image cannot satisfy that identity, and **widening
  a deployment's `TXR_ENV_IMAGE_IDENTITY_REGEXP` to accept a developer identity is not
  the fix** — that is a release security boundary, and moving it is out of scope for a
  development loop.
- The middle path, for exercising resolve → cosign-verify → pull → cache → mount
  end to end, is the local-registry harness in
  `src-app/server/tests/sandbox/env_image_oci_test.rs`: a `registry:2` on loopback and
  a locally generated cosign keypair, reached through the `#[cfg(debug_assertions)]`
  `EnvImageSeams` — a debug-only seam that does not exist in a release build.

So: a run under the local loop is **reproducible** (its `env_rootfs_sha256` is a real
self-verifying digest of the exact mounted bytes, and its export capsule executes) but
**not attested**. Those are different properties and only the first one is claimed.

### It unblocks development, not publishing (INV-4)

#80 still gates shipping an image to a deployment, and nothing here changes that. When
someone says "the R env is available", ask which: available **to build and test locally**
(yes, since E5) or **available to a running deployment** (no — that needs a publish,
which needs the workflow or a `write:packages` token, which needs Actions billing).

### The seam variable cannot be `export`ed — use `env(1)`

The per-env air-gap seam is `TXR_ENV_ROOTFS_SQUASHFS__<env-id>`. **Every env id this
tree ships contains `-`, and `-` is not legal in a shell identifier**, so:

```sh
export TXR_ENV_ROOTFS_SQUASHFS__single-cell-r=/path   # bash: not a valid identifier
TXR_ENV_ROOTFS_SQUASHFS__single-cell-r=/path cmd      # sh: ...: not found
env 'TXR_ENV_ROOTFS_SQUASHFS__single-cell-r=/path' cmd   # works, and is inherited
```

Only the third form works — and it *is* inherited by grandchildren, so it is usable as a
command prefix for anything that spawns through a shell. `just env-rootfs-local
--print-seam` and `scripts/e2e-processors-preflight.sh --seams` both emit that form
ready to paste; neither emits an `export` line, deliberately.

### Running the tier against more than one env

```sh
# CAPTURE THE STATUS, THEN read the last line. Do NOT pipe into `tail`.
out="$(scripts/e2e-processors-preflight.sh --seams)" || {
  echo "preflight failed — not running the tier" >&2; exit 1
}
prefix="$(printf '%s\n' "$out" | tail -1)"
eval "$prefix cargo test …"
```

**Why the two lines instead of one pipe.** `cmd | tail -1` exits with *tail's* status, so
a preflight that FAILED — an env not staged, an artifact that will not mount, a rootfs
that cannot execute — yields an empty `prefix`, and `eval " cargo test …"` then runs the
whole tier with **no per-env seams at all**, silently falling back to whatever ambient
`TXR_ENV_ROOTFS_SQUASHFS` the shell happens to carry. That is exactly the substitution
this loop exists to remove, reintroduced by the way you invoke it. The same hazard is why
`scripts/check-env-loop.sh` captures every exit code directly and never reads one through
a pipe.

`--seams` runs the host checks, then mounts **every locally staged env** and executes
`jq` inside each under bwrap before emitting the prefix — a per-env capability probe
that names no analysis domain, because `jq` is the one binary every env image must
carry. It fails loudly if any staged env cannot execute, and refuses to emit an empty
prefix. The default (no-flag) invocation is unchanged, because `justfile` reads its last
line with `| tail -1` in three places.

---

## 5. Quick reference

```sh
# what is pinned right now
grep -v '^\s*#' src-app/env-rootfs/single-cell/requirements.txt | grep .

# what the shipped analyses declare
grep -rn 'library:' src-app/packages/*/manifest.yaml

# does every declaration still hold against the pins?
cd src-app/server && cargo check -p txresbench

# publish (dry run first)
scripts/publish-env-rootfs.sh --dry-run

# build + stage locally instead — no GHCR, no token (§4c)
just env-rootfs-local --all
just check-env-loop                       # the loop's own behavioural tier
```
