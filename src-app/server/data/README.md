# Data files — generated, do not edit

Files in this directory are **generated data**, not source:

| file | what it is | produced by |
|---|---|---|
| `method-env-images.json` | the per-method environment layer manifest (one entry per runnable benchmark method, per published arch) | `scripts/generate-method-env-images.py` |
| `method-env-images.schema.json` | the JSON Schema (draft-07) the manifest validates against | maintained with this directory; versioned by `schema_version` |

Editing `method-env-images.json` by hand is a guard failure, not a review
step: `scripts/check-method-env-images.sh` re-validates the committed file
(schema conformance, id grammar, digest/sha256 formats, size, arch, address
checks, uniqueness, ordering), regen-parity-checks it against the staged build
records (the whole list, or entry by entry against the previous list), and,
with the methods repository, checks every entry's facts at the entry's own
commit. To change the manifest, rebuild the method (or methods) and assemble
the list again; to change the entry shape, bump `schema_version` with the
schema in the same change.

Schema 2: every entry records the methods-repository commit its layer was
built from (`source_revision`), the git tree of its method folder at that
commit (`source_tree`) and the generator that built it (`generator_version`);
one list holds entries built at different commits, so one method is rebuilt
and listed without rebuilding the others. Every method fact of an entry
(`method_version`, `language`, `licence`, and `contract` = the tag of the
Dockerfile's FROM base) is the method's own committed file at that commit,
never the generated `index.json`.

The manifest and schema are the contract `execution-engine`'s runtime reads
(embed via `include_dir!` or read from disk in dev builds): the runtime
fetches `oci_ref@digest`, verifies `layer_sha256` before mounting, and shows
`size_bytes` before the download starts. Every layer is in ONE package:
`oci_ref` is `ghcr.io/tinnlab/txr-method-env-layers` and the method and its
layer file are in the tag,
`<env_id>-<method_version>-<arch>-<first 12 hex of layer_sha256>` (a rebuild at
the same version is a new tag). The base each entry stacks on is the
manifest's `bases` record for its language and arch: both bases are in ONE
package, `oci_ref` `ghcr.io/tinnlab/txresbench-env`, tag
`<base_id>-<contract>-<arch>-<sha12>`; the runtime fetches it by its `tag` and
verifies `squashfs_sha256` (an entry's `base_digest` is the Docker base
image's digest, provenance only). `bases` is optional until the committed
file is regenerated with bases; the committed file has none yet (the app then
asks for `ghcr.io/tinnlab/txresbench-env:base-<family>-<contract>-<arch>`).

The committed file was converted from schema 1 (94 amd64 entries built at
methods commit `5db3b60f727d` by generator 0.2.0, no `bases`) by a mechanical
rewrite: each entry got `source_revision` `5db3b60f727d`, the git tree of its
folder there and `generator_version` `0.2.0`; the top-level `source_revision`
went away; every other value is unchanged (digests included). Three entries
were dropped because their facts do not hold at that commit:
`genotype-specific-mrd-risk` (listed 2.0.0, method.json 2.0.1),
`glmnet-elasticnet-landmark-cox` (1.0.0 vs 1.0.1) and `sklearn-rf-longitudinal`
(in no commit of the methods repository). The next regeneration replaces the
file whole.

Design reference: `docs/method-env-layer-artifacts.md` (§2.1a, §6.3, §7).

Regeneration (on the publisher's machine; the generator reads the methods
repository at build time only and never at run time):

```sh
python3 scripts/generate-method-env-images.py --check --assemble <build dir> \
  --methods-dir <methods checkout> [--previous <the previous list>]
scripts/check-method-env-images.sh --methods-dir <methods checkout>   # provenance
```

The publish runbook (`docs/runbooks/method-env-images-publish.md`) has the
one-method flow.
