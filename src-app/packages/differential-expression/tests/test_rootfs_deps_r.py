#!/usr/bin/env python3
# ruff: noqa
"""The `single-cell-r` env-recipe gates (#191 / epic #169).

TEST-E3-6 [acceptance] [invariant: INV-3], TEST-E3-7 [acceptance] [invariant: INV-5],
and the static half of TEST-E3-5 [covers: ITEM-8].

## Why this is a SIBLING file and not an edit to `test_rootfs_deps.py`

`test_rootfs_deps.py` is scoped to one recipe by a module-level constant. Making that
walk EVERY discovered recipe is #196's `PROV-E8-3`, which is being built in parallel and
owns the derived env vocabulary; two branches editing the same guard is exactly the
collision the epic's contracts exist to avoid. So this file asserts the properties that
are SPECIFIC to the R recipe — the ones a generalized python-shaped guard could not
express anyway, because they are about R's package-name case and about a size budget the
python recipe does not have — and leaves the shared correspondence guard to #196.

Nothing here hardcodes a package name from the pin file: the subject set is READ FROM
the pin file, exactly as the sibling does, so an addition nobody remembered is still
checked.
"""
import re
import subprocess
from pathlib import Path

import pytest

import env_pins
import pin_file_canon

_ROOT = Path(__file__).resolve().parents[3]           # src-app/
_REPO = _ROOT.parent                                   # repo root
_ENV_ROOT = _ROOT / "env-rootfs"
_R_ENV = _ENV_ROOT / "single-cell-r"
_R_DOCKERFILE = _R_ENV / "Dockerfile"
_R_PINS = _R_ENV / "requirements.txt"
_RUNBOOK = _REPO / "docs" / "runbooks" / "env-image-republish.md"

# THE PIN-LINE GRAMMAR IS GONE FROM THIS MODULE (#214).
#
# `_PIN_RE` used to live here, with a comment saying it was "deliberately the SAME shape
# three other parsers enforce". It was not, and it could not be checked: a regex in a
# python test file and a hand-written loop in a Rust build script agree only until someone
# edits one of them, and the three whitespace notions underneath them never agreed at all.
# Ledger row 64 of #192 found the four parsers already differing and the comment claiming
# they did not.
#
# The build gate parses the file once and exports the result; this module reads that export
# through `_lib/env_pins.py`. There is no regex here any more, no `splitlines()`, and no
# `split("==")` — see `docs/design/pin-file-single-parse.md` §2.


def _pins():
    """`[(package, version, library)]` — the BUILD GATE'S OWN PARSE of the R pin file.

    THE PRECONDITION IS STILL FIRST, and it is now structural rather than remembered: the
    artefact cannot exist for a pin file the gate refused, and `env_pins.load()` refuses an
    artefact whose recorded digest does not match the pin file's current bytes. So the two
    failure modes this docstring used to warn about — a byte that shifts python's line
    boundaries relative to the gate's, and a stale derived view — are closed by
    construction rather than by this function remembering to call a checker.

    The audit that ended the previous approach put one `U+001C` in front of a real pin: the
    gate and the installer read a comment (17 pins, the package absent), this module counted
    18, and the whole suite stayed green INCLUDING the frozen floor below and the smoke
    correspondence. That cannot recur, because this module no longer has an opinion about
    where a line ends.

    Names are `raw_name` — exactly as the file spells them. For an R recipe the gate's fold
    is the identity (case-preserving), so raw and folded coincide here; using `raw_name`
    keeps that true by construction rather than by the ecosystem happening to be R.
    """
    return [
        (p["raw_name"], p["version"], p["import"])
        for p in env_pins.pins(_R_ENV.name, env_root=_ENV_ROOT)
    ]


# ─────────────────────────────── TEST-E3-7 (INV-5) ──────────────────────────────────


def test_the_r_pin_file_is_exact_pins_with_library_names():
    """TEST-E3-7 [acceptance] [invariant: INV-5] — every line is an EXACT pin.

    INV-5 in the sibling recipe's own words: "A range would not fix it (two builds a
    month apart still land on different versions inside the range); only an exact pin
    does."
    """
    pins = _pins()
    assert len(pins) >= 10, f"only {len(pins)} pin(s) — the checks below would be thin"
    names = [p[0] for p in pins]
    assert len(names) == len(set(names)), "a package is pinned twice"
    for name, version, _lib in pins:
        assert version[0].isdigit(), f"`{name}` must be pinned to a concrete version, got {version!r}"
        assert not re.search(r"[<>!~*,]", version), f"`{name}=={version}` is not a single exact pin"


@pytest.mark.parametrize("named", ["scDblFinder", "BiocParallel", "Matrix", "jsonlite"])
def test_the_minimum_pin_set_the_issue_names_is_exactly_pinned(named):
    """The packages #191 exists FOR are present and exactly pinned — a frozen CASE.

    This is the removal-catcher, and it is deliberately an enumeration rather than a
    derivation. `docs/design/derived-guards.md` §4, corrected after a mutation audit:
    *"a derivation whose two sides read the same source is a tautology in the direction
    that source changes"*. Every derived check in this file reads the pin file — so
    DELETING a pin moves both sides together and every one of them stays green. The
    epic's whole justification is that `scDblFinder` is reachable; a silent deletion of
    that line would produce an image that builds, smokes clean, and does not contain the
    one package the branch was written to deliver.

    Frozen cases are the §4-sanctioned answer, and they cost an edit only when a COVERED
    entry changes — never when a pin is added. `Matrix`/`jsonlite` are here because they
    are the substrate an R entry needs to read this app's artifacts at all; removing
    either makes every future R analysis unable to open its own inputs.
    """
    pins = {name: version for name, version, _lib in _pins()}
    assert named in pins, (
        f"`{named}` is not pinned — it is one of the packages this env exists to provide, "
        "and an image without it is an image with no consumer"
    )
    assert pins[named][0].isdigit(), f"`{named}` must be pinned to a concrete version"


def test_the_pin_count_is_frozen_so_a_removal_cannot_be_silent():
    """A floor on the pin COUNT — the direction a same-source derivation cannot see.

    `derived-guards.md` §4: a derivation whose two sides read the SAME source is a
    tautology in the direction that source changes. Several assertions in this file read
    `requirements.txt` and compare it to itself, and a DELETION moves both sides together.
    A floor does not: it rises for free when a pin is added and falls only when one is
    removed.

    HONEST SCOPE, corrected after a mutation audit: this is NOT the only catcher.
    `test_every_pin_is_named_on_the_explicit_smoke_line` also goes red on a deletion,
    because the smoke line lives in the DOCKERFILE — a genuinely independent source — and
    a deleted pin leaves a stale `library()` behind. The floor is still worth keeping (it
    catches a pin deleted from BOTH files in one edit, which that check cannot), but the
    claim that every other assertion here is blind to a removal was wrong.

    The Rust twin of this floor is aggregate across every recipe
    (`processor_manifest.rs::MIN_TOTAL_PINS`); this one is scoped to the R recipe so its
    failure message names the right file.
    """
    frozen = 18  # measured; raise freely when adding a pin, lower only via the runbook
    n = len(_pins())
    # SELF-CHECKING, like the Rust twin and unlike the first cut. A floor recorded as "the
    # measurement" decays the moment anyone adds to the measurement, and nothing enforces
    # the raise — that is exactly how `MIN_TOTAL_PINS` acquired two lines of slack and
    # stopped being able to see the single-pin removal it existed for. `>= frozen` alone
    # cannot notice; equality can.
    assert n == frozen, (
        f"{n} pin(s) in {_R_PINS.name} but the floor records {frozen}. If a pin was ADDED, "
        "raise `frozen` to the new count in the same commit — a floor below the "
        "measurement has slack, and slack is what makes a floor stop firing for the "
        "removal it exists to catch. If a pin was REMOVED, see below."
    )
    assert n >= frozen, (
        f"{n} pin(s) in {_R_PINS.name}, below the recorded floor of {frozen} — a pin was "
        "REMOVED. If that is intended, follow docs/runbooks/env-image-republish.md and "
        "lower this number in the SAME commit with the reason; do not lower it to make "
        "this test pass."
    )


def test_the_r_recipe_declares_the_case_preserving_ecosystem():
    """#192 replaces the interim collision guard with the property that MAKES it safe.

    ## What this replaces, and why replacing it is the sanctioned path

    Until #192 this file carried
    `test_no_two_r_package_names_collide_under_the_gates_lowercasing`, whose own docstring
    named its retirement condition: *"The general fix (case-preserving pin matching) is
    #192's; what makes shipping this recipe safe BEFORE that lands is that no two names in
    it collide"* and *"...or land the case-preserving pin regime (#192) first."* That has
    landed, and the old assertion's PREMISE is now gone: under a case-preserving rule two
    names differing only in case are supposed to be TWO PINS, so keeping the assertion
    would forbid a correct R recipe.

    It is REPLACED, not deleted. The guarded property — a declaration can never match the
    WRONG pin — is now asserted at the mechanism instead of at the data, which is strictly
    stronger: the old guard held only for the names that happened to be in the file.

    The behavioural proof lives where it can RUN, in the Rust gate
    (`r_pin_names_resolve_case_preservingly_and_python_pin_names_still_fold`, which drives
    `lint_declared_dependencies` over a real recipe tree and asserts `scdblfinder` does NOT
    match `scDblFinder`). What this asserts is the one thing that test cannot: that the
    SHIPPED recipe opts in.
    """
    # THE DECLARATION AS THE GATE READ IT, not as a second regex reads it (#214).
    #
    # This was `re.search(r"^\s*#*\s*txr:ecosystem\s*=\s*r\b", text, re.M)` — a THIRD
    # grammar in this one module (the pin regex, this, and the pin-source findall below),
    # each with its own idea of what starts a line. `re.M`'s `^` matches after `\n` only,
    # while `str.splitlines()` also breaks on U+001C/1D/1E and `\r`; a file could therefore
    # satisfy this search and the gate's reader disagree about which line the directive was
    # even on. Reading the gate's answer removes the question.
    assert env_pins.ecosystem(_R_ENV.name, env_root=_ENV_ROOT) == "r", (
        "the R pin file must declare `# txr:ecosystem=r`. Without it the build gate "
        "refuses the recipe outright (there is no default), and if a default were ever "
        "reintroduced this file would be read as python: PEP 440 versions and PEP 503 "
        "LOWERCASED names, so a declaration could match a differently-cased pin and "
        "report green"
    )
    text = _R_PINS.read_text()
    assert "txr:version-grammar" not in text, (
        "`txr:version-grammar` is retired (#192); the build gate refuses a pin file that "
        "still carries it. Declare `txr:ecosystem=r` instead — both the version grammar "
        "and the name rule follow from it"
    )
    # The rule is only worth having if this file exercises it. A recipe all of whose names
    # are already lowercase would pass a case-preserving gate and a lowercasing one alike.
    mixed = [name for name, _v, _l in _pins() if name != name.lower()]
    assert mixed, (
        "no pin in this file has a mixed-case name, so nothing here distinguishes a "
        "case-preserving gate from a lowercasing one"
    )


