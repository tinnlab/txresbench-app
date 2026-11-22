# Method list test fixtures

Synthetic data for the method list's tests (the Rust unit tests in
`src-app/server/src/modules/method_list/` and the `scripts/*-method-list.test.mjs`
controls). Rebuilt by `make-fixtures.sh` (not run by the gate; it needs minisign, or
Docker to run minisign in a throwaway container). ed25519 signatures are deterministic,
so a rebuild with the same key gives the same bytes.

| file | what |
|---|---|
| `list-dir/catalogue.json` | the catalogue generator's fixture output (`scripts/method-catalogue/gen_method_catalogue.py --fixtures`): 5 synthetic methods with the `disease`/`treatment` facts and a `filter_options` block (the generator's own schema-2 fixtures) |
| `list-dir/method-env-images.json` | a synthetic schema 2 images list: 2 of those methods on amd64 and both bases (fake hashes) |
| `list-dir/method-list.json` | the two assembled with `--first` (sequence 1, format 2) at `SOURCE_DATE_EPOCH=1767225600` |
| `list-dir/method-list.json.minisig` | its signature by the test key, trusted comment `txresbench-method-list format=2 sequence=1` |
| `signatures/legacy.minisig` | the same comment, legacy (not prehashed) signature: refused |
| `signatures/wrong-purpose.minisig` | a valid signature whose comment is not a method list's: refused |
| `signatures/sequence-2.minisig` | a valid signature saying `sequence=2` over the sequence 1 body: refused at parse |
| `test-key.pub`, `test-key.key` | the TEST key pair (the secret key is unencrypted and public on purpose) |
| `fixture-keys.json` | the test key in the trusted-keys format, for `--keys` and the tests |

The test key is **never** trusted by the app: `scripts/check-method-list.sh` (app mode, in
the gate) and the Rust test `release_keys_exclude_fixture_key` fail if it appears in
`data/method-list/trusted-keys.json`. Real keys are made by each publishing maintainer
with `minisign -G` on their own machine; no one else holds their secret key.
