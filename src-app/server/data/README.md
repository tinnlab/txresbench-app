# Data files — generated, do not edit

Files in this directory are **generated data**, not source:

| file | what it is | produced by |
|---|---|---|
| `method-env-images.json` | the per-method environment layer manifest (one entry per runnable benchmark method, per published arch) | `scripts/generate-method-env-images.py` |
| `method-env-images.schema.json` | the JSON Schema (draft-07) the manifest validates against | maintained with this directory; versioned by `schema_version` |

Editing `method-env-images.json` by hand is a guard failure, not a review
step: `scripts/check-method-env-images.sh` re-validates the committed file
(schema conformance, id grammar, digest/sha256 formats, size, arch, prefix
checks, uniqueness, ordering) and regen-parity-checks it against a fresh
generation run for the recorded `source_revision`. To change the manifest,
change the generator (or the methods repository revision it reads at build
time) and regenerate; to change the entry shape, bump `schema_version` with
the schema in the same change.

The manifest and schema are the contract `execution-engine`'s runtime reads
(embed via `include_dir!` or read from disk in dev builds): the runtime
fetches `oci_ref@digest`, verifies `layer_sha256` before mounting, and shows
`size_bytes` before the download starts. Design reference:
`docs/method-env-layer-artifacts.md`.

Regeneration (on the publisher's machine; the generator reads the methods
repository at build time only and never at run time):

```sh
python3 scripts/generate-method-env-images.py --check
```