def test_the_pin_file_declares_where_its_pins_were_resolved():
    """#192 / TEST-11 — the REGIME is recorded in the file that is the source of truth.

    Two coordinates, declared machine-readably, in ONE place. Before #192 the CRAN
    snapshot and the Bioconductor release lived as `ARG` defaults in the Dockerfile while
    the pin file's header described them in prose — the same fact in two files with
    nothing holding them together, and the file whose header would go stale is the one
    whose whole job is to be the record of what the pins mean.
    """
    # THE DECLARATIONS AS THE GATE READ THEM (#214). This was the module's THIRD grammar,
    # `re.findall(r"^\s*#*\s*txr:pin-source\s*=\s*([^\s#]+)", text, re.M)` — and note its
    # `[^\s#]+` capture stops at U+001C-1F where the gate's does not, so a coordinate could
    # be TRUNCATED here and still satisfy an assertion about it. That is not hypothetical:
    # the same `[^\s#]+` shape in `spatial-import-visium` was filed as exactly that defect.
    decls = env_pins.pin_sources(_R_ENV.name, env_root=_ENV_ROOT)
    assert len(decls) == 2, (
        f"expected the two coordinates the R recipe resolves against, found {decls!r}"
    )
    classes = {d["class"] for d in decls}
    assert classes == {"dated-snapshot", "release-channel"}, (
        f"the R recipe resolves against a dated CRAN snapshot and a Bioconductor release "
        f"channel; found classes {sorted(classes)}"
    )
    # The `vcs-head` membership check that used to sit here was DEAD: the equality
    # assertion two lines up already pins the set exactly, so it ranged over a constant
    # and could never fail. It also inflated the apparent coverage of the #209 refusal,
    # which is proved where it belongs — by running the refusal, in
    # `a_pin_source_that_cannot_identify_one_tree_is_refused` (Rust) and in
    # `regime_test.R` (the recipe's own reader). Removed rather than kept as decoration.
    #
    # What replaces it is the property the equality cannot express: EVERY class this file
    # declares must be one the regime treats as identity-bearing, derived from the Rust
    # enum rather than from a list typed here.
    admissible = _rust_admissible_classes()
    assert classes <= admissible, (
        f"the R recipe declares pin-source class(es) {sorted(classes - admissible)}, which "
        "the regime does not treat as identity-bearing"
    )


def test_the_coordinates_are_written_in_exactly_one_place():
    """#192 / TEST-11 — the WIRING, so the extracted regime cannot become dead code.

    Two claims, both about the recipe DIRECTORY rather than about any one file's prose:

    1. the coordinate values appear only in `requirements.txt`. A second copy in the
       Dockerfile is a second thing to update, and the failure it produces is a header
       that lies about what built the image.
    2. the Dockerfile actually WRITES and SOURCES `txr-regime.R`. The regime functions
       are extracted into their own delimited block precisely so `tests/run-r-tests.sh`
       can execute them; if the installer stopped using that block, the tests would still
       pass while testing something the image no longer runs.
    """
    df = _R_DOCKERFILE.read_text()

    # The COORDINATES come from the gate's parse, not from a fourth regex over the same
    # text (#214). The Dockerfile is still read as text below — that is a different file
    # with a different grammar, and reducing ITS parser count is not this issue's claim.
    by_class = {
        d["class"]: d["coordinate"]
        for d in env_pins.pin_sources(_R_ENV.name, env_root=_ENV_ROOT)
    }
    assert {"dated-snapshot", "release-channel"} <= set(by_class), (
        f"the pin file must declare both coordinates; found {sorted(by_class)}"
    )
    for coord in (
        by_class["dated-snapshot"],
        by_class["release-channel"].replace("bioconductor-", ""),
    ):
        # Compare INSTRUCTION lines only: this recipe's prose legitimately discusses its
        # own coordinates, and a scan that counted comments would measure nothing. The
        # same correction `test_the_recipe_installs_from_the_pin_file_and_verifies_every_pin`
        # already had to make for the lock ordering.
        hits = [l for l in df.splitlines() if coord in l.split("#")[0]]
        assert not hits, (
            f"the coordinate {coord!r} is written in the Dockerfile as well as in the pin "
            f"file: {hits!r}. One place says what the pins were resolved against, and it "
            "is the file that is the source of truth for what is installed (#192)"
        )
    instr = [l.split("#")[0] for l in df.splitlines()]
    # INSTRUCTION lines again — the recipe's own comment explains that these ARGs used to
    # exist and why they were removed, so a raw-text scan finds the words it is looking
    # for in the paragraph saying they are gone.
    assert not [l for l in instr if "ARG CRAN_SNAPSHOT" in l or "ARG BIOC_VERSION" in l], (
        "the coordinate build-args are removed deliberately (#192): an overridable "
        "coordinate is an unrecorded input to a published number"
    )
    assert any("txr-regime.R" in l and "<<" in l for l in instr), (
        "the recipe must WRITE `/tmp/txr-regime.R` from a heredoc — that block is what "
        "`tests/run-r-tests.sh` extracts and executes"
    )
    assert any('source("/tmp/txr-regime.R")' in l for l in instr), (
        "the installer must SOURCE the regime block. Without this the tested functions "
        "are dead code sitting beside a second, untested copy"
    )
    for fn in ("txr_parse_pins(", "txr_parse_sources(", "txr_write_env_lock("):
        assert any(fn in l for l in instr), (
            f"the installer must CALL `{fn}` — a regime function nothing invokes is an "
            "unfinished feature, not a finished one"
        )


def test_the_runbook_documents_the_regime_and_the_by_reference_answer():
    """#192 / TEST-8 — the regime is written down where an operator will find it."""
    runbook = _RUNBOOK.read_text()
    assert "## 4b." in runbook, "the runbook must carry the §4b regime section"
    body = runbook.split("## 4b.", 1)[1]
    for cls in ("immutable-index", "dated-snapshot", "release-channel", "vcs-head"):
        assert cls in body, f"§4b must document the `{cls}` source class and what it guarantees"
    assert "#209" in body, "§4b must name #209 as where the unpinnable-source mechanism lives"
    for heading in ("Upgrading a pin (R)", "Adding a new library (R)"):
        assert heading in body, f"§4b is missing its `{heading}` procedure"
    assert "env_rootfs_sha256" in body and "scripts/env-lock-of.sh" in body, (
        "§4b must document the recorded-digest -> resolved-versions procedure, including "
        "the reader that performs the second half of it"
    )
    assert (_REPO / "scripts" / "env-lock-of.sh").is_file(), (
        "the runbook names `scripts/env-lock-of.sh`; a procedure whose tool does not "
        "exist is a procedure nobody can follow"
    )


def test_the_recipe_installs_from_the_pin_file_and_verifies_every_pin():
    """The pin file is the recipe's ONLY install list, and the smoke is DERIVED from it.

    The failure this forecloses is the one the sibling recipe's guard exists to catch —
    "an install the smoke line does not verify silently ships absent" — except here it is
    foreclosed by construction rather than by a correspondence check: the installer reads
    `requirements.txt`, and so does the smoke.
    """
    text = _R_DOCKERFILE.read_text()
    assert "COPY requirements.txt" in text, "the recipe must COPY its pin file"
    assert "/tmp/requirements.txt" in text
    # The installer names no package: it installs `names_wanted`, read from the pin file.
    assert "install.packages(names_wanted)" in text, (
        "the recipe must install the set READ FROM the pin file — an inline package list "
        "is not addressable by the build gate and drifts from the pins"
    )
    # The version assertion is what makes a pin a pin.
    assert "!= pinned" in text and "the installed set does not match requirements.txt" in text, (
        "the recipe must ASSERT the installed version of every pin and fail the build on a "
        "mismatch; without it the pin file is a wish"
    )
    # The lock is frozen BEFORE the trim, same ordering rule as the sibling recipe.
    #
    # COMMENTS ARE STRIPPED FIRST, and that is not tidiness. This recipe carries a prose
    # block naming `.txresbench-env-lock.txt` ~5 lines ABOVE the instruction that writes it, so
    # an unstripped scan located the COMMENT and the ordering assertion measured nothing:
    # a blind mutation moved the real freeze to after `apt-get purge` and this test stayed
    # green. `convert_soma_test.rs` already strips comments for exactly this reason.
    def _instruction_lines(t):
        return [l.split("#")[0] for l in t.splitlines()]

    lines = _instruction_lines(text)
    lock_at = next((i for i, l in enumerate(lines) if ".txresbench-env-lock.txt" in l), None)
    trim_at = next((i for i, l in enumerate(lines) if "apt-get purge" in l), None)
    assert lock_at is not None, (
        "the recipe does not freeze the resolved closure on any INSTRUCTION line (a "
        "comment mentioning the lock file is not a freeze)"
    )
    assert trim_at is not None, "the trim layer moved; re-check this ordering assertion"
    assert lock_at < trim_at, (
        f"the closure freeze (instruction line {lock_at}) must run BEFORE the trim "
        f"(line {trim_at}) — a freeze that runs after a trim can silently produce an "
        "empty file, and an empty lock records nothing while looking exactly like a lock"
    )


