#!/usr/bin/env bash
# Fetch-on-demand test fixtures for the datasets-management pipeline hardening
# suite (Wave-5, TEST-48..70). These are REAL public datasets (verified 10x
# single-cell / scRNA-seq), fetched into this directory and sha256-verified.
#
# NOT committed to git (they are multi-MB binaries) — a `.gitignore` in this dir
# excludes everything but `fetch.sh` + this list. A test that needs a fixture
# calls nothing; it simply checks whether the verified file is already present in
# this directory (see `fixture_path()` in the dataset test harness) and
# SELF-SKIPS with a clear log when it is absent (offline / not-fetched). Run this
# script once on a networked box to enable the real-compute + capsule tests:
#
#     bash src-app/server/tests/dataset/fixtures/fetch.sh            # fetch all
#     bash src-app/server/tests/dataset/fixtures/fetch.sh pbmc3k     # one group
#
# Idempotent: a file already present + hash-matching is left untouched.
#
# EXCEPTION — `mtx_trio/` is COMMITTED, not fetched. That minimal, valid 10x Cell
# Ranger trio (matrix.mtx.gz + barcodes.tsv.gz + features.tsv.gz, ~15 KB total) is a
# deterministic 50-cell × 100-gene subsample of the `pbmc3k_raw.h5ad` below, small
# enough to ship in git — which is what lets `mtx_trio_convert_test`'s
# convert-to-completion half RUN on every box instead of self-skipping for want of a
# fixture. Regenerate it (after fetching pbmc3k) with:
#
#     python3 src-app/server/tests/dataset/fixtures/make_mtx_trio.py
#
# The same source + defaults reproduce the committed bytes exactly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# name|url|sha256|bytes
FIXTURES=(
  "pbmc3k_raw.h5ad|https://falexwolf.de/data/pbmc3k_raw.h5ad|89a96f1beaa2dd83a687666d3f19a4513ac27a2a2d12581fcd77afed7ea653a1|5855727"
  "Sample_X_S1_L001_R1_001.fastq.gz|https://raw.githubusercontent.com/nf-core/test-datasets/scrnaseq/testdata/cellranger/Sample_X_S1_L001_R1_001.fastq.gz|a318e85709d690b25c763fb3f156fc98d0ce46360115f3de3d9b1b2ecc55a1f7|1727503"
  "Sample_X_S1_L001_R2_001.fastq.gz|https://raw.githubusercontent.com/nf-core/test-datasets/scrnaseq/testdata/cellranger/Sample_X_S1_L001_R2_001.fastq.gz|1514b26ce8e972ac7ba1860d591fa72e8c1fb6f716825651c2eb24b59c1a38d2|4259756"
  "Sample_Y_S1_L001_R1_001.fastq.gz|https://raw.githubusercontent.com/nf-core/test-datasets/scrnaseq/testdata/cellranger/Sample_Y_S1_L001_R1_001.fastq.gz|a318e85709d690b25c763fb3f156fc98d0ce46360115f3de3d9b1b2ecc55a1f7|1727503"
  "Sample_Y_S1_L001_R2_001.fastq.gz|https://raw.githubusercontent.com/nf-core/test-datasets/scrnaseq/testdata/cellranger/Sample_Y_S1_L001_R2_001.fastq.gz|1514b26ce8e972ac7ba1860d591fa72e8c1fb6f716825651c2eb24b59c1a38d2|4259756"
  "Sample_Y_S1_L002_R1_001.fastq.gz|https://raw.githubusercontent.com/nf-core/test-datasets/scrnaseq/testdata/cellranger/Sample_Y_S1_L002_R1_001.fastq.gz|f33ae3d31e78020843b78198508b130506b2e7899eb2ecc658d2640b845a1114|737653"
  "Sample_Y_S1_L002_R2_001.fastq.gz|https://raw.githubusercontent.com/nf-core/test-datasets/scrnaseq/testdata/cellranger/Sample_Y_S1_L002_R2_001.fastq.gz|6270bd60af5341463fd425079cfc067990221dfe78437880240b5894fa30477f|1981608"
)

want_group="${1:-all}"

verify() { # path sha256
  local got
  got="$(sha256sum "$1" | cut -d' ' -f1)"
  [ "$got" = "$2" ]
}

group_of() { # filename -> group
  case "$1" in
    pbmc3k_raw.h5ad) echo pbmc3k ;;
    *.fastq.gz)      echo fastq ;;
    *)               echo other ;;
  esac
}

for entry in "${FIXTURES[@]}"; do
  IFS='|' read -r name url sha bytes <<<"$entry"
  grp="$(group_of "$name")"
  if [ "$want_group" != "all" ] && [ "$want_group" != "$grp" ]; then
    continue
  fi
  dest="$DIR/$name"
  if [ -f "$dest" ] && verify "$dest" "$sha"; then
    echo "ok (cached): $name"
    continue
  fi
  echo "fetching: $name ($bytes bytes) <- $url"
  if ! curl -sSL --fail --max-time 120 -o "$dest.part" "$url"; then
    echo "FETCH FAILED (offline?): $name — skipping" >&2
    rm -f "$dest.part"
    continue
  fi
  if verify "$dest.part" "$sha"; then
    mv "$dest.part" "$dest"
    echo "verified: $name"
  else
    echo "SHA256 MISMATCH: $name (expected $sha, got $(sha256sum "$dest.part" | cut -d' ' -f1))" >&2
    rm -f "$dest.part"
    exit 1
  fi
done
echo "done."
