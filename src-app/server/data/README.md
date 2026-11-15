# Data files — generated, do not edit

Files in this directory are **generated data**, not source:

| file | what it is | produced by |
|---|---|---|
| `method-env-images.json` | the per-method environment layer manifest (one entry per runnable benchmark method, per published arch) | `scripts/generate-method-env-images.py` |
| `method-env-images.schema.json` | the JSON Schema (draft-07) the manifest validates against | maintained with this directory; versioned by `schema_version` |

Editing `method-env-images.json` by hand is a guard failure, not a review
step: `scripts/check-method-env-images.sh` re-validates the committed file
(schema conformance, id grammar, digest/sha256 formats, size, arch, address
checks, uniqueness, ordering) and regen-parity-checks it against a fresh
generation run for the recorded `source_revision`. To change the manifest,
change the generator (or the methods repository revision it reads at build
time) and regenerate; to change the entry shape, bump `schema_version` with
the schema in the same change.

The manifest and schema are the contract `execution-engine`'s runtime reads
(embed via `include_dir!` or read from disk in dev builds): the runtime
fetches `oci_ref@digest`, verifies `layer_sha256` before mounting, and shows
`size_bytes` before the download starts. Every layer is in ONE package:
`oci_ref` is `ghcr.io/tinnlab/txr-method-env-layers` and the method is in the
tag, `<env_id>-<method_version>-<arch>`. The base each entry stacks on is the
manifest's `bases` record for its language and arch: both bases are in ONE
package, `oci_ref` `ghcr.io/tinnlab/txresbench-env`, tag
`<base_id>-<contract>-<arch>-<sha12>`; the runtime fetches it by its `tag` and
verifies `squashfs_sha256` (an entry's `base_digest` is the Docker base
image's digest, provenance only). `bases` is optional until the committed
file is regenerated with bases; the committed file has none yet (the app then
asks for `ghcr.io/tinnlab/txresbench-env:base-<family>-<contract>-<arch>`).

The committed file's `oci_ref`/`tag` were moved from the old
one-package-per-method form (`…/txr-method-env-layers/<env_id>`, tag
`<method_version>-<arch>`) by a mechanical rewrite of those two fields only:
the OCI artifact manifest bytes carry no address, so every `digest` is
unchanged, and `generator_version` still names the generator that emitted the
rest of the file. The next regeneration replaces the file whole.
Design reference: `docs/method-env-layer-artifacts.md` (§2.1a, §6.3, §7).

Regeneration (on the publisher's machine; the generator reads the methods
repository at build time only and never at run time):

```sh
python3 scripts/generate-method-env-images.py --check
```