def test_every_pin_is_named_on_the_explicit_smoke_line():
    """The redundant explicit `library()` line stays in step with the pin file.

    That line exists for #196's cross-recipe correspondence guard (see the recipe's own
    comment); a line that silently fell behind the pin file would make that guard report
    a drift it cannot itself resolve, so it is kept honest here.
    """
    text = _R_DOCKERFILE.read_text()
    smoke = next((l for l in text.splitlines() if "explicit smoke OK" in l), None)
    assert smoke, "the recipe has no explicit build-time smoke line"
    called = set(re.findall(r"library\(([A-Za-z0-9._]+)\)", smoke))
    pinned = {lib for _name, _version, lib in _pins()}
    missing = pinned - called
    assert not missing, (
        f"pinned but absent from the explicit smoke line: {sorted(missing)} — add "
        f"`library(<name>);` for each"
    )
    # BOTH directions. Checking only pins ⊆ smoke leaves a stale `library(x)` sitting on
    # the line after `x` is dropped from the pin file — which is a name the cross-recipe
    # guard would then report as a drift nobody can resolve, and a package the smoke claims
    # to verify that the image no longer installs.
    stale = called - pinned
    assert not stale, (
        f"named on the explicit smoke line but NOT pinned: {sorted(stale)} — the line has "
        "fallen behind the pin file; remove them or pin them"
    )


def test_the_pin_file_points_at_the_upgrade_procedure():
    """The pins cannot be moved by someone who never finds the procedure."""
    assert "docs/runbooks/env-image-republish.md" in _R_PINS.read_text(), (
        "the pin file must point at the upgrade procedure"
    )
    runbook = _RUNBOOK.read_text()
    for required in ("Upgrading a pin", "Republishing the image"):
        assert required in runbook, f"the runbook is missing its `{required}` section"


# ─────────────────────────────── TEST-E3-5 (ITEM-8) ─────────────────────────────────


def test_the_packer_stage_enforces_a_size_budget():
    """TEST-E3-5's static half [covers: ITEM-8] — the budget is a BUILD FAILURE.

    The measured proof is the build itself (and the mutation run that lowers the budget
    below the measured size and observes RED). What this asserts is that the enforcement
    is still THERE: a documented number with no `exit 1` behind it is the exact shape of
    a budget nobody meets.
    """
    text = _R_DOCKERFILE.read_text()
    assert "ARG ROOTFS_MAX_MB=" in text, "the recipe declares no size budget"
    m = re.search(r"ARG ROOTFS_MAX_MB=(\d+)", text)
    assert m, "the budget must be a concrete number"
    budget = int(m.group(1))
    # A BAND, not `> 0`. `> 0` accepts 999999999, which is a budget that can never be
    # exceeded — i.e. the enforcement branch below is present and unreachable, which is
    # indistinguishable from having no budget at all. A blind mutation set exactly that
    # and this test stayed green.
    #
    # The band is anchored to the recorded measurement (680.8 MiB as built; see
    # docs/runbooks/env-image-republish.md §4a). Its LOWER edge stops the budget being
    # lowered below what the recipe actually produces — which would red the build for
    # everyone rather than catch anything — and its UPPER edge is roughly the point at
    # which a Bioconductor sub-universe has been added without anyone deciding to. Moving
    # either edge is a deliberate edit here, with the reason, alongside the runbook.
    #
    # TIGHTENED from 600..1200 after a blind round observed that BOTH edges were reachable
    # without the band noticing: 600 is BELOW what the recipe produces (so it reds the
    # build for everyone) and 1200 leaves 1.76x headroom over the measurement, which is a
    # range rather than a budget. 650..900 brackets the 681 MiB measurement with ~5%
    # below and ~32% above — enough for a pin upgrade that adds a few tens of MB, not
    # enough for a sub-universe.
    # LOWER EDGE ABOVE THE MEASUREMENT. 650 sat 31 MiB BELOW the 681 MiB the recipe
    # actually produces, so the band accepted the exact value its own comment says it
    # exists to refuse — a budget that reds the build for everyone. An audit set
    # ROOTFS_MAX_MB=650 and every test stayed green. The failure message was stale too: it
    # quoted the pre-tightening edges (600/1200) while the code enforced 650..900, so a
    # reader who tripped it was told the wrong numbers.
    measured_mib = 681
    assert measured_mib < 700 <= budget <= 900, (
        f"ROOTFS_MAX_MB={budget} is outside 700..900, the band anchored to the recorded "
        f"{measured_mib} MiB measurement. Below 700 the budget is at or under what the "
        "recipe actually produces, so it fails a correctly-built image for everyone; above "
        "900 it is a range rather than a budget. If the image genuinely changed size, "
        "re-measure, update docs/runbooks/env-image-republish.md §4a, and move this band "
        "and `measured_mib` in the same commit."
    )
    # THE `exit 1` MUST BE IN THE BUDGET BRANCH. `"exit 1" in text` ranged over the whole
    # 994-line Dockerfile, which contains 15 of them, so it was satisfied by any unrelated
    # stage: an audit deleted the `exit 1` from inside the budget branch — leaving the two
    # printfs and the comparison — and this test stayed green, i.e. the budget became
    # exactly the "prints and continues" that the message below says is not a budget.
    guard = text.split('if [ "$mb" -gt "$ROOTFS_MAX_MB" ]', 1)
    assert len(guard) == 2, "the packer stage no longer compares the measured size"
    branch = guard[1].split("fi", 1)[0]
    assert "BUDGET EXCEEDED" in branch and "exit 1" in branch, (
        "the packer stage must FAIL the build when the packed rootfs exceeds the budget — "
        "a budget that only prints is not a budget. The `exit 1` must be INSIDE the "
        f"comparison's branch; found: {branch!r}"
    )
    # The comparison must actually use the measured size, not a constant.
    assert 'if [ "$mb" -gt "$ROOTFS_MAX_MB" ]' in text


# ────────────────────────── TEST-E3-10 (ITEM-10 / ITEM-11) ──────────────────────────


def test_every_dependency_declaring_contribution_declares_the_env_it_targets():
    """TEST-E3-10 [covers: ITEM-10, ITEM-11] — the #80 gate is resolvable with two recipes.

    `lint_declared_dependencies` resolves an env-LESS `run.dependencies[]` against EVERY
    recipe on disk. That is the fail-closed reading and it is exactly right while one
    recipe exists — a contribution can be scheduled into any env, so a declaration
    satisfiable in only some of them is a latent runtime failure in the others. It is also
    why a second, DELIBERATELY NARROWER env cannot exist until each declaring contribution
    names the env it targets: otherwise every python pin would have to be installed in the
    R image, which is the unbounded image this epic exists to refuse.

    The gate's own doc-comment prescribes the fix in writing: *"If an intentionally
    narrower second env ever lands, the right relaxation is for a contribution to DECLARE
    the env it targets, not for this gate to guess."* This asserts it holds for every
    shipped contribution, including ones added tomorrow — `cargo check` would catch a
    regression too, but only as a wall of resolution errors naming a library; this names
    the actual cause.

    No env-id is spelled here: the declared value is checked against the recipe TREE.
    """
    yaml = pytest.importorskip("yaml", reason="PyYAML parses the manifests under test")
    packages = _ROOT / "packages"
    recipes = {
        d.name for d in _ENV_ROOT.iterdir() if d.is_dir() and (d / "Dockerfile").is_file()
    }
    assert len(recipes) >= 2, (
        f"expected at least two env recipes on disk, found {sorted(recipes)} — this test "
        "is about what happens when the tree is ambiguous"
    )

    declaring = 0
    for manifest in sorted(packages.glob("*/manifest.yaml")):
        doc = yaml.safe_load(manifest.read_text()) or {}
        contributes = doc.get("contributes") or {}
        for kind in ("analyses", "converters"):
            for item in contributes.get(kind) or []:
                deps = ((item.get("run") or {}).get("dependencies")) or []
                if not deps:
                    continue
                declaring += 1
                env = item.get("env")
                assert env, (
                    f"{manifest.parent.name}: {kind[:-1]} {item.get('id')!r} declares "
                    f"{len(deps)} dependency(ies) but no `env`. With more than one recipe "
                    f"on disk ({sorted(recipes)}) the #80 gate resolves it against EVERY "
                    "one of them, so its pins would have to be installed in all of them. "
                    "Declare the env this contribution targets."
                )
                assert env in recipes, (
                    f"{manifest.parent.name}: {kind[:-1]} {item.get('id')!r} declares "
                    f"`env: {env}`, which is not a recipe on disk ({sorted(recipes)})"
                )
    assert declaring >= 10, (
        f"only {declaring} contribution(s) declare `run.dependencies` — the assertion "
        "above had almost no subject; the manifest glob is probably not matching"
    )


# ─────────────────────────────── TEST-E3-6 (INV-3) ──────────────────────────────────


def _tree_digest(root: Path) -> tuple[list[str], str]:
    """`(sorted relative paths, sha256)` over every TRACKED file under `root`.

    Path and length are folded in beside the bytes, so a rename, a split of one file
    into two, and a content edit are all distinguishable — a plain concatenation of
    contents is blind to the first two.

    THE FILE LIST COMES FROM GIT; THE BYTES COME FROM THE WORKING TREE. That split is
    deliberate and it is the fix for a false RED: an `rglob` walk enumerates whatever is
    on disk, so an editor backup, a `.orig` left by a merge, a `.DS_Store` or an
    extracted build artefact dropped in the recipe directory changes the file COUNT and
    reddens a guard about SOURCE content, with every tracked file byte-identical. Reading
    the bytes from disk rather than from the index is what keeps an UNCOMMITTED edit to a
    tracked file detectable, which is the property that matters.
    """
    import hashlib

    listing = subprocess.run(
        ["git", "ls-files", "-z", "--", str(root)],
        cwd=_REPO, capture_output=True, check=True,
    ).stdout
    # `surrogateescape`, not a bare `decode()`: a tracked filename containing a byte that
    # is not valid UTF-8 is legal in git and would otherwise raise UnicodeDecodeError —
    # a crash instead of an assertion, from a file this guard has no opinion about.
    # (`-z` is what keeps `core.quotePath` from mangling a non-ASCII name in the first
    # place; the two together make the walk total.)
    rels = sorted(
        Path(x.decode("utf-8", "surrogateescape"))
        .relative_to(root.relative_to(_REPO))
        .as_posix()
        for x in listing.split(b"\0")
        if x
    )
    return rels, _digest_of((rel, (root / rel).read_bytes()) for rel in rels)


def _digest_of(pairs) -> str:
    """The PURE hash over `(relative path, bytes)` — no filesystem, no git.

    Split out so the content-sensitivity controls below can be driven with synthetic
    inputs. The first cut proved sensitivity by writing a byte into the REAL tracked
    `single-cell/Dockerfile` and restoring it in a `finally`: correct on the happy path,
    but a `Ctrl-C` or a SIGKILL leaves tracked source modified, and it is unsafe beside a
    concurrent `cargo` build or under `pytest-xdist`. A test that can dirty the tree it is
    guarding is the wrong shape regardless of how carefully it cleans up.
    """
    import hashlib

    h = hashlib.sha256()
    for rel, body in pairs:
        h.update(rel.encode("utf-8", "surrogateescape"))
        h.update(b"\0")
        h.update(str(len(body)).encode())
        h.update(b"\0")
        h.update(body)
    return h.hexdigest()


# The python env recipe's content as it stands on `main` — two files, and this digest.
# Recomputed by the helper above; see the test below for what moving it means.
#
# MOVED ONCE, and the move is the guard working rather than the guard being edited around.
# Merging `origin/main` at `5b0d0519` brought in #181, which adds `tifffile` and
# `imagecodecs` to the PYTHON recipe's pin file and its smoke line. That is main's change,
# not this branch's: `git diff origin/main HEAD -- src-app/env-rootfs/single-cell/` is
# EMPTY, so INV-3's clause ("zero bytes change in `env-rootfs/single-cell/`", meaning by
# this branch) still holds exactly. The lock records "the bytes main ships", so when main
# ships different bytes the recorded value follows main — and re-recording it is a
# one-line diff a reviewer sees, which is the whole of what this lock buys.
#
# MOVED A SECOND TIME, f63e3745 -> 1587d45a, and that one was a MERGE artefact rather than
# either branch's mistake. #191 recorded f63e3745 while #196 was independently editing the
# same recipe: #196's `cba5e076` adds the `# txr:env-smoke` marker above the smoke line and
# rewrites the comment block naming the guard that reads it (`env_image::tests::
# every_env_recipe_smoke_verifies_every_pinned_import`, which replaced a python-side test).
# Each branch was green alone; the lock went red only once BOTH were on main, because #196
# moved the bytes and #191 held the recording. Neither could have seen it from its own tree.
#
# That was the fourth instance in one session of the same merge pathology — two independently
# correct edits whose interaction git cannot flag, because the conflict is semantic and the
# text does not collide (see also: a certification counter decremented twice to the same
# value, `embedding`/`geneset` seed versions chosen identically by main and a branch, and a
# manifest bumped once for two unrelated changes). The lesson is worth the comment: the hunk
# that does NOT conflict is the one to check. Re-recorded here with the reason, which is the
# remedy the assertion below prescribes.
#
# ── MOVED A THIRD TIME AND A FOURTH, BY TWO BRANCHES AT ONCE, AND BOTH ARE REAL ──────
#
# This is the fifth instance of the pathology the paragraph above describes, and the first
# where the two edits COLLIDED textually. Both sides changed the python recipe, both for
# good reasons, and each side's resolution would have recorded a tree that has never
# existed. **The value below is RECOMPUTED ON THE MERGED TREE.**
#
# What #155 (main) changed:
#   * `requirements.txt` gains `pillow==12.3.0  # import=PIL`. The block above predicted
#     exactly this pin and named its future consumer; `spatial-import-visium`'s
#     `ome_writer.py` is it, because `tifffile` CANNOT decode a PNG and the Visium vendor
#     bundle ships one.
#   * `Dockerfile` gains `PIL` to the `# txr:env-smoke` line, which
#     `env_image::tests::every_env_recipe_smoke_verifies_every_pinned_import` requires of
#     every pin. Adding the pin without the smoke import would have gone red there.
#   * No republish is implied: `pillow-12.3.0.dist-info` is already in the shipped image,
#     so the pin FREEZES WHAT IS ALREADY THERE.
#
# What #192/#214 (this branch) changed:
#   * `requirements.txt` gains a header block declaring `# txr:ecosystem=python` and
#     `# txr:pin-source=immutable-index:…`. Every recipe must declare both, with no
#     default — a default makes a DELETED declaration indistinguishable from a python
#     recipe, which is the one direction a derivation reading this same file cannot see
#     (`docs/design/derived-guards.md` §4). "Required of every recipe" is only a floor if
#     it is required of every recipe; exempting the one that matches the old default
#     reintroduces the silent case it exists to catch.
#   * No pin line moves, no installed version changes, and the added lines are comments
#     that `uv pip install -r` ignores, so no republish is implied for this half either.
#
# Both are comment-and-pin additions to the same two files, both are load-bearing, and the
# merged recipe carries both. Recomputed after the merge — main's fix is not lost by this
# resolution, it is subsumed by a value computed once both had landed.
# ── MOVED A FIFTH TIME, BY #163, AND THIS ONE IS THE MOVE THE LOCK WAS BUILT FOR ─────
#
# The four moves above were a merge artefact, a merge collision, and two branches whose
# recipe edits were incidental to what they were doing. This one is not: #163 adds a pin
# BECAUSE the feature cannot exist without it, which is the case the "re-record it in the
# SAME commit, with the reason" instruction in the assertion below was written for.
#
# What #163 changed, both files:
#   * `requirements.txt` gains `pyarrow==25.0.0  # import=pyarrow`, named consumer
#     `spatial-import-xenium`'s `compute/boundaries.py`, which reads the Xenium
#     `cell_boundaries.parquet` this tree had no reader for. #162's DEC-3 chose
#     `cells.csv.gz` over `cells.parquet` precisely to avoid this pin, and recorded that
#     boundaries would not have that luxury. They do not.
#   * `Dockerfile` gains `pyarrow` to the `# txr:env-smoke` line, which
#     `env_image::tests::every_env_recipe_smoke_verifies_every_pinned_import` requires of
#     every pin — adding the pin without the smoke import would have gone red there.
#
# NO REPUBLISH IS IMPLIED, and that is measured rather than hoped: `pyarrow-25.0.0.dist-info`
# is ALREADY in the shipped image (`unsquashfs -l
# .txr-cache/env-rootfs/single-cell-schema5-amd64.squashfs`), arriving as a hard transitive
# of the already-pinned `spatialdata==0.7.3` (`Requires-Dist: pyarrow`, unconditional). The
# pin FREEZES WHAT ALREADY SHIPS — the same shape as #181's tifffile/imagecodecs and #155's
# pillow, and the opposite of what design §10 predicted for the Xenium leg.
#
# TEST-11 [covers: ITEM-2] of `.lifecycle/spatial-geometry`. The lock is re-recorded here,
# in the same commit as the recipe edit, and its LOAD-BEARINGNESS is re-proven rather than
# assumed: `.lifecycle/spatial-geometry/MUTATIONS.md`
# records appending one line to `requirements.txt`, observing this assertion RED, restoring,
# and observing it GREEN.
_PY_ENV_TREE_LOCK = (
    2,
    "6515540f93c04ab867f7e5214263aa596b6487c613f5508c8df7f0e05c23b4c5",
)


def test_the_python_env_recipe_content_is_locked_to_the_bytes_main_ships():
    """TEST-E3-6 [acceptance] [invariant: INV-3] — the python recipe is EXACTLY these bytes.

    INV-3's first clause is *"Zero bytes change in `env-rootfs/single-cell/`"*. This
    asserts the durable form of it: the recipe's tracked content hashes to a RECORDED
    digest, checked over the WORKING TREE so an uncommitted edit cannot slip past either.

    ## What this does NOT prove, stated because the name used to claim it

    This test was called `..._is_byte_unchanged_by_this_branch`, and a content lock cannot
    see a branch. Both sides read the same tree: a branch that DID change the python
    recipe can re-record the digest and go green. That is a real limit and it is the same
    limit `_MANIFEST_VERSION_LOCK` in `cell-filter/tests/` has — the guard's value is that
    the re-record is a one-line diff a reviewer sees, not that it is impossible.

    What it DOES prove, and what the diff form could not: an edit to the recipe that is
    NOT accompanied by a deliberate lock move goes RED (mutation-checked), and a file
    DELETED from the recipe goes RED even when the base moved with it (`derived-guards.md`
    §4). The branch-scoped phrasing is gone from the name and the message.

    ## Why this is a CONTENT LOCK and not a `git diff` against the merge base

    It was a diff, and the diff form EXPIRES AT MERGE. `merge-base(origin/main, HEAD)`
    is HEAD itself once this branch lands, so on main the diff is empty for *every*
    path: the main assertion becomes trivially true, and its positive control — "the R
    recipe DOES differ from the base" — becomes permanently false. A guard that is
    vacuous and red at the same time is worse than no guard, because the red is what
    gets deleted and the vacuum is what survives.

    A recorded digest has no base and therefore no expiry: the python recipe is EXACTLY
    these two files with exactly this content, on this branch and on main afterwards.

    Moving the lock is a deliberate edit with a reason, exactly like the pin floor above:
    if the python recipe genuinely changes, that is a republish of the python image
    (`docs/runbooks/env-image-republish.md`), and this digest moves in the same commit.

    ## The second clause is NARROWED by this branch, and saying so is the point

    INV-3 goes on: *"every existing analysis is byte-identically unaffected"*. That is no
    longer true in the WIRE sense — 12 shipped analyses gained `env: single-cell`, which
    serializes onto `GET /api/extensions`. It is a deliberate, recorded change (ITEM-11 /
    DEC-13): an env-LESS `run.dependencies[]` is resolved against EVERY recipe, so a
    second and deliberately narrower env cannot exist on disk until each declaring
    contribution names the env it targets. What is unaffected is what the invariant was
    protecting — the IMAGE those analyses run in, their resolved env-id, and their
    behaviour — and that is asserted next door in `per_job_env_test.rs`, per contribution,
    in both directions. Quoting the second clause as upheld would be false; it is
    narrowed, and the narrowing is what makes the first clause achievable at all.
    """
    py_env = _ENV_ROOT / "single-cell"
    assert py_env.is_dir(), f"the python env recipe is not at {py_env}"
    rels, got = _tree_digest(py_env)

    # ANTI-VACUITY, first: a walk that found nothing would satisfy any digest lock built
    # from the same empty walk. The recipe is two named files and both must be there.
    locked_n, locked_sha = _PY_ENV_TREE_LOCK
    for required in ("Dockerfile", "requirements.txt"):
        assert required in rels, (
            f"`{required}` is missing from {py_env} — the python recipe lost a file, which "
            "is a change to it (INV-3) and not something this lock should be edited around"
        )
    assert len(rels) == locked_n, (
        f"{py_env} holds {len(rels)} file(s) ({rels}), not the recorded {locked_n} — a file "
        "was added to or removed from the python recipe"
    )
    assert got == locked_sha, (
        f"the python env recipe's content digest is {got}, not the recorded {locked_sha}. "
        "INV-3 pins this recipe to the bytes main ships. If the python recipe genuinely "
        "moved, that is a python-image republish (docs/runbooks/env-image-republish.md) — "
        "re-record this digest in the SAME commit, with the reason."
    )

    # POSITIVE CONTROL 1 — the digest is a function OF THE TREE, not a constant. The R
    # recipe is a different tree and must not hash the same.
    #
    # The subject is asserted BEFORE the comparison, because `sha256("")` also differs
    # from `got`: pointed at a directory that does not exist, this control passed while
    # proving nothing at all.
    r_rels, r_sha = _tree_digest(_R_ENV)
    assert len(r_rels) >= 2 and "Dockerfile" in r_rels, (
        f"the control walked {_R_ENV} and found {r_rels} — with no subject, 'the two trees "
        "hash differently' is satisfied by the digest of nothing"
    )
    assert r_sha != got, (
        "the digest helper returns the same value for two different recipe trees — it is "
        "not reading content, and the lock above proves nothing"
    )

    # POSITIVE CONTROL 2 — a ONE-BYTE change goes RED. This is the mutation the assertion
    # claims to catch, performed rather than assumed: the tree is copied, one byte is
    # appended to one file, and the digest must move. Without it, "the digest matches"
    # is also what a helper that hashed the empty string would report.
    # Driven through the PURE hasher with synthetic inputs, so nothing on disk is touched:
    # rebuilding the same pairs must reproduce the digest, and each of the three ways the
    # recipe can change must move it.
    pairs = [(rel, (py_env / rel).read_bytes()) for rel in rels]
    assert _digest_of(pairs) == got, (
        "the pure hasher disagrees with the tree walk — they must be the same function"
    )
    edited = [(r, b + b"\n# mutation control\n") if r == "Dockerfile" else (r, b) for r, b in pairs]
    assert _digest_of(edited) != got, (
        "appending a byte to the recipe did NOT move the digest — the lock above cannot "
        "detect the edit it exists to detect"
    )
    deleted = [(r, b) for r, b in pairs if r != "requirements.txt"]
    assert _digest_of(deleted) != got, (
        "DELETING a file from the recipe did NOT move the digest — this is the direction "
        "a diff-against-a-moving-base is blind to (derived-guards.md §4) and the reason "
        "this lock exists at all"
    )
    renamed = [("Dockerfile.renamed" if r == "Dockerfile" else r, b) for r, b in pairs]
    assert _digest_of(renamed) != got, (
        "RENAMING a file did NOT move the digest — the path is folded in precisely so a "
        "rename is not invisible"
    )


def _rust_class_tokens() -> set[str]:
    """Every `PinSourceClass` token, read out of `token()`'s exhaustive match.

    ANCHORED ON THE IMPL BLOCK, not on the fn signature: `EnvEcosystem` has an
    identically shaped `token()` and appears first in the file, so an unanchored split
    silently measured the wrong enum and reported `{'python', 'r'}`. Caught by the
    anti-vacuity floor below on its first run, which is the whole reason it has one.
    """
    rust = (_ROOT / "server" / "build_helper" / "processor_manifest.rs").read_text()
    impl_block = rust.split("impl PinSourceClass {", 1)
    assert len(impl_block) == 2, "`impl PinSourceClass` not found — this cross-check has no subject"
    body = impl_block[1].split("pub fn token(self) -> &'static str {", 1)[1].split("}", 1)[0]
    tokens = set(re.findall(r'=>\s*"([a-z-]+)"', body))
    assert len(tokens) >= 4, (
        f"only {tokens} parsed out of PinSourceClass::token — the shape of that match "
        "changed and this cross-check is measuring nothing, which is worse than a mismatch"
    )
    return tokens


def _rust_admissible_classes() -> set[str]:
    """The classes the regime treats as identity-bearing: every token minus `vcs-head`."""
    return _rust_class_tokens() - {"vcs-head"}


def test_every_pin_source_class_is_listed_in_the_iterable_array():
    """**TEST-13** (#192, fix round 2) — the gap the Rust round-trip loop provably cannot see.

    `a_pin_source_that_cannot_identify_one_tree_is_refused` iterates
    `PIN_SOURCE_CLASSES` and checks every entry round-trips. Its own comment claimed that
    caught "a variant added to the enum but left out of the array" — but its subject set
    IS the array, so that is exactly what it cannot range over. An audit added a variant
    with a `token()` arm and left the array at 4: all 60 Rust tests stayed green.

    The gap fails OPEN, which is why it is worth a guard rather than a note:
    `identifies_one_tree()` is `!matches!(self, VcsHead)`, so an unlisted variant defaults
    to "identifies one tree" — the #209 direction. Rust has no enum iteration, so the
    check lives here, where both the enum and the array can be read.
    """
    rust = (_ROOT / "server" / "build_helper" / "processor_manifest.rs").read_text()
    decl = rust.split("pub enum PinSourceClass {", 1)
    assert len(decl) == 2, "`pub enum PinSourceClass` not found"
    variants = set(re.findall(r"^\s{4}([A-Z][A-Za-z0-9]*),", decl[1].split("\n}", 1)[0], re.M))
    assert len(variants) >= 4, (
        f"only {sorted(variants)} parsed out of the enum body — the shape changed and this "
        "check is measuring nothing"
    )
    arr = re.search(r"const PIN_SOURCE_CLASSES: \[PinSourceClass; (\d+)\] = \[(.*?)\];",
                    rust, re.S)
    assert arr, "`PIN_SOURCE_CLASSES` not found"
    listed = set(re.findall(r"PinSourceClass::([A-Za-z0-9]+)", arr.group(2)))
    assert listed == variants, (
        f"`PIN_SOURCE_CLASSES` lists {sorted(listed)} but the enum declares "
        f"{sorted(variants)}. A variant absent from the array is silently unspellable in a "
        "pin file AND defaults to identifies_one_tree() == true, which is the fail-open "
        "direction #209 is about."
    )
    assert int(arr.group(1)) == len(variants), (
        f"the array's declared length {arr.group(1)} does not match the {len(variants)} "
        "enum variants"
    )


def test_the_two_pin_source_readers_know_the_same_class_vocabulary():
    """#192 — the Rust gate and the recipe's own installer must not disagree about the
    pin-source classes, because the file says they do not.

    `processor_manifest.rs` derives its class lookup from `PIN_SOURCE_CLASSES` precisely so
    a retyped list cannot fall behind ("A retyped list is one more place to forget when
    #209 adds a class"). The recipe's `txr_parse_sources` then retypes exactly that list
    in R, where there is no enum to derive from — so the mirror is kept mechanical HERE, in
    the one place that can read both files, rather than remembered.

    Direction of failure if this is ever wrong: the class #209 adds is accepted by
    `cargo check` and refused by the image build. Fail-loud, not fail-open — which is why
    this is a guard and not a defect today.
    """
    rust_tokens = _rust_class_tokens()

    df = _R_DOCKERFILE.read_text()
    known = re.search(r'known\s*<-\s*c\(([^)]*)\)', df)
    assert known, "the recipe's `txr_parse_sources` no longer declares a `known` vector"
    r_admissible = set(re.findall(r'"([a-z-]+)"', known.group(1)))
    # The recipe refuses `vcs-head` explicitly before the `known` test, so its full
    # vocabulary is the admissible set plus that one.
    assert 'identical(cls, "vcs-head")' in df, (
        "the recipe must refuse `vcs-head` by name — that refusal is the second door on "
        "the #209 gate, for an operator who builds the image without `cargo check`"
    )
    r_tokens = r_admissible | {"vcs-head"}

    assert r_tokens == rust_tokens, (
        f"the two pin-source readers disagree: Rust knows {sorted(rust_tokens)}, the recipe "
        f"knows {sorted(r_tokens)}. Add the class to `known` in the recipe's "
        "`txr_parse_sources`, or remove it from `PinSourceClass`."
    )


def test_the_r_regime_suite_is_wired_to_something_that_runs_it():
    """#192 — a check nothing invokes is not a check.

    `run-r-tests.sh` is the ONLY executable proof of the closure-lock writer's behaviour
    and of the recipe-side `vcs-head` refusal. Its first cut was referenced by prose and by
    process artifacts and by nothing that runs — which a blind audit called the stronger
    form of the failure the script's own header argues against ("a pytest that silently
    skipped without R is how a check quietly stops being run"): being unwired does not even
    skip, it is never invoked.
    """
    # THE SUITE MUST EXIST. The justfile globs for it rather than naming this recipe
    # (`check-derived-vocabulary.sh` refuses an env id spelled in the build tier, and it
    # caught the first cut), so a glob alone would go quietly vacuous the day the script
    # is deleted. This is the anti-deletion half, and it lives here because the package
    # tree is where naming a recipe is allowed.
    suite = _R_ENV / "tests" / "run-r-tests.sh"
    assert suite.is_file(), (
        f"{suite} is missing — the justfile's glob would then run ZERO suites and still "
        "report success, which is the vacuous form of the wiring this test exists to check"
    )
    justfile = (_REPO / "justfile").read_text()
    assert "run-r-tests.sh" in justfile, (
        "`run-r-tests.sh` must be invoked by the justfile — otherwise the regime's only "
        "behavioural proof runs when somebody remembers it"
    )
    # And by the aggregate gate, not merely as a recipe somebody could call.
    check_block = justfile.split("\ncheck:", 1)[1].split("\n\n", 1)[0]
    assert "check-r-regime" in check_block, (
        "`just check` must include the R regime suite; a recipe reachable only by name is "
        "one nobody runs"
    )
    # AND THE RECIPE MUST ACTUALLY INVOKE IT. Both assertions above are satisfied by the
    # recipe MENTIONING the script — the glob pattern and the recipe's own prose both
    # contain the name. An audit deleted the `sh "$t"` line, leaving the counter and the
    # `echo "ran $n …"`, and this test stayed green: `just check` would have reported
    # running one suite having run none, which is the precise failure this test is named
    # for.
    recipe = justfile.split("\ncheck-r-regime:", 1)[1].split("\n\n", 1)[0]
    assert re.search(r"^\s*sh\s+\"\$t\"\s*$", recipe, re.M), (
        "the `check-r-regime` recipe must EXECUTE each discovered suite (`sh \"$t\"`), not "
        f"merely enumerate and count them. Recipe body:\n{recipe}"
    )


def test_all_three_readers_allow_the_same_characters():
    """**TEST-16**, restated for the ALLOWLIST (#192 round 4 → #214).

    Three implementations of one rule, in three languages that cannot share code: the Rust
    build gate (`PIN_FILE_ALLOWED_NON_ASCII`), the R installer (`txr_allowed_non_ascii`),
    and `pin_file_canon.ALLOWED_NON_ASCII`. This is the edge the Rust⇄R check next door
    does not cover — python against the other two.

    ## Why the rule inverted, and why this test got shorter

    Rounds 2-4 each WIDENED a forbidden set, and round 4 arrived at "control or whitespace,
    minus SPACE/TAB/LF" — the union of three languages' notions of a separator — because a
    `U+001C` had passed a set drawn around only Rust and R. A blind audit of #214 then
    walked through the next door: `char::is_control()` is category `Cc` only, so the whole
    `Cf` FORMAT class passed. A `U+200B` in `#<ZWSP>txr:pin-source=` makes the directive
    inert while leaving it visibly present, in the pin file AND in the artefact a human
    reviews.

    **A forbidden set fails OPEN on everything nobody thought of, and this class produced
    one new member per audit round.** So the polarity is inverted: printable ASCII, SPACE,
    TAB, LF, and a named handful of decorative characters — everything else refused BY
    DEFAULT. The comparison below is four characters instead of eighty-one, and a character
    Unicode adds tomorrow is refused by all three without any of them being edited.
    """
    ours = pin_file_canon.ALLOWED_NON_ASCII

    df = _R_DOCKERFILE.read_text()
    # EXACTLY ONCE — the same check the Rust twin has. Both extractors take the FIRST
    # match, so a shadowing `txr_allowed_non_ascii <- c(txr_allowed_non_ascii, 0x2000)`
    # widens what the installer accepts while every cross-check stays green. The Rust side
    # got this check in round 3 and this one did not, which is itself the
    # two-implementations divergence; a blind audit measured it.
    assert df.count("txr_allowed_non_ascii <- c(") == 1, (
        "the recipe assigns `txr_allowed_non_ascii` more than once. This extractor and its "
        "Rust twin both read only the FIRST, so a later assignment widens what the installer "
        "allows with every cross-check green."
    )
    m = re.search(r"txr_allowed_non_ascii <- c\((.*?)\)", df, re.S)
    assert m, "the recipe no longer enumerates the non-ASCII characters it allows"
    # EVERY token must parse, not just the ones that look like `0x…` — a `filter`-shaped
    # extractor drops what it cannot read, and the comparison then passes while R honours a
    # codepoint the gate refuses. The Rust twin carries the same check.
    r_tokens = [tok.strip() for tok in m.group(1).split(",") if tok.strip()]
    r_side = set()
    for tok in r_tokens:
        assert re.fullmatch(r"0x[0-9a-fA-F]+", tok), (
            f"the recipe's `txr_allowed_non_ascii` contains {tok!r}, which this extractor "
            "cannot read as `0x<hex>`. It would have been DROPPED and this comparison would "
            "pass while R allowed a character the gate does not."
        )
        r_side.add(chr(int(tok, 16)))
    assert len(r_side) == len(r_tokens), "the recipe's vector has a duplicate entry"
    assert r_side, "extracted NOTHING from the recipe's vector — the comparison would be vacuous"

    rust = (_ROOT / "server" / "build_helper" / "processor_manifest.rs").read_text()
    m2 = re.search(r"PIN_FILE_ALLOWED_NON_ASCII: \[char; \d+\] = \[(.*?)\];", rust, re.S)
    assert m2, "the build gate no longer declares PIN_FILE_ALLOWED_NON_ASCII"
    rust_side = {chr(int(h, 16)) for h in re.findall(r"\\u\{([0-9a-fA-F]+)\}", m2.group(1))}
    assert rust_side, "extracted NOTHING from the gate's array"

    assert ours == r_side == rust_side, (
        "the three readers' allowlists disagree.\n"
        f"  python: {sorted(hex(ord(c)) for c in ours)}\n"
        f"  R:      {sorted(hex(ord(c)) for c in r_side)}\n"
        f"  Rust:   {sorted(hex(ord(c)) for c in rust_side)}\n"
        "All three must allow exactly the same characters, or a character one permits is "
        "refused by another and the build fails in only one of them."
    )

    # The classes each round had to learn, named, because an allowlist's whole claim is
    # that it refuses them WITHOUT having been told about them.
    for label, ch in [
        ("NBSP (round 2)", "\u00a0"),
        ("CR (round 3)", "\r"),
        ("VT (round 3)", "\u000b"),
        ("U+001C — a `str.splitlines()` terminator (round 4)", "\u001c"),
        ("U+001D", "\u001d"),
        ("U+001E", "\u001e"),
        ("ZWSP — the Cf class #214's audit found", "\u200b"),
        ("BOM", "\ufeff"),
        ("SOFT HYPHEN", "\u00ad"),
        ("RTL OVERRIDE (Trojan Source)", "\u202e"),
        ("a Cyrillic homoglyph of `a`", "\u0430"),
    ]:
        assert not pin_file_canon.is_allowed(ch), f"{label} must be refused"
        assert ord(ch) not in {ord(c) for c in ours}, f"{label} must not be allowlisted"

    # CONTROL — what the shipped files actually contain is ALLOWED, so the rule is not
    # merely "refuse everything".
    for ch in "aZ0-_.=#§—→─ \t\n":
        assert pin_file_canon.is_allowed(ch), f"{ch!r} must be permitted"


def test_a_non_canonical_pin_file_is_refused_by_the_python_guards(tmp_path):
    """**TEST-17** (#192, fix round 4) — the guards refuse rather than silently re-tune.

    The demonstrated exploit: a `U+001C` before a real pin makes the Rust gate and the R
    installer read the line as a COMMENT — the package is not installed — while
    `str.splitlines()` treats it as a line break, so the python floors counted a pin that
    the image would not contain. A pin removal made invisible to the guards that exist to
    catch removals.
    """
    good = _R_PINS.read_bytes()
    poisoned = tmp_path / "requirements.txt"
    poisoned.write_bytes(good.replace(b"\nscDblFinder==", b"\n\x1cscDblFinder==", 1))
    with pytest.raises(AssertionError, match="U\\+001C"):
        pin_file_canon.assert_canonical(poisoned)

    # CONTROL: the unmodified shipped file passes, so the case above fails for the byte.
    pin_file_canon.assert_canonical(_R_PINS)


# ─────────────────────────────── #214 ───────────────────────────────────────────────


def test_all_three_of_this_modules_grammars_read_the_exported_parse(monkeypatch):
    """TEST-P12 — this module had THREE grammars over the pin file and has none.

    The pin regex `_PIN_RE`, the `txr:ecosystem` `re.M` search and the `txr:pin-source`
    `re.M` findall were three independent opinions about where a line starts, in one file,
    all reading the same bytes as the build gate and none of them checked against it.

    Each is probed separately with a sentinel the pin file does not contain: a consumer of
    the exported parse returns the sentinel, a residual parser returns what is on disk.
    """
    # (a) the PIN grammar
    sentinel = [
        {
            "name": "SentinelPkg",
            "raw_name": "SentinelPkg",
            "version": "9.9.9",
            "import": "SentinelPkg",
            "line": 1,
        }
    ]
    monkeypatch.setattr(env_pins, "pins", lambda *a, **k: sentinel)
    assert _pins() == [("SentinelPkg", "9.9.9", "SentinelPkg")], (
        "`_pins()` did not follow the exported parse — `_PIN_RE` or an equivalent read "
        "survives in this module"
    )
    monkeypatch.undo()

    # (b) the ECOSYSTEM directive grammar — driven through THE TEST THAT CONSUMES IT.
    #
    # The first cut patched `env_pins.ecosystem` and then asserted on
    # `env_pins.ecosystem(...)` — a test that `monkeypatch.setattr` works, with both sides
    # deriving from the same lambda. A blind audit caught it: restore the deleted
    # `re.search(..., re.M)` in the consumer and that version stayed green. The probe has to
    # call the consumer, or it proves nothing about the consumer.
    monkeypatch.setattr(env_pins, "ecosystem", lambda *a, **k: "sentinel-ecosystem")
    with pytest.raises(AssertionError, match="txr:ecosystem=r"):
        test_the_r_recipe_declares_the_case_preserving_ecosystem()
    monkeypatch.undo()

    # (c) the PIN-SOURCE directive grammar — likewise through its real consumer.
    sentinel_src = [{"class": "sentinel-class", "coordinate": "sentinel://x", "line": 1}]
    monkeypatch.setattr(env_pins, "pin_sources", lambda *a, **k: sentinel_src)
    # `match=` like leg (b): without it this accepts ANY AssertionError, including one from
    # an unrelated assertion later in the same consumer, and the probe would pass for a
    # reason that has nothing to do with the grammar it is probing.
    with pytest.raises(AssertionError, match="expected the two coordinates"):
        test_the_pin_file_declares_where_its_pins_were_resolved()
    monkeypatch.undo()

    # CONTROL — unpatched, all three consumers PASS and the pin set is the real one.
    # Without this the three raises above could all come from the consumers being broken.
    assert len(_pins()) == 18, "the R recipe's real pin set must come back unpatched"
    test_the_r_recipe_declares_the_case_preserving_ecosystem()
    test_the_pin_file_declares_where_its_pins_were_resolved()


def test_the_frozen_anchors_survived_the_conversion_as_literals():
    """TEST-P13 [covers INV-5] — the floors are still LITERALS, not derived values.

    This is the trap #214 newly creates. A derived pin count is now one `json.load` away
    from every floor that exists to catch a REMOVAL, and a floor compared against a count
    the artefact supplies would be a derivation whose two sides read the same source — a
    tautology in exactly the direction it exists for (`docs/design/derived-guards.md` §4).

    Three defences, and this asserts all three:
      1. the artefact carries NO total/count at any depth, so the value is not on offer;
      2. this module's floor is an integer LITERAL — checked over the AST, because the
         first cut grepped for the string `frozen = 18` and a blind audit pointed out that
         converting the assignment to `len(env_pins.pins(...))` while leaving the phrase in
         the adjacent comment would keep it green. That is `derived-guards.md` §1's own
         lesson (a text predicate defeated by prose containing its token), reproduced;
      3. the named minimum pin set is still an enumerated CASE TABLE, likewise over the AST.
    """
    import ast
    import json

    # 1 — no cardinality ANYWHERE in the artefact, at any depth. Read through the reader,
    #     so a stale or wrong-schema artefact is a refusal rather than a silent pass.
    data = env_pins.load(_ENV_ROOT)

    def walk_keys(node):
        if isinstance(node, dict):
            for k, v in node.items():
                yield k
                yield from walk_keys(v)
        elif isinstance(node, list):
            for v in node:
                yield from walk_keys(v)

    # THE SAME LIST THE RUST TWIN USES. A blind audit found python lacked `num_`, so
    # injecting a `num_pins` key reddened one implementation and not the other — the
    # two-implementations-of-one-check divergence this whole issue is about, inside the pair
    # of tests that assert it does not happen.
    BANNED_KEYS = ("total", "count", "n_pins", "cardinality", "num_")
    seen_any = False
    for key in walk_keys(data):
        seen_any = True
        for banned in BANNED_KEYS:
            assert banned not in key.lower(), (
                f"the exported parse carries the key {key!r}. A cardinality here moves with "
                "the pin file, so any floor compared against it is blind to a deletion — "
                "the ONE direction those floors exist for. Compute `len(pins)` in the "
                "consumer and compare against a literal it holds."
            )
    assert seen_any, "the key walk saw no keys — it is not seeing the artefact"
    # POSITIVE CONTROL: the predicate can fire. Without it, "no banned key" is equally
    # consistent with a broken walk — and it is what would have surfaced the missing `num_`.
    # EVERY example, not ANY: an `any` over the cross-product is satisfied by one surviving
    # pair, so deleting `num_` from BANNED_KEYS left it green — and `num_` is exactly the
    # divergence this control was added to surface. Demonstrated by a blind audit.
    for example in ("pin_total", "num_pins", "n_pins", "cardinality", "total_pins"):
        assert any(b in example for b in BANNED_KEYS), (
            f"the banned-key list does not match {example!r}, one of the spellings its own "
            "comment names. The Rust twin's list is the reference; a divergence here is the "
            "two-implementations-of-one-check failure this pair of tests exists to prevent."
        )

    # 2 + 3 — over the AST of this module, and bound to the COMPARISON rather than to the
    # mere existence of a literal.
    #
    # A blind audit defeated the existence-only version three ways, each of which kept it
    # green: shadowing `frozen = 18` with a derived `frozen = len(env_pins.pins(...))` on
    # the next line; shrinking the four-name case table to one name; and adding a DECOY
    # `parametrize` of four literals on a trivial test while deriving the real one. Checking
    # that an anchor exists is not checking that the guard uses it.
    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))

    # (2) EXACTLY ONE assignment to `frozen`, it is the integer literal 18, and the floor
    #     COMPARES against that name. A shadowing second assignment is now a hard failure.
    # SCOPED TO ONE FUNCTION, and that function must be the floor's own.
    #
    # The first cut walked the whole module for a `frozen` assignment and, separately, the
    # whole module for a comparison of `n` against `frozen`. A blind audit put the literal in
    # a DEAD HELPER, derived the real floor from `len(_pins())`, and both halves stayed green
    # — the exact move INV-5 forbids, certified by the test that exists to forbid it.
    FLOOR_FN = "test_the_pin_count_is_frozen_so_a_removal_cannot_be_silent"
    # EXACTLY ONE DEFINITION, not `next(...)`.
    #
    # `next()` takes the FIRST match in the AST; Python takes the LAST runtime binding. A
    # blind audit appended a second `def` with the same name containing
    # `assert n == len(_pins())` — a tautology — and this guard went on inspecting the first
    # while pytest collected and ran the second. Requiring uniqueness is the whole fix, and
    # it is the same discipline `frozen` and the recipe's allowlist marker already have.
    floor_defs = [
        n
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == FLOOR_FN
    ]
    assert len(floor_defs) == 1, (
        f"`{FLOOR_FN}` is defined {len(floor_defs)} time(s). It is the anti-deletion floor "
        "`derived-guards.md` §4 calls for; renaming it out of collection retires it "
        "silently, and DEFINING IT TWICE lets this guard inspect the first while pytest "
        "runs the second."
    )
    floor_fn = floor_defs[0]

    # ── IT MUST RUN, NOT MERELY BE WRITTEN ────────────────────────────────────────
    #
    # Every previous version of this guard verified the floor's SOURCE. A blind audit
    # therefore left the source alone and stopped it EXECUTING, five ways, each leaving this
    # guard green: `@pytest.mark.skip`, `@pytest.mark.xfail`, any decorator that replaces
    # the function, a `def` under `if not __debug__:`, and a `globals()[...] = lambda: None`
    # at module end. `@pytest.mark.skip` is the one that matters — it is an ordinary edit,
    # and a skipped floor is precisely the vacuous green `derived-guards.md` §3 refuses
    # ("A skip is a skip, never a pass").
    assert not floor_fn.decorator_list, (
        f"`{FLOOR_FN}` carries {len(floor_fn.decorator_list)} decorator(s). A `skip`, an "
        "`xfail`, or anything that wraps the function stops the floor RUNNING while leaving "
        "it written — and this guard used to read only what was written."
    )
    # …and the name this module actually binds at run time is the very `def` inspected
    # above. This is what catches the conditional-def and `globals()` substitutions, which
    # no amount of AST reading can see.
    _bound = __import__("sys").modules[__name__].__dict__.get(FLOOR_FN)
    assert callable(_bound) and _bound.__code__.co_firstlineno == floor_fn.lineno, (
        f"the `{FLOOR_FN}` this module binds at run time is not the `def` at line "
        f"{floor_fn.lineno} that this guard inspected. The floor was replaced or "
        "conditionally defined, so everything asserted about its source is about a function "
        "pytest does not run."
    )
    frozen_assigns = [
        n
        for n in ast.walk(floor_fn)
        if isinstance(n, (ast.Assign, ast.AnnAssign))
        for tgt in (n.targets if isinstance(n, ast.Assign) else [n.target])
        if isinstance(tgt, ast.Name) and tgt.id == "frozen"
    ]
    assert len(frozen_assigns) == 1, (
        f"`{FLOOR_FN}` must contain exactly ONE assignment to `frozen`; the AST found "
        f"{len(frozen_assigns)}. A second one shadows the first, so the literal can stay in "
        "the file while the floor compares against a derived value — which is the exact "
        "move INV-5 forbids, and it kept the previous version of this test green."
    )
    value = frozen_assigns[0].value
    assert isinstance(value, ast.Constant) and value.value == 18, (
        f"the per-recipe pin floor must be the integer LITERAL 18; the AST found "
        f"{ast.dump(value)}. Read from the exported parse it would move with the pin file, "
        "and a deleted pin would take the floor down with it — silently."
    )

    # …and the floor's own comparison names it. Without this, `frozen` could be a literal
    # that nothing compares against while the real assertion used something else.
    floor_cmps = [
        n
        for n in ast.walk(floor_fn)
        if isinstance(n, ast.Compare)
        and isinstance(n.left, ast.Name)
        and n.left.id == "n"
        and any(isinstance(c, ast.Name) and c.id == "frozen" for c in n.comparators)
    ]
    assert floor_cmps, (
        "no comparison of the measured pin count `n` against `frozen` was found. The "
        "literal exists but nothing uses it, which is a floor in name only."
    )
    # …and EVERY comparison of `n` in that function must be against `frozen`. Requiring only
    # that ONE exists let a blind audit park `assert n >= frozen` under `if False:` and make
    # the live floor `n == len(_pins())` — a tautology, with the literal still present and
    # still compared. Same move as the dead-helper defeat, relocated inside the function.
    # `n` MUST BE THE MEASURED COUNT. Nothing previously required it, so a blind audit
    # wrote `n = frozen` (making `n == frozen` and `n >= frozen` tautologies) and put the
    # live floor in `m = len(_pins()); assert m == len(_pins())` — a comparison whose left
    # is not `n`, and therefore unexamined. Binding the guard to the right-hand side of the
    # `n` assignment closes both that and its variants.
    # `AnnAssign` too: `n: int = len(_pins())` is an ordinary, correct spelling that the
    # first cut reported as "assigns `n` 0 time(s)" — a false red with a false message.
    n_assigns = [
        node
        for node in ast.walk(floor_fn)
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(tg, ast.Name) and tg.id == "n" for tg in node.targets)
        )
        or (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "n"
            and node.value is not None
        )
    ]
    assert len(n_assigns) == 1, (
        f"`{FLOOR_FN}` assigns `n` {len(n_assigns)} time(s); it must be measured exactly once"
    )
    # STRUCTURAL, not a substring over `ast.dump`. The dump form accepted any expression
    # that MENTIONED `len(_pins())` anywhere — `n = frozen if len(_pins()) else frozen` and
    # `n = [len(_pins())] and frozen` both bound `n` to `frozen`, making every comparison a
    # tautology, while satisfying a text search over the dump. Demonstrated.
    v = n_assigns[0].value
    ok = (
        isinstance(v, ast.Call)
        and isinstance(v.func, ast.Name)
        and v.func.id == "len"
        and len(v.args) == 1
        and isinstance(v.args[0], ast.Call)
        and isinstance(v.args[0].func, ast.Name)
        and v.args[0].func.id == "_pins"
    )
    assert ok, (
        f"`n` in `{FLOOR_FN}` is not exactly `len(_pins())` — it is {ast.dump(v)}. If `n` "
        "is not the MEASURED pin count, comparing it to `frozen` compares two constants and "
        "the floor is a tautology."
    )
    # …and EVERY comparison in the function must involve `frozen`, not just the ones whose
    # left is `n`. A comparison over some other name is how the live floor gets moved out
    # from under this check.
    n_cmps = [
        c
        for c in ast.walk(floor_fn)
        if isinstance(c, ast.Compare)
    ]
    for c in n_cmps:
        # EITHER SIDE. `assert frozen <= n` is the same floor written the other way round,
        # and the first cut reported it as "the measured count `n` is compared against
        # something other than `frozen`" — a false message on a false red, in a guard whose
        # sibling module's prose says a guard red on correct code is one people delete.
        involves_frozen = any(
            isinstance(x, ast.Name) and x.id == "frozen" for x in [c.left, *c.comparators]
        )
        assert involves_frozen, (
            f"line {c.lineno}: a comparison in `{FLOOR_FN}` does not involve `frozen`. If "
            "it is the floor, it is a derivation reading the same source as the thing it "
            "checks — blind to a deletion, which is the ONE direction the floor exists for. "
            "If it is unrelated, move it out: an unrelated comparison beside the floor is "
            "how the floor stops being the thing this guard is reading."
        )

    # (3) the named case table is the FULL frozen set of string literals, on the test that
    #     consumes it — not merely a `parametrize` of four names somewhere in the file.
    WANT = {"scDblFinder", "BiocParallel", "Matrix", "jsonlite"}
    # EXACTLY ONE, for the same reason as the floor above: `next()` reads the first, Python
    # runs the last.
    targets = [
        n
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        and n.name == "test_the_minimum_pin_set_the_issue_names_is_exactly_pinned"
    ]
    assert len(targets) == 1, (
        f"the named minimum-pin-set test is defined {len(targets)} time(s); a second "
        "definition retires the first while this guard still inspects it"
    )
    target = targets[0]
    # (The `assert target is not None` that stood here could never fire after the
    #  `len(targets) == 1` above — the `next(..., None)` it replaced made it meaningful and
    #  the list form does not. Removed rather than kept as decoration, which is what this
    #  same function says twenty lines up about a different dead assertion.)
    tables = [
        {e.value for e in dec.args[1].elts}
        for dec in target.decorator_list
        if isinstance(dec, ast.Call)
        and getattr(dec.func, "attr", None) == "parametrize"
        and len(dec.args) == 2
        and isinstance(dec.args[0], ast.Constant)
        and dec.args[0].value == "named"
        and isinstance(dec.args[1], ast.List)
        and all(isinstance(e, ast.Constant) for e in dec.args[1].elts)
    ]
    assert tables == [WANT], (
        f"the named minimum pin set must be exactly {sorted(WANT)} as string LITERALS on "
        f"`test_the_minimum_pin_set_the_issue_names_is_exactly_pinned`; the AST found "
        f"{[sorted(x) for x in tables]}. Deriving it from the artefact would make it a "
        "tautology (deleting scDblFinder would delete the case that checks for it), and "
        "shrinking it silently retires the packages this env exists to provide."
    )


def test_the_shipped_pin_file_is_canonical_in_the_python_lane_too():
    """S11 (#214 audit) — the precondition still runs in the lane that does NOT build.

    `_pins()` used to call `pin_file_canon.assert_canonical` on every use. It no longer
    parses, so it no longer needs to — but a blind audit pointed out that this narrowed the
    check to the cargo lane, and `just check-py` never runs cargo. The precondition is
    cheap; asserting it here keeps the python lane able to say for itself that the shipped
    bytes are ones both remaining parsers read identically.
    """
    pin_file_canon.assert_canonical(_R_PINS)
    pin_file_canon.assert_canonical(_ENV_ROOT / "single-cell" / "requirements.txt")


def test_every_pin_carries_its_import_token():
    """S12 (#214 audit) — restored after the conversion narrowed it.

    `_PIN_RE` required `# import=<library>` on every line and named the failing line. The
    generator now refuses a recipe whose pins do not all carry one, so this is
    gate-enforced — but that made it invisible in the python lane, and the token is what the
    smoke-correspondence guard is keyed on. Asserting it from the artefact costs nothing and
    keeps the claim visible where the R recipe's other properties are asserted.
    """
    for name, _version, lib in _pins():
        assert lib, f"`{name}` has no `# import=<library>` token in the exported parse"
        assert lib.replace("_", "").replace(".", "").isalnum(), (
            f"`{name}`'s import token {lib!r} is not a plain module name"
        )


def test_this_module_has_no_pin_file_grammar_left():
    """TEST-P12's static half, added after a blind audit pointed out the sibling had one and
    this module — which used to carry THREE grammars — did not.

    This module still legitimately splits the DOCKERFILE and some Rust source, so the rule is
    **conjunctive**: a function may split, and a function may name the pin file, but not
    both. That differs from `test_rootfs_deps.py`, whose ban is unconditional with a named
    EXEMPT list — and the difference is stated rather than glossed, because the first version
    of this docstring claimed the sibling's shape and a blind audit measured that it did not
    have it.

    Conjunctive is the weaker form and it is chosen deliberately here: this module names the
    R recipe DIRECTORY in a dozen places to reach the Dockerfile, so an unconditional ban
    with an exemption list would be a list of a dozen names, each of which would then have to
    be re-examined whenever one grew. The cost is that a function which splits WITHOUT
    naming the pin file is invisible; the covering guard for that is the behavioural
    residual-read detector next door, which does not care how the read is spelled.

    See `test_rootfs_deps.py` for why the ban covers `re.*` and `open()` as well as the
    splitter methods.
    """
    import ast

    #: Names that resolve to a PIN FILE, not to the recipe DIRECTORY. `_R_ENV`/`_ENV_ROOT`
    #: are deliberately absent: several tests here compose the DOCKERFILE's path from them
    #: and then legitimately split it, and flagging those would make this red on correct
    #: code — which teaches people to delete guards. The literal `"requirements.txt"` is in
    #: the set instead, so composing the pin file's path from a directory name is still
    #: caught however it is spelled.
    PIN_NAMES = {"_R_PINS", "_PINS"}
    #: …and every SPELLING of the pin file's own name. `env_pins.PIN_FILE_NAME` is the one
    #: this branch itself introduced, and a blind audit used it to inject a complete FOURTH
    #: grammar into this module — `(_R_ENV / env_pins.PIN_FILE_NAME).read_text()` plus
    #: `splitlines`, `startswith("#")` and `split("==")` — with every gate green. The
    #: docstring claimed the path was "caught however it is spelled"; it was caught only
    #: when spelled as a literal.
    PIN_ATTRS = {"PIN_FILE_NAME", "DEFAULT_ENV_ROOT", "ENV_PIN_FILE"}
    BANNED = {"splitlines", "partition", "rpartition", "split", "rsplit"}
    BANNED_CALLS = {
        "findall", "search", "match", "finditer", "fullmatch", "compile",
        "open", "readlines", "readline", "getattr", "glob", "iglob",
    }
    #: `readlines`/`readline` are file-object line rules with no `.split` in sight;
    #: `getattr` is indirect dispatch, which defeats any name-based ban by construction.
    #: Both were smuggled past the previous cut by a blind audit.
    #:
    #: **The honest limit, stated because a fifth predicate is not the answer.** A ban over
    #: names has unbounded evasion space: `getattr(m, "spl" + "it")`, a helper in another
    #: module, `exec`. This is a TRIPWIRE for the accidental reintroduction of a grammar —
    #: which is how all ten of the original parsers actually arrived — not a barrier against
    #: an author who wants one. The barrier is the behavioural residual-read detector next
    #: door, which does not care how the read is spelled because it asks what the consumer
    #: ANSWERS. `docs/design/pin-file-single-parse.md` §5 and the lifecycle's GUARD-SUB rule
    #: both say the same thing: when a predicate keeps being defeated, replace it with a
    #: test of the behaviour it stands in for.

    def hits(node):
        out = []
        for c in ast.walk(node):
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute):
                if c.func.attr in BANNED:
                    out.append((c.lineno, f".{c.func.attr}()"))
                elif c.func.attr in BANNED_CALLS:
                    out.append((c.lineno, f".{c.func.attr}()"))
            elif isinstance(c, ast.Call) and isinstance(c.func, ast.Name):
                if c.func.id in BANNED_CALLS:
                    out.append((c.lineno, f"{c.func.id}()"))
        return out

    def names_the_pin_file(node):
        return any(
            (isinstance(c, ast.Name) and c.id in PIN_NAMES)
            or (isinstance(c, ast.Constant) and c.value == "requirements.txt")
            or (isinstance(c, ast.Attribute) and c.attr in PIN_ATTRS)
            or (isinstance(c, ast.Name) and c.id in PIN_ATTRS)
            for c in ast.walk(node)
        )

    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
    offences, splitting_fns = [], set()
    # `AsyncFunctionDef` too: a blind audit smuggled a reader past the first cut as an
    # `async def`, which `isinstance(n, ast.FunctionDef)` does not match.
    FN = (ast.FunctionDef, ast.AsyncFunctionDef)
    for fn in [n for n in ast.walk(tree) if isinstance(n, FN)]:
        h = hits(fn)
        if not h:
            continue
        if names_the_pin_file(fn):
            offences += [f"{fn.name}:{ln} {m}" for ln, m in h]
        else:
            splitting_fns.add(fn.name)
    # MODULE LEVEL, which the first cut did not walk at all — a blind audit put
    # `_M_LINES = _R_PINS.read_text().splitlines()` at module scope and it was invisible.
    for node in tree.body:
        if isinstance(node, FN):
            continue
        if hits(node) and names_the_pin_file(node):
            offences += [f"<module>:{ln} {m}" for ln, m in hits(node)]

    assert not offences, (
        f"a text-splitting or pattern-matching call sits in a function that also names the "
        f"pin file: {offences}. Pin data must come from the exported parse "
        "(`_lib/env_pins.py`) — docs/design/pin-file-single-parse.md. A function whose "
        "subject is the DOCKERFILE or Rust source may split freely; it just may not do both."
    )
    # ANTI-VACUITY + POSITIVE CONTROL: the walk sees this module, and the predicate can fire.
    assert splitting_fns, "no function in this module splits anything — the walk is not seeing it"
    probe = ast.parse(
        "def bad():\n"
        "    return _R_PINS.read_text().splitlines()\n"
        "def alsobad():\n"
        "    return re.findall('x', _R_PINS.read_text(), re.M)\n"
        "def composed():\n"
        "    return (_ENV_ROOT / 'single-cell-r' / 'requirements.txt').read_text().split()\n"
        "def via_the_constant():\n"
        "    return (_R_ENV / env_pins.PIN_FILE_NAME).read_text().splitlines()\n"
        "async def asynchronously():\n"
        "    return _R_PINS.read_text().splitlines()\n"
    )
    FNP = (ast.FunctionDef, ast.AsyncFunctionDef)
    for fn in [n for n in ast.walk(probe) if isinstance(n, FNP)]:
        assert hits(fn) and names_the_pin_file(fn), (
            f"the predicate did not flag the known-bad shape `{fn.name}` — its silence on "
            "this module means nothing. `via_the_constant` is the one a blind audit used to "
            "inject a complete fourth grammar past the first cut, spelling the path with "
            "`env_pins.PIN_FILE_NAME` instead of a literal."
        )
